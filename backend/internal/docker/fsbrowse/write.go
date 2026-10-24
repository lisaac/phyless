package fsbrowse

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/docker/docker/api/types/container"

	ctr "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/debugshell"
)

// Changes to a container's or a volume's files, as argv-only commands (no
// shell, nothing to quote). A running container: its own tool first, run as
// root; busybox in its PID-sharing browse container when that tool is missing
// or it is paused. A stopped container has no live filesystem to change, only
// its mounts: its one browse container mounts them as the target does, so
// only paths inside a mount can change — the box's own rootfs would take the
// write and report success while the target stayed untouched. A volume:
// busybox in its browse container.

// Target is what a change applies to: Container(ref) or Volume(name).
type Target struct{ container, volume string }

func Container(ref string) Target { return Target{container: ref} }
func Volume(name string) Target   { return Target{volume: name} }

var (
	modeRe  = regexp.MustCompile(`^[0-7]{3,4}$`)
	ownerRe = regexp.MustCompile(`^[0-9]+(:[0-9]+)?$`) // numeric: names would resolve in the box's passwd
)

// ValidMode reports whether mode is octal like "755" or "4755".
func ValidMode(mode string) bool { return modeRe.MatchString(mode) }

// ValidOwner reports whether owner is "uid" or "uid:gid", numeric.
func ValidOwner(owner string) bool { return ownerRe.MatchString(owner) }

// Remove deletes p (recursively).
func (f *FS) Remove(ctx context.Context, t Target, p string) error {
	return f.write(ctx, t, write{cmd: "rm", flags: []string{"-rf"}, paths: []string{p}, moves: true})
}

// Rename moves from to to.
func (f *FS) Rename(ctx context.Context, t Target, from, to string) error {
	return f.write(ctx, t, write{cmd: "mv", paths: []string{from, to}, moves: true})
}

// Chmod sets p's mode, an octal string like "0755".
func (f *FS) Chmod(ctx context.Context, t Target, p, mode string, recursive bool) error {
	if !ValidMode(mode) {
		return fmt.Errorf("权限须为 3 或 4 位八进制数: %q", mode)
	}
	return f.write(ctx, t, write{cmd: "chmod", flags: recursiveFlag(recursive), arg: mode, paths: []string{p}})
}

// Chown sets p's owner, "uid" or "uid:gid".
func (f *FS) Chown(ctx context.Context, t Target, p, owner string, recursive bool) error {
	if !ValidOwner(owner) {
		return fmt.Errorf("属主须为数字 uid 或 uid:gid: %q", owner)
	}
	return f.write(ctx, t, write{cmd: "chown", flags: recursiveFlag(recursive), arg: owner, paths: []string{p}})
}

func recursiveFlag(on bool) []string {
	if on {
		return []string{"-R"}
	}
	return nil
}

// write is `cmd flags -- [arg] paths...`.
type write struct {
	cmd   string
	flags []string
	arg   string // mode/owner; "" for none
	paths []string
	moves bool // rm/mv: a mount point, or a directory holding one, must stay
}

func (w write) argv(root string) []string {
	out := append([]string{w.cmd}, w.flags...)
	out = append(out, "--")
	if w.arg != "" {
		out = append(out, w.arg)
	}
	for _, p := range w.paths {
		out = append(out, root+p)
	}
	return out
}

func (f *FS) write(ctx context.Context, target Target, w write) error {
	for i, p := range w.paths {
		if p == "" || strings.ContainsRune(p, 0) || !path.IsAbs(p) {
			return fmt.Errorf("路径须为绝对路径: %q", p)
		}
		if w.paths[i] = path.Clean(p); w.paths[i] == "/" {
			return errors.New("不能修改根目录")
		}
	}
	if target.volume != "" {
		if err := f.volume(ctx, target.volume); err != nil {
			return err
		}
		return f.writeBox(ctx, volumeKey(target.volume), volumeSpec(target.volume), volRoot, w)
	}
	t, err := f.cli.ContainerInspect(ctx, target.container)
	if err != nil {
		return err
	}
	if t.ContainerJSONBase == nil || t.State == nil {
		return fmt.Errorf("容器状态未知: %s", target.container)
	}
	if w.moves {
		for _, p := range w.paths {
			if err := keepsMounts(t.Mounts, p); err != nil {
				return err
			}
		}
	}
	if !t.State.Running {
		return f.writeStopped(ctx, t, w)
	}
	defer f.Invalidate() // a running container's diff changed
	if !t.State.Paused {
		err := ctr.ExecRoot(ctx, f.cli, t.ID, w.argv(""))
		if !errors.Is(err, ctr.ErrExecNotFound) {
			return err
		}
	}
	return f.writeBox(ctx, pidKey(t.ID), pidSpec(t), debugshell.TargetRoot(t), w)
}

func (f *FS) writeStopped(ctx context.Context, t container.InspectResponse, w write) error {
	var mount string
	for _, p := range w.paths {
		m, ok := mountOf(t.Mounts, p)
		switch {
		case !ok:
			return fmt.Errorf("容器未运行，只能修改卷或挂载内的文件: %s", p)
		case m.Type == "tmpfs":
			return fmt.Errorf("容器未运行，tmpfs 挂载没有内容: %s", p)
		case !m.RW:
			return fmt.Errorf("挂载为只读: %s", m.Destination)
		case mount != "" && m.Destination != mount:
			return errors.New("容器未运行，不能跨挂载移动")
		}
		mount = m.Destination
	}
	// No Invalidate: mounts are not part of the container's diff.
	return f.writeBox(ctx, stoppedKey(t.ID), stoppedSpec(t), "", w)
}

// writeBox runs w with busybox in key's browse container, where the target's
// files are under root. chmod/chown refuse a symlink first: busybox would
// follow it in the box's own filesystem, not the target's.
func (f *FS) writeBox(ctx context.Context, key string, spec debugshell.Spec, root string, w write) error {
	if w.cmd == "chmod" || w.cmd == "chown" {
		kind, err := f.pool.Run(ctx, key, spec, "stat", "-c", "%F", root+w.paths[0])
		if err != nil {
			return boxErr(err, root)
		}
		if strings.TrimSpace(kind) == "symbolic link" {
			return fmt.Errorf("%s 是符号链接，请修改它指向的文件", w.paths[0])
		}
	}
	return boxErr(f.pool.Write(ctx, key, spec, w.argv(root)...), root)
}

// keepsMounts refuses to remove or move a mount point or a directory holding
// one: rm -rf would empty the volume and then fail on the busy mount point.
func keepsMounts(mounts []container.MountPoint, p string) error {
	for _, m := range mounts {
		if d := path.Clean("/" + m.Destination); d == p || strings.HasPrefix(d, p+"/") {
			return fmt.Errorf("%s 是挂载点或其下有挂载点（%s），不能删除或移动", p, d)
		}
	}
	return nil
}

// boxErr shows paths as the target sees them, keeping err matchable.
func boxErr(err error, root string) error {
	if err == nil || root == "" {
		return err
	}
	return rootedErr{err, root}
}

type rootedErr struct {
	err  error
	root string
}

func (e rootedErr) Error() string { return strings.ReplaceAll(e.err.Error(), e.root, "") }
func (e rootedErr) Unwrap() error { return e.err }
