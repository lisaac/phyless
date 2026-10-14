// Package debugshell opens a terminal for containers that have no shell
// (distroless, scratch): a throwaway busybox container joins the target's PID
// and network namespaces, and the target's filesystem is reached through
// /proc/<pid>/root. The target itself is never modified.
package debugshell

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"io"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"

	"phyless/backend/internal/docker/self"
)

// Static busybox from Alpine's busybox-static; refresh with scripts/fetch-busybox.sh.
//
//go:embed busybox-amd64 busybox-arm64
var bins embed.FS

const Role = "debug"

// Docker reports the kernel's name for the daemon's architecture.
var archs = map[string]string{"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}

// Start creates the debug container for target and attaches to its shell.
// The shell is the container's only process and stdin is StdinOnce, so
// closing resp (or phyless dying) ends the shell and AutoRemove deletes the
// container — nothing is left behind.
func Start(ctx context.Context, cli client.APIClient, target string) (string, types.HijackedResponse, error) {
	var none types.HijackedResponse
	t, err := cli.ContainerInspect(ctx, target)
	if err != nil {
		return "", none, err
	}
	if t.State == nil || !t.State.Running || t.State.Paused {
		return "", none, fmt.Errorf("容器未运行，无法进入调试模式")
	}
	ref, err := ensureImage(ctx, cli)
	if err != nil {
		return "", none, err
	}
	// Sharing the target's PID namespace makes its main process PID 1 — unless
	// the target itself uses the host's, where it keeps its host PID.
	// ponytail: pid=container:<other> targets land on <other>'s root; resolve
	// via /proc scan if that ever matters.
	root := "/proc/1/root"
	if t.HostConfig != nil && t.HostConfig.PidMode.IsHost() {
		root = fmt.Sprintf("/proc/%d/root", t.State.Pid)
	}
	script := `/bin/busybox --install -s /bin
printf '\033[33m[phyless] 容器内没有 shell，已进入调试模式：busybox 调试容器共享目标的进程与网络命名空间\n目标文件系统位于 %s\033[0m\n' "$ROOT"
cd "$ROOT" 2>/dev/null || echo "无法进入 $ROOT"
exec sh`
	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image:     ref,
		Cmd:       []string{"/bin/busybox", "sh", "-c", script},
		Env:       []string{"ROOT=" + root, "PATH=/bin", "TERM=xterm-256color"},
		Tty:       true,
		OpenStdin: true, StdinOnce: true,
		AttachStdin: true, AttachStdout: true, AttachStderr: true,
		Labels: map[string]string{self.RoleLabel: Role},
	}, &container.HostConfig{
		AutoRemove:  true,
		PidMode:     container.PidMode("container:" + t.ID),
		NetworkMode: container.NetworkMode("container:" + t.ID),
		// Reading /proc/<pid>/root of a process owned by another uid.
		CapAdd: []string{"SYS_PTRACE"},
	}, nil, nil, "")
	if err != nil {
		return "", none, fmt.Errorf("创建调试容器失败: %w", err)
	}
	cleanup := func() {
		_ = cli.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true})
	}
	// Attach before start, like `docker run -it`, so no output is lost.
	hj, err := cli.ContainerAttach(ctx, resp.ID, container.AttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		cleanup()
		return "", none, err
	}
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		hj.Close()
		cleanup()
		return "", none, fmt.Errorf("启动调试容器失败: %w", err)
	}
	return resp.ID, hj, nil
}

// ensureImage imports the embedded busybox for the daemon's architecture as a
// local image — no registry, works offline and against remote daemons.
func ensureImage(ctx context.Context, cli client.APIClient) (string, error) {
	info, err := cli.Info(ctx)
	if err != nil {
		return "", err
	}
	arch := archs[info.Architecture]
	if arch == "" {
		return "", fmt.Errorf("调试模式不支持 %s 架构", info.Architecture)
	}
	bin, err := bins.ReadFile("busybox-" + arch)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bin)
	ref := fmt.Sprintf("phyless-debug:%s-%x", arch, sum[:6])
	if _, err := cli.ImageInspect(ctx, ref); err == nil {
		return ref, nil
	} else if !errdefs.IsNotFound(err) {
		return "", err
	}
	rootfs, err := rootfsTar(bin)
	if err != nil {
		return "", err
	}
	rc, err := cli.ImageImport(ctx, image.ImportSource{Source: bytes.NewReader(rootfs), SourceName: "-"}, ref,
		image.ImportOptions{Platform: "linux/" + arch, Changes: []string{"LABEL " + self.RoleLabel + "=" + Role}})
	if err != nil {
		return "", fmt.Errorf("导入调试镜像失败: %w", err)
	}
	_, _ = io.Copy(io.Discard, rc)
	rc.Close()
	// Import reports failures inside the JSON stream; the tag is the truth.
	if _, err := cli.ImageInspect(ctx, ref); err != nil {
		return "", fmt.Errorf("导入调试镜像失败: %w", err)
	}
	return ref, nil
}

func rootfsTar(bin []byte) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range []*tar.Header{
		{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "tmp/", Typeflag: tar.TypeDir, Mode: 0o1777},
		{Name: "bin/busybox", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(bin))},
	} {
		if err := tw.WriteHeader(h); err != nil {
			return nil, err
		}
	}
	if _, err := tw.Write(bin); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
