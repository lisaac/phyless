package fsbrowse

import (
	"context"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
)

func TestWriteRunningUsesItsOwnToolAsRoot(t *testing.T) {
	f := running(false)
	if err := New(f).Rename(context.Background(), "target", "/a/", "/-b"); err != nil {
		t.Fatal(err)
	}
	if len(f.creates) != 0 || len(f.cmds) != 1 || f.cmds[0] != "target 0: mv -- /a /-b" {
		t.Fatalf("creates=%d cmds=%v", len(f.creates), f.cmds)
	}
}

func TestWriteFallsBackToBusyboxInPidBox(t *testing.T) {
	f := running(true) // own tools exit 126
	if err := New(f).Chmod(context.Background(), "target", "/etc/hosts", "0644", true); err != nil {
		t.Fatal(err)
	}
	last := f.cmds[len(f.cmds)-1]
	if len(f.creates) != 1 || f.creates[0].PidMode != "container:target" || !strings.HasSuffix(last, ": /.phyless/busybox chmod -R -- 0644 /proc/1/root/etc/hosts") {
		t.Fatalf("creates=%+v cmds=%v", f.creates, f.cmds)
	}

	f = running(false)
	f.target.State.Paused = true // exec refused: straight to the box
	if err := New(f).Chown(context.Background(), "target", "/x", "1000:1000", false); err != nil {
		t.Fatal(err)
	}
	if len(f.cmds) != 1 || !strings.HasPrefix(f.cmds[0], "box1 ") {
		t.Fatalf("cmds=%v", f.cmds)
	}
}

func TestWriteRefusesSymlinkInBox(t *testing.T) {
	f := running(true)
	f.links = map[string]string{"/bin/sh": "/bin/busybox"}
	if err := New(f).Chmod(context.Background(), "target", "/bin/sh", "755", false); err == nil || !strings.Contains(err.Error(), "符号链接") {
		t.Fatalf("err=%v", err)
	}
	if len(f.creates) != 0 {
		t.Fatal("box created for a refused change")
	}
}

func TestWriteStoppedOnlyInsideWritableMounts(t *testing.T) {
	f := stopped()
	f.target.Mounts = []container.MountPoint{{Destination: "/data", RW: true}, {Destination: "/conf", RW: false}, {Destination: "/cache", RW: true}}
	fs := New(f)
	ctx := context.Background()
	if err := fs.Rename(ctx, "target", "/data/a", "/data/b"); err != nil {
		t.Fatal(err)
	}
	if len(f.creates) != 1 || f.creates[0].VolumesFrom[0] != "target" || f.cmds[0] != "box1 : /.phyless/busybox mv -- /data/a /data/b" {
		t.Fatalf("creates=%+v cmds=%v", f.creates, f.cmds)
	}
	for name, err := range map[string]error{
		"rootfs":      fs.Remove(ctx, "target", "/etc/hosts"),
		"read-only":   fs.Chmod(ctx, "target", "/conf/x", "644", false),
		"cross-mount": fs.Rename(ctx, "target", "/data/a", "/cache/a"),
		"mount point": fs.Remove(ctx, "target", "/data"),
		"holds mount": fs.Rename(ctx, "target", "/", "/x"),
		"bad mode":    fs.Chmod(ctx, "target", "/data/a", "8", false),
		"bad owner":   fs.Chown(ctx, "target", "/data/a", "root", false),
		"relative":    fs.Remove(ctx, "target", "data/a"),
	} {
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if len(f.cmds) != 1 {
		t.Fatalf("refused changes still ran: %v", f.cmds)
	}
}

func TestWriteRunningKeepsMountPoints(t *testing.T) {
	f := running(false)
	f.target.Mounts = []container.MountPoint{{Destination: "/var/lib/db", RW: true}}
	for _, p := range []string{"/var/lib/db", "/var"} {
		if err := New(f).Remove(context.Background(), "target", p); err == nil {
			t.Errorf("rm %s accepted", p)
		}
	}
	if err := New(f).Remove(context.Background(), "target", "/var/lib/db/x"); err != nil || len(f.cmds) != 1 {
		t.Fatalf("err=%v cmds=%v", err, f.cmds)
	}
}
