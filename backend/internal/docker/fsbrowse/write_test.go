package fsbrowse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"

	ctr "phyless/backend/internal/docker/container"
)

func TestWriteRunningUsesItsOwnToolAsRoot(t *testing.T) {
	f := running(false)
	if err := New(f).Rename(context.Background(), Container("target"), "/a/", "/-b"); err != nil {
		t.Fatal(err)
	}
	if len(f.creates) != 0 || len(f.cmds) != 1 || f.cmds[0] != "target 0: mv -- /a /-b" {
		t.Fatalf("creates=%d cmds=%v", len(f.creates), f.cmds)
	}
}

func TestWriteFallsBackToBusyboxInPidBox(t *testing.T) {
	f := running(true) // own tools exit 126
	if err := New(f).SetPerm(context.Background(), Container("target"), "/etc/hosts", "0644", "", true); err != nil {
		t.Fatal(err)
	}
	last := f.cmds[len(f.cmds)-1]
	if len(f.creates) != 1 || f.creates[0].PidMode != "container:target" || !strings.HasSuffix(last, ": /.phyless/busybox chmod -R -- 0644 /proc/1/root/etc/hosts") {
		t.Fatalf("creates=%+v cmds=%v", f.creates, f.cmds)
	}

	f = running(false)
	f.target.State.Paused = true // exec refused: straight to the box
	if err := New(f).SetPerm(context.Background(), Container("target"), "/x", "", "1000:1000", false); err != nil {
		t.Fatal(err)
	}
	// stat (symlink check) then chown, both in the box.
	if len(f.cmds) != 2 || !strings.HasPrefix(f.cmds[0], "box1 ") || !strings.HasSuffix(f.cmds[1], "chown -- 1000:1000 /proc/1/root/x") {
		t.Fatalf("cmds=%v", f.cmds)
	}
}

func TestWriteRefusesSymlinkInBox(t *testing.T) {
	f := running(true)
	f.ls["/bin/sh"] = "symbolic link\n" // busybox stat -c %F
	if err := New(f).SetPerm(context.Background(), Container("target"), "/bin/sh", "755", "", false); err == nil || !strings.Contains(err.Error(), "符号链接") {
		t.Fatalf("err=%v", err)
	}
	if last := f.cmds[len(f.cmds)-1]; !strings.Contains(last, "stat -c %F /proc/1/root/bin/sh") {
		t.Fatalf("chmod ran after the symlink check: %v", f.cmds)
	}
}

func TestWriteStoppedOnlyInsideWritableMounts(t *testing.T) {
	f := stopped()
	f.target.Mounts = []container.MountPoint{{Destination: "/data", RW: true}, {Destination: "/conf", RW: false}, {Destination: "/cache", RW: true}}
	fs := New(f)
	ctx := context.Background()
	if err := fs.Rename(ctx, Container("target"), "/data/a", "/data/b"); err != nil {
		t.Fatal(err)
	}
	if len(f.creates) != 1 || f.creates[0].VolumesFrom[0] != "target" || f.cmds[0] != "box1 : /.phyless/busybox mv -- /data/a /data/b" {
		t.Fatalf("creates=%+v cmds=%v", f.creates, f.cmds)
	}
	for name, err := range map[string]error{
		"rootfs":      fs.Remove(ctx, Container("target"), "/etc/hosts"),
		"read-only":   fs.SetPerm(ctx, Container("target"), "/conf/x", "644", "", false),
		"cross-mount": fs.Rename(ctx, Container("target"), "/data/a", "/cache/a"),
		"mount point": fs.Remove(ctx, Container("target"), "/data"),
		"holds mount": fs.Rename(ctx, Container("target"), "/", "/x"),
		"bad mode":    fs.SetPerm(ctx, Container("target"), "/data/a", "8", "", false),
		"bad owner":   fs.SetPerm(ctx, Container("target"), "/data/a", "", "root", false),
		"relative":    fs.Remove(ctx, Container("target"), "data/a"),
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
		if err := New(f).Remove(context.Background(), Container("target"), p); err == nil {
			t.Errorf("rm %s accepted", p)
		}
	}
	if err := New(f).Remove(context.Background(), Container("target"), "/var/lib/db/x"); err != nil || len(f.cmds) != 1 {
		t.Fatalf("err=%v cmds=%v", err, f.cmds)
	}
}

func TestVolumeIsBrowsedAndChangedThroughItsBox(t *testing.T) {
	f := &fakeDocker{ls: map[string]string{volRoot + "/a": lsLines("f")}}
	fs := New(f)
	ctx := context.Background()
	got, err := fs.ListVolume(ctx, "vol", "a/../a")
	if err != nil || names(got) != "f" {
		t.Fatalf("got=%v err=%v", names(got), err)
	}
	if err := fs.Rename(ctx, Volume("vol"), "/a/f", "/a/g"); err != nil {
		t.Fatal(err)
	}
	m := f.creates[0].Mounts[0] // the volume, then busybox
	if len(f.creates) != 1 || m.Source != "vol" || m.Target != volRoot || m.ReadOnly {
		t.Fatalf("creates=%+v", f.creates)
	}
	if last := f.cmds[len(f.cmds)-1]; last != "box1 : /.phyless/busybox mv -- "+volRoot+"/a/f "+volRoot+"/a/g" {
		t.Fatalf("cmds=%v", f.cmds)
	}
	f.noVol = true // never mount a missing volume: Docker would create it
	if _, err := fs.ListVolume(ctx, "gone", "/"); err == nil {
		t.Fatal("missing volume listed")
	}
	if err := fs.Remove(ctx, Volume("gone"), "/x"); err == nil || len(f.creates) != 1 {
		t.Fatalf("err=%v creates=%d", err, len(f.creates))
	}
}

func TestBoxErrStripsRootButStaysMatchable(t *testing.T) {
	err := boxErr(fmt.Errorf("%w: "+volRoot+"/x", ctr.ErrUploadTooLarge), volRoot)
	if err.Error() != ctr.ErrUploadTooLarge.Error()+": /x" || !errors.Is(err, ctr.ErrUploadTooLarge) {
		t.Fatalf("err=%v", err)
	}
}

func TestSetPermChownsBeforeChmodAfterOneSymlinkCheck(t *testing.T) {
	f := running(true) // own tools missing: the first one falls back
	if err := New(f).SetPerm(context.Background(), Container("target"), "/x", "4755", "1:2", false); err != nil {
		t.Fatal(err)
	}
	var box []string
	for _, c := range f.cmds {
		if strings.HasPrefix(c, "box") {
			box = append(box, c[strings.Index(c, "busybox ")+8:])
		}
	}
	want := []string{"stat -c %F /proc/1/root/x", "chown -- 1:2 /proc/1/root/x", "chmod -- 4755 /proc/1/root/x"}
	if strings.Join(box, "|") != strings.Join(want, "|") {
		t.Fatalf("box cmds=%v", box)
	}
}
