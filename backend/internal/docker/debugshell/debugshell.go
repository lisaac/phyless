// Package debugshell serves containers that lack a shell or ls (distroless,
// scratch) from throwaway busybox containers: a terminal joining the target's
// PID and network namespaces (its filesystem via /proc/<pid>/root), and
// one-shot directory listings. The target itself is never modified.
package debugshell

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"io"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"

	ctr "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/self"
)

// Static busybox from Alpine's busybox-static; refresh with scripts/fetch-busybox.sh.
//
//go:embed busybox-amd64 busybox-arm64
var bins embed.FS

const Role = "debug"

// Daemon architecture (GOARCH, as /version reports it) → embedded binary.
var archs = map[string]string{"amd64": "amd64", "arm64": "arm64"}

// listTimeout bounds a one-shot listing: ls on a hung mount must not pin a
// container and a goroutine forever.
const listTimeout = 30 * time.Second

// archCache keeps each daemon's architecture so the hot path costs no extra
// round trip. ponytail: one entry per Docker client, never evicted; clients
// are only recreated on server switches.
var archCache sync.Map

// Start creates the debug container for target and attaches to its shell.
// The shell is the container's only process and stdin is StdinOnce, so
// closing resp (or phyless dying) ends the shell and AutoRemove deletes the
// container — nothing is left behind.
func Start(ctx context.Context, cli client.APIClient, target string) (string, types.HijackedResponse, error) {
	t, err := cli.ContainerInspect(ctx, target)
	if err != nil {
		return "", types.HijackedResponse{}, err
	}
	if t.ContainerJSONBase == nil || t.State == nil || !t.State.Running || t.State.Paused {
		return "", types.HijackedResponse{}, fmt.Errorf("容器未运行，无法进入调试模式")
	}
	script := `/bin/busybox --install -s /bin
printf '\033[33m[phyless] 容器内没有 shell，已进入调试模式：busybox 调试容器共享目标的进程与网络命名空间\n目标文件系统位于 %s\033[0m\n' "$ROOT"
cd "$ROOT" 2>/dev/null || echo "无法进入 $ROOT"
exec sh`
	return launch(ctx, cli, &container.Config{
		Cmd:       []string{"/bin/busybox", "sh", "-c", script},
		Env:       []string{"ROOT=" + targetRoot(t), "PATH=/bin", "TERM=xterm-256color"},
		Tty:       true,
		OpenStdin: true, StdinOnce: true, AttachStdin: true,
	}, &container.HostConfig{
		PidMode:     container.PidMode("container:" + t.ID),
		NetworkMode: container.NetworkMode("container:" + t.ID),
		// Reading /proc/<pid>/root of a process owned by another uid.
		CapAdd: []string{"SYS_PTRACE"},
	}, nil)
}

// targetRoot is the target's filesystem as seen from a container sharing its
// PID namespace: its main process is PID 1 there — unless the target uses the
// host's namespace, where it keeps its host PID.
// ponytail: pid=container:<other> targets land on <other>'s root; resolve via
// a /proc scan if that ever matters.
func targetRoot(t container.InspectResponse) string {
	if t.HostConfig != nil && t.HostConfig.PidMode.IsHost() {
		return fmt.Sprintf("/proc/%d/root", t.State.Pid)
	}
	return "/proc/1/root"
}

// ListDir lists p inside t without needing ls in t: a one-shot busybox
// container either joins a running t's PID namespace (live view, mounts
// included) or, for a stopped t, mounts its volumes read-only via VolumesFrom
// — callers use it there only for paths under t's mounts.
// ponytail: one container per listing (~0.5s); keep a per-target helper alive
// if navigation latency matters.
func ListDir(ctx context.Context, cli client.APIClient, t container.InspectResponse, p string) ([]ctr.FileEntry, error) {
	if t.ContainerJSONBase == nil || t.State == nil {
		return nil, fmt.Errorf("容器状态未知")
	}
	p = path.Clean("/" + p)
	hc := &container.HostConfig{VolumesFrom: []string{t.ID + ":ro"}}
	if t.State.Running {
		// Absolute symlinks inside the target resolve against the helper's root.
		hc = &container.HostConfig{PidMode: container.PidMode("container:" + t.ID), CapAdd: []string{"SYS_PTRACE"}}
		p = targetRoot(t) + p
	}
	out, err := run(ctx, cli, hc, "/bin/busybox", "ls", "-la", "--", p)
	if err != nil {
		return nil, err
	}
	return ctr.ParseLs(out)
}

// run executes cmd in a throwaway debug container and returns its stdout.
func run(ctx context.Context, cli client.APIClient, hc *container.HostConfig, cmd ...string) (io.Reader, error) {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	var waitC <-chan container.WaitResponse
	var waitErr <-chan error
	id, hj, err := launch(ctx, cli, &container.Config{Cmd: cmd, Env: []string{"PATH=/bin", "LANG=C", "LC_ALL=C"}}, hc,
		// Registered before start, or a fast exit+remove races it.
		func(id string) { waitC, waitErr = cli.ContainerWait(ctx, id, container.WaitConditionRemoved) })
	if err != nil {
		return nil, err
	}
	defer hj.Close()
	stop := context.AfterFunc(ctx, hj.Close) // unblocks the read below on timeout/disconnect
	defer stop()
	var stdout, stderr ctr.LsBuffer
	_, err = stdcopy.StdCopy(&stdout, &stderr, hj.Reader)
	if err == nil {
		select {
		case st := <-waitC:
			// ls exits 1 when some entries are unreadable but still lists the rest.
			if st.StatusCode != 0 && stdout.Len() == 0 {
				msg := strings.TrimSpace(stderr.String())
				if msg == "" {
					msg = fmt.Sprintf("exit status %d", st.StatusCode)
				}
				return nil, fmt.Errorf("%s", msg)
			}
			return &stdout, nil
		case err = <-waitErr:
		}
	}
	// Still running (timeout, oversized output, broken stream): AutoRemove
	// only fires on exit, so kill it here.
	_ = cli.ContainerRemove(context.WithoutCancel(ctx), id, container.RemoveOptions{Force: true})
	if ctx.Err() != nil {
		return nil, fmt.Errorf("列目录超时或已取消: %w", ctx.Err())
	}
	return nil, err
}

// launch creates a labelled, auto-removed debug container, attaches to it and
// starts it — attach first, like `docker run -it`, so no output is lost.
// beforeStart, if set, runs between attach and start.
func launch(ctx context.Context, cli client.APIClient, cfg *container.Config, hc *container.HostConfig, beforeStart func(id string)) (string, types.HijackedResponse, error) {
	var none types.HijackedResponse
	cfg.AttachStdout, cfg.AttachStderr = true, true
	cfg.Labels = map[string]string{self.RoleLabel: Role}
	hc.AutoRemove = true // a crash mid-session leaves nothing behind
	resp, err := create(ctx, cli, cfg, hc)
	if err != nil {
		return "", none, fmt.Errorf("创建调试容器失败: %w", err)
	}
	cleanup := func() {
		_ = cli.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true})
	}
	hj, err := cli.ContainerAttach(ctx, resp.ID, container.AttachOptions{Stream: true, Stdin: cfg.OpenStdin, Stdout: true, Stderr: true})
	if err != nil {
		cleanup()
		return "", none, err
	}
	if beforeStart != nil {
		beforeStart(resp.ID)
	}
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		hj.Close()
		cleanup()
		return "", none, fmt.Errorf("启动调试容器失败: %w", err)
	}
	return resp.ID, hj, nil
}

// create runs ContainerCreate on the debug image, importing it on first use
// (or after someone deleted it) — the hot path costs no extra round trip.
func create(ctx context.Context, cli client.APIClient, cfg *container.Config, hc *container.HostConfig) (container.CreateResponse, error) {
	arch, err := daemonArch(ctx, cli)
	if err != nil {
		return container.CreateResponse{}, err
	}
	bin, err := bins.ReadFile("busybox-" + arch)
	if err != nil {
		return container.CreateResponse{}, err
	}
	sum := sha256.Sum256(bin)
	cfg.Image = fmt.Sprintf("phyless-debug:%s-%x", arch, sum[:6])
	resp, err := cli.ContainerCreate(ctx, cfg, hc, nil, nil, "")
	if !errdefs.IsNotFound(err) {
		return resp, err
	}
	// NotFound may also be the target (pid=container:<gone>); only import when
	// the image is what's missing.
	if _, inspectErr := cli.ImageInspect(ctx, cfg.Image); !errdefs.IsNotFound(inspectErr) {
		return resp, err
	}
	if err := importImage(ctx, cli, arch, cfg.Image, bin); err != nil {
		return container.CreateResponse{}, err
	}
	return cli.ContainerCreate(ctx, cfg, hc, nil, nil, "")
}

func daemonArch(ctx context.Context, cli client.APIClient) (string, error) {
	if a, ok := archCache.Load(cli); ok {
		return a.(string), nil
	}
	v, err := cli.ServerVersion(ctx)
	if err != nil {
		return "", err
	}
	arch := archs[v.Arch]
	if arch == "" {
		return "", fmt.Errorf("调试模式不支持 %s 架构", v.Arch)
	}
	archCache.Store(cli, arch)
	return arch, nil
}

// importImage turns the embedded busybox into a local image — no registry,
// works offline and against remote daemons.
func importImage(ctx context.Context, cli client.APIClient, arch, ref string, bin []byte) error {
	rootfs, err := rootfsTar(bin)
	if err != nil {
		return err
	}
	rc, err := cli.ImageImport(ctx, image.ImportSource{Source: bytes.NewReader(rootfs), SourceName: "-"}, ref,
		image.ImportOptions{Platform: "linux/" + arch, Changes: []string{"LABEL " + self.RoleLabel + "=" + Role}})
	if err != nil {
		return fmt.Errorf("导入调试镜像失败: %w", err)
	}
	_, _ = io.Copy(io.Discard, rc)
	rc.Close()
	// Import reports failures inside the JSON stream; the tag is the truth.
	if _, err := cli.ImageInspect(ctx, ref); err != nil {
		return fmt.Errorf("导入调试镜像失败: %w", err)
	}
	return nil
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
