// Package debugshell serves containers and images that lack a shell or ls
// (distroless, scratch) from throwaway busybox containers: a terminal joining
// a target's PID and network namespaces, and a pool of browse containers for
// directory listings. Targets themselves are never modified.
package debugshell

import (
	"context"
	"fmt"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"

	"phyless/backend/internal/docker"
)

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
	if t.ContainerJSONBase == nil || t.State == nil || !t.State.Running || t.State.Paused {
		return "", none, fmt.Errorf("容器未运行，无法进入调试模式")
	}
	script := `/bin/busybox --install -s /bin
printf '\033[33m[phyless] 容器内没有 shell，已进入调试模式：busybox 调试容器共享目标的进程与网络命名空间\n目标文件系统位于 %s\033[0m\n' "$ROOT"
cd "$ROOT" 2>/dev/null || echo "无法进入 $ROOT"
exec sh`
	cfg := &container.Config{
		Cmd:       []string{"/bin/busybox", "sh", "-c", script},
		Env:       []string{"ROOT=" + TargetRoot(t), "PATH=/bin", "TERM=xterm-256color"},
		Tty:       true,
		OpenStdin: true, StdinOnce: true,
		AttachStdin: true, AttachStdout: true, AttachStderr: true,
		Labels: map[string]string{docker.RoleLabel: Role},
	}
	hc := &container.HostConfig{
		AutoRemove:  true, // a crash mid-session leaves nothing behind
		PidMode:     container.PidMode("container:" + t.ID),
		NetworkMode: container.NetworkMode("container:" + t.ID),
		// Reading /proc/<pid>/root of a process owned by another uid.
		CapAdd: []string{"SYS_PTRACE"},
	}
	resp, err := createDebug(ctx, cli, HelperName("shell", t.Name), cfg, hc)
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

// TargetRoot is t's filesystem as seen from a container sharing its PID
// namespace: its main process is PID 1 there — unless t uses the host's
// namespace, where it keeps its host PID.
// ponytail: pid=container:<other> targets land on <other>'s root; resolve via
// a /proc scan if that ever matters.
func TargetRoot(t container.InspectResponse) string {
	if t.HostConfig != nil && t.HostConfig.PidMode.IsHost() {
		return fmt.Sprintf("/proc/%d/root", t.State.Pid)
	}
	return "/proc/1/root"
}
