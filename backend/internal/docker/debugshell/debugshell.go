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
// The shell is the container's main process (beside a sleep that anchors
// /proc/<pid>/root) and stdin is StdinOnce, so closing resp (or phyless dying)
// ends the shell, the container with it, and AutoRemove deletes it — nothing is left behind.
func Start(ctx context.Context, cli client.APIClient, target string) (string, types.HijackedResponse, error) {
	var none types.HijackedResponse
	t, err := cli.ContainerInspect(ctx, target)
	if err != nil {
		return "", none, err
	}
	if t.ContainerJSONBase == nil || t.State == nil || !t.State.Running || t.State.Paused {
		return "", none, fmt.Errorf("容器未运行，无法进入调试模式")
	}
	// chroot into the target without mounting anything: /proc/$K/root is a
	// magic link that still leads back to this container's /bin after the
	// chroot, since the target's /proc shows the shared PID namespace. Hard
	// links, not -s: absolute symlinks would resolve inside the target. If
	// chroot fails (no /proc in the target, say), fall back to cd "$ROOT".
	script := `/bin/busybox --install /bin
sleep 2147483647 & K=$!
B=/proc/$K/root/bin
printf '\033[33m[phyless] 容器内没有 shell，已进入调试模式：busybox 调试容器共享目标的进程与网络命名空间\033[0m\n'
printf '\033[33m辅助容器 %s，退出 shell 或关闭终端后自动删除\033[0m\n' "$HELPER"
if chroot "$ROOT" $B/busybox true 2>/dev/null; then
  printf '\033[33m已 chroot 到目标文件系统（/ 即目标的 /），busybox 位于 %s\033[0m\n' "$B"
  PATH=$B:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin exec chroot "$ROOT" $B/busybox sh
fi
kill $K
printf '\033[33mchroot 失败，已回退：目标文件系统位于 %s\033[0m\n' "$ROOT"
cd "$ROOT" 2>/dev/null || echo "无法进入 $ROOT"
exec sh`
	name := HelperName("shell", t.Name)
	cfg := &container.Config{
		Cmd:       []string{"/bin/busybox", "sh", "-c", script},
		Env:       []string{"ROOT=" + TargetRoot(t), "HELPER=" + name, "PATH=/bin", "TERM=xterm-256color", "LANG=C.UTF-8"},
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
	resp, err := createDebug(ctx, cli, name, cfg, hc)
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
