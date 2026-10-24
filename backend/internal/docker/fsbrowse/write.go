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
	return f.write(ctx, t, []string{p}, true, write{cmd: "rm", flags: []string{"-rf"}})
}

// Rename moves from to to.
func (f *FS) Rename(ctx context.Context, t Target, from, to string) error {
	return f.write(ctx, t, []string{from, to}, true, write{cmd: "mv"})
}

// SetPerm sets p's owner ("uid" or "uid:gid") and/or mode (octal like
// "4755"); "" keeps either. chown runs first: it clears setuid/setgid.
func (f *FS) SetPerm(ctx context.Context, t Target, p, mode, owner string, recursive bool) error {
	var flags []string
	if recursive {
		flags = []string{"-R"}
	}
	var ws []write
	switch {
	case mode == "" && owner == "":
		return errors.New("未指定权限或属主")
	case mode != "" && !ValidMode(mode):
		return fmt.Errorf("权限须为 3 或 4 位八进制数: %q", mode)
	case owner != "" && !ValidOwner(owner):
		return fmt.Errorf("属主须为数字 uid 或 uid:gid: %q", owner)
	}
	if owner != "" {
		ws = append(ws, write{cmd: "chown", flags: flags, arg: owner})
	}
	if mode != "" {
		ws = append(ws, write{cmd: "chmod", flags: flags, arg: mode})
	}
	return f.write(ctx, t, []string{p}, false, ws...)
}

// write is `cmd flags -- [arg] paths...`.
type write struct {
	cmd   string
	flags []string
	arg   string // mode/owner; "" for none
}

func (w write) argv(root string, paths []string) []string {
	out := append([]string{w.cmd}, w.flags...)
	out = append(out, "--")
	if w.arg != "" {
		out = append(out, w.arg)
	}
	for _, p := range paths {
		out = append(out, root+p)
	}
	return out
}

// op is one change: its commands, in order, on the same paths after a single
// inspect (and, in a box, a single symlink check). moves: rm/mv, where a
// mount point or a directory holding one must stay.
type op struct {
	paths []string
	moves bool
	ws    []write
}

func (f *FS) write(ctx context.Context, target Target, paths []string, moves bool, ws ...write) error {
	o := op{paths: make([]string, len(paths)), moves: moves, ws: ws}
	for i, p := range paths {
		if p == "" || strings.ContainsRune(p, 0) || !path.IsAbs(p) {
			return fmt.Errorf("路径须为绝对路径: %q", p)
		}
		if o.paths[i] = path.Clean(p); o.paths[i] == "/" {
			return errors.New("不能修改根目录")
		}
	}
	if target.volume != "" {
		if err := f.volume(ctx, target.volume); err != nil {
			return err
		}
		return f.writeBox(ctx, volumeKey(target.volume), volumeSpec(target.volume), volRoot, o)
	}
	t, err := f.cli.ContainerInspect(ctx, target.container)
	if err != nil {
		return err
	}
	if t.ContainerJSONBase == nil || t.State == nil {
		return fmt.Errorf("容器状态未知: %s", target.container)
	}
	if o.moves {
		for _, p := range o.paths {
			if err := keepsMounts(t.Mounts, p); err != nil {
				return err
			}
		}
	}
	if !t.State.Running {
		return f.writeStopped(ctx, t, o)
	}
	defer f.Invalidate() // a running container's diff changed
	if !t.State.Paused {
		err := f.writeOwn(ctx, t.ID, o)
		if !errors.Is(err, ctr.ErrExecNotFound) {
			return err
		}
	}
	return f.writeBox(ctx, pidKey(t.ID), pidSpec(t), debugshell.TargetRoot(t), o)
}

// writeOwn runs o with the target's own tools. Missing ones surface as
// ErrExecNotFound before anything changed — unless a later command of o is
// the missing one, which then runs in the box after the first already did:
// harmless, as each command is idempotent.
func (f *FS) writeOwn(ctx context.Context, id string, o op) error {
	for _, w := range o.ws {
		if err := ctr.ExecRoot(ctx, f.cli, id, w.argv("", o.paths)); err != nil {
			return err
		}
	}
	return nil
}

func (f *FS) writeStopped(ctx context.Context, t container.InspectResponse, o op) error {
	var mount string
	for _, p := range o.paths {
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
	return f.writeBox(ctx, stoppedKey(t.ID), stoppedSpec(t), "", o)
}

// writeBox runs w with busybox in key's browse container, where the target's
// files are under root. chmod/chown refuse a symlink first: busybox would
// follow it in the box's own filesystem, not the target's.
func (f *FS) writeBox(ctx context.Context, key string, spec debugshell.Spec, root string, o op) error {
	if !o.moves {
		kind, err := f.pool.Run(ctx, key, spec, "stat", "-c", "%F", root+o.paths[0])
		if err != nil {
			return boxErr(err, root)
		}
		if strings.TrimSpace(kind) == "symbolic link" {
			return fmt.Errorf("%s 是符号链接，请修改它指向的文件", o.paths[0])
		}
	}
	for _, w := range o.ws {
		if err := f.pool.Write(ctx, key, spec, w.argv(root, o.paths)...); err != nil {
			return boxErr(err, root)
		}
	}
	return nil
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
