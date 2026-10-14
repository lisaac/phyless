package fsbrowse

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	ctr "phyless/backend/internal/docker/container"
)

const imgID = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

// fakeDocker serves ls output per (container, path) and records what ran.
type fakeDocker struct {
	client.APIClient
	mu      sync.Mutex
	target  container.InspectResponse
	noLs    bool              // the target has no ls (exec exits 126)
	ls      map[string]string // path → ls -la output (any container)
	diff    []container.FilesystemChange
	diffs   int
	execs   []string // "container:path"
	creates []*container.HostConfig
	exit    map[string]int // exec id → exit code
}

func (f *fakeDocker) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return f.target, nil
}
func (f *fakeDocker) ServerVersion(context.Context) (types.Version, error) {
	return types.Version{Arch: "amd64"}, nil
}
func (f *fakeDocker) ImageInspect(_ context.Context, ref string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: ref}, nil
}
func (f *fakeDocker) VolumeInspect(context.Context, string) (volume.Volume, error) {
	return volume.Volume{}, nil
}
func (f *fakeDocker) ContainerCreate(_ context.Context, _ *container.Config, h *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates = append(f.creates, h)
	return container.CreateResponse{ID: fmt.Sprintf("box%d", len(f.creates))}, nil
}
func (f *fakeDocker) ContainerStart(context.Context, string, container.StartOptions) error {
	return nil
}
func (f *fakeDocker) ContainerDiff(context.Context, string) ([]container.FilesystemChange, error) {
	f.mu.Lock()
	f.diffs++
	f.mu.Unlock()
	return f.diff, nil
}
func (f *fakeDocker) ContainerStatPath(_ context.Context, _ string, p string) (container.PathStat, error) {
	if p == "/app" {
		return container.PathStat{Name: "app", Mode: os.ModeDir | 0o755}, nil
	}
	return container.PathStat{Name: p, Size: int64(len(p)), Mode: 0o600}, nil
}
func (f *fakeDocker) ContainerExecCreate(_ context.Context, id string, o container.ExecOptions) (container.ExecCreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := o.Cmd[len(o.Cmd)-1]
	f.execs = append(f.execs, id+":"+p)
	eid := fmt.Sprintf("e%d", len(f.execs))
	if f.exit == nil {
		f.exit = map[string]int{}
	}
	if id == "target" && f.noLs {
		f.exit[eid] = 126
	}
	return container.ExecCreateResponse{ID: eid + "|" + p}, nil
}
func (f *fakeDocker) ContainerExecAttach(_ context.Context, eid string, _ container.ExecAttachOptions) (types.HijackedResponse, error) {
	_, p, _ := strings.Cut(eid, "|")
	out := f.ls[strings.TrimSuffix(strings.TrimPrefix(p, "/proc/1/root"), "/")]
	a, b := net.Pipe()
	go func() {
		if out != "" {
			payload := []byte(out)
			_, _ = b.Write(append([]byte{1, 0, 0, 0, byte(len(payload) >> 24), byte(len(payload) >> 16), byte(len(payload) >> 8), byte(len(payload))}, payload...))
		}
		_ = b.Close()
	}()
	return types.HijackedResponse{Conn: a, Reader: bufio.NewReader(a)}, nil
}
func (f *fakeDocker) ContainerExecInspect(_ context.Context, eid string) (container.ExecInspect, error) {
	id, _, _ := strings.Cut(eid, "|")
	f.mu.Lock()
	defer f.mu.Unlock()
	return container.ExecInspect{ExitCode: f.exit[id]}, nil
}

func lsLines(entries ...string) string {
	var b strings.Builder
	for _, e := range entries {
		mode := "-rw-r--r--"
		if strings.HasSuffix(e, "/") {
			mode, e = "drwxr-xr-x", strings.TrimSuffix(e, "/")
		}
		fmt.Fprintf(&b, "%s    1 root     root             3 Jan  2  2026 %s\n", mode, e)
	}
	return b.String()
}

func names(entries []ctr.FileEntry) string {
	var out []string
	for _, e := range entries {
		n := e.Name
		if e.IsDir {
			n += "/"
		}
		out = append(out, n)
	}
	slices.Sort(out)
	return strings.Join(out, " ")
}

func running(noLs bool) *fakeDocker {
	return &fakeDocker{noLs: noLs, ls: map[string]string{"/etc": lsLines("hosts")},
		target: container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
			ID: "target", Image: imgID, State: &container.State{Running: true}, HostConfig: &container.HostConfig{}}}}
}

func TestListRunningContainerUsesItsOwnLs(t *testing.T) {
	f := running(false)
	got, err := New(f).ListContainer(context.Background(), "target", "/etc")
	if err != nil || names(got) != "hosts" || len(f.creates) != 0 || f.execs[0] != "target:/etc/" {
		t.Fatalf("got=%v err=%v creates=%d execs=%v", names(got), err, len(f.creates), f.execs)
	}
}

func TestListRunningContainerWithoutLsJoinsItsPidNamespace(t *testing.T) {
	f := running(true)
	fs := New(f)
	for range 2 {
		got, err := fs.ListContainer(context.Background(), "target", "/etc")
		if err != nil || names(got) != "hosts" {
			t.Fatalf("got=%v err=%v", names(got), err)
		}
	}
	// One failed exec in the target, then the pid box is reused directly.
	want := []string{"target:/etc/", "box1:/proc/1/root/etc/", "box1:/proc/1/root/etc/"}
	if !slices.Equal(f.execs, want) || len(f.creates) != 1 || f.creates[0].PidMode != "container:target" {
		t.Fatalf("execs=%v creates=%+v", f.execs, f.creates)
	}
}

func stopped() *fakeDocker {
	return &fakeDocker{
		ls: map[string]string{"": lsLines("etc/", "usr/", "bin/", ".phyless/", "proc/"), "/etc": lsLines("hosts", "passwd"), "/data": lsLines("db/")},
		diff: []container.FilesystemChange{
			{Kind: container.ChangeDelete, Path: "/bin"},
			{Kind: container.ChangeAdd, Path: "/app"},
			{Kind: container.ChangeAdd, Path: "/app/run"},
			{Kind: container.ChangeModify, Path: "/etc"},
			{Kind: container.ChangeModify, Path: "/etc/hosts"},
			{Kind: container.ChangeAdd, Path: "/etc/new.conf"},
		},
		target: container.InspectResponse{
			ContainerJSONBase: &container.ContainerJSONBase{ID: "target", Image: imgID, State: &container.State{FinishedAt: "t1"}},
			Mounts:            []container.MountPoint{{Destination: "/data"}},
		},
	}
}

func TestListStoppedContainerMergesImageWithChanges(t *testing.T) {
	f := stopped()
	fs := New(f)
	root, err := fs.ListContainer(context.Background(), "target", "/")
	if err != nil || names(root) != "app/ etc/ proc/ usr/" { // no busybox mount point
		t.Fatalf("root=%v err=%v", names(root), err)
	}
	if procs, err := fs.ListContainer(context.Background(), "target", "/proc"); err != nil || len(procs) != 0 {
		t.Fatalf("runtime /proc leaked: %v err=%v", names(procs), err)
	}
	etc, err := fs.ListContainer(context.Background(), "target", "/etc")
	if err != nil || names(etc) != "hosts new.conf passwd" {
		t.Fatalf("etc=%v err=%v", names(etc), err)
	}
	for _, e := range etc {
		stat := e.Name != "passwd" // changed or added: real metadata from stat
		if stat != (e.Mode == "-rw-------") {
			t.Fatalf("entry %+v stat'ed=%v", e, e.Mode == "-rw-------")
		}
	}
	if _, err := fs.ListContainer(context.Background(), "target", "/bin"); err == nil {
		t.Fatal("deleted directory listed")
	}
	// The image box is shared; no box needed the container's own namespaces.
	if len(f.creates) != 1 || f.creates[0].PidMode != "" || len(f.creates[0].VolumesFrom) != 0 || f.diffs != 1 {
		t.Fatalf("creates=%+v diffs=%d", f.creates, f.diffs)
	}
}

func TestListStoppedContainerMountUsesItsVolumes(t *testing.T) {
	f := stopped()
	got, err := New(f).ListContainer(context.Background(), "target", "/data")
	if err != nil || names(got) != "db/" || len(f.creates) != 1 || f.creates[0].VolumesFrom[0] != "target:ro" || f.diffs != 0 {
		t.Fatalf("got=%v err=%v creates=%+v diffs=%d", names(got), err, f.creates, f.diffs)
	}
}

func TestChangesAreCachedUntilTheContainerRunsOrIsWritten(t *testing.T) {
	f := stopped()
	fs := New(f)
	list := func() {
		t.Helper()
		if _, err := fs.ListContainer(context.Background(), "target", "/etc"); err != nil {
			t.Fatal(err)
		}
	}
	list()
	list()
	if f.diffs != 1 {
		t.Fatalf("cached changes refetched: %d", f.diffs)
	}
	f.target.State.FinishedAt = "t2" // ran and stopped again
	list()
	fs.Invalidate()
	list()
	if f.diffs != 3 {
		t.Fatalf("stale changes served: diffs=%d", f.diffs)
	}
}

func TestMergeHandlesNestedAndDeletedChildren(t *testing.T) {
	cs := &changeSet{changes: []change{
		{"/a", container.ChangeModify}, {"/a/new", container.ChangeAdd},
		{"/a/old", container.ChangeDelete}, {"/a/sub/x", container.ChangeAdd},
	}}
	base := []ctr.FileEntry{{Name: "old"}, {Name: "keep"}, {Name: "sub", IsDir: true}}
	out, need := merge(base, cs.children("/a"))
	if names(out) != "keep new sub/" || len(need) != 1 || out[need[0]].Name != "new" {
		t.Fatalf("out=%v need=%v", names(out), need)
	}
	if !(&changeSet{changes: []change{{"/a", container.ChangeDelete}}}).deleted("/a/b/c") {
		t.Fatal("ancestor deletion missed")
	}
}
