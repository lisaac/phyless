package debugshell

import (
	"archive/tar"
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type fakeClient struct {
	client.APIClient
	mu         sync.Mutex
	imported   bool
	volume     bool
	files      map[string]int64
	platform   string
	creates    []*container.Config
	hosts      []*container.HostConfig
	removed    []string
	execs      int
	execGoneN  int // fail this many exec creates with NotFound
	execMissN  int // this many execs exit 126 (busybox missing)
	volRemoved int
	startedIDs []string
}

func (f *fakeClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
		ID: "target", State: &container.State{Running: true, Pid: 42}, HostConfig: &container.HostConfig{},
	}}, nil
}

func (f *fakeClient) ServerVersion(context.Context) (types.Version, error) {
	return types.Version{Arch: "arm64"}, nil
}

func (f *fakeClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.imported {
		return image.InspectResponse{}, errdefs.NotFound(errors.New("no such image"))
	}
	return image.InspectResponse{}, nil
}

func (f *fakeClient) ImageImport(_ context.Context, src image.ImportSource, _ string, o image.ImportOptions) (io.ReadCloser, error) {
	files := map[string]int64{}
	tr := tar.NewReader(src.Source)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		files[h.Name] = h.Mode
	}
	f.mu.Lock()
	f.platform, f.files, f.imported = o.Platform, files, true
	f.mu.Unlock()
	return io.NopCloser(strings.NewReader("{}")), nil
}

func (f *fakeClient) VolumeInspect(context.Context, string) (volume.Volume, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.volume {
		return volume.Volume{}, errdefs.NotFound(errors.New("no such volume"))
	}
	return volume.Volume{}, nil
}

func (f *fakeClient) ContainerCreate(_ context.Context, c *container.Config, h *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(c.Image, "phyless-debug:") && !f.imported {
		return container.CreateResponse{}, errdefs.NotFound(errors.New("No such image"))
	}
	for _, m := range h.Mounts {
		if m.Target == "/bin" { // populating the busybox volume
			f.volume = true
		}
	}
	f.creates, f.hosts = append(f.creates, c), append(f.hosts, h)
	return container.CreateResponse{ID: "c" + string(rune('0'+len(f.creates)))}, nil
}

func (f *fakeClient) ContainerAttach(context.Context, string, container.AttachOptions) (types.HijackedResponse, error) {
	a, _ := net.Pipe()
	return types.HijackedResponse{Conn: a}, nil
}

func (f *fakeClient) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	f.mu.Lock()
	f.startedIDs = append(f.startedIDs, id)
	f.mu.Unlock()
	return nil
}

func (f *fakeClient) ContainerRemove(_ context.Context, id string, _ container.RemoveOptions) error {
	f.mu.Lock()
	f.removed = append(f.removed, id)
	f.mu.Unlock()
	return nil
}

func (f *fakeClient) ContainerExecCreate(_ context.Context, id string, _ container.ExecOptions) (container.ExecCreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.execGoneN > 0 {
		f.execGoneN--
		return container.ExecCreateResponse{}, errdefs.NotFound(errors.New("No such container: " + id))
	}
	f.execs++
	return container.ExecCreateResponse{ID: "exec"}, nil
}

func (f *fakeClient) ContainerExecAttach(context.Context, string, container.ExecAttachOptions) (types.HijackedResponse, error) {
	a, b := net.Pipe()
	go func() {
		payload := []byte("drwxr-xr-x    2 root     root          4096 Oct 14 03:15 sub\n")
		_, _ = b.Write(append([]byte{1, 0, 0, 0, 0, 0, 0, byte(len(payload))}, payload...))
		_ = b.Close()
	}()
	return types.HijackedResponse{Conn: a, Reader: bufio.NewReader(a)}, nil
}

func (f *fakeClient) ContainerExecInspect(context.Context, string) (container.ExecInspect, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.execMissN > 0 {
		f.execMissN--
		return container.ExecInspect{ExitCode: 126}, nil
	}
	return container.ExecInspect{}, nil
}

func (f *fakeClient) VolumeRemove(context.Context, string, bool) error {
	f.mu.Lock()
	f.volRemoved++
	f.volume = false
	f.mu.Unlock()
	return nil
}

func TestStartImportsBusyboxAndJoinsTargetNamespaces(t *testing.T) {
	f := &fakeClient{}
	id, hj, err := Start(context.Background(), f, "target")
	if err != nil {
		t.Fatal(err)
	}
	hj.Close()
	if id == "" || len(f.startedIDs) != 1 {
		t.Fatalf("id=%q started=%v", id, f.startedIDs)
	}
	if f.platform != "linux/arm64" || f.files["bin/busybox"] != 0o755 {
		t.Fatalf("import platform=%q files=%v", f.platform, f.files)
	}
	cfg, host := f.creates[0], f.hosts[0]
	if host.PidMode != "container:target" || host.NetworkMode != "container:target" || !host.AutoRemove {
		t.Fatalf("host config %+v", host)
	}
	if !cfg.StdinOnce || !cfg.Tty || cfg.Labels["phyless.role"] != Role || cfg.Env[0] != "ROOT=/proc/1/root" {
		t.Fatalf("config %+v", cfg)
	}
}

// browseCreates are the pool's containers (not the volume-populating one).
func (f *fakeClient) browseCreates() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []int
	for i, c := range f.creates {
		if len(c.Entrypoint) == 1 && c.Entrypoint[0] == Busybox {
			out = append(out, i)
		}
	}
	return out
}

func TestPoolSharesOneBrowseContainerAcrossConcurrentListings(t *testing.T) {
	f := &fakeClient{}
	p := NewPool(f)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entries, err := p.Ls(context.Background(), "image:x", Spec{Image: "sha256:x"}, "/etc")
			if err == nil && (len(entries) != 1 || entries[0].Name != "sub") {
				err = errors.New("bad entries")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	boxes := f.browseCreates()
	if len(boxes) != 1 || f.execs != 8 {
		t.Fatalf("browse creates=%d execs=%d", len(boxes), f.execs)
	}
	cfg, host := f.creates[boxes[0]], f.hosts[boxes[0]]
	if cfg.Image != "sha256:x" || cfg.Cmd[0] != "sleep" || cfg.User != "0" || cfg.Healthcheck.Test[0] != "NONE" || cfg.Labels["phyless.role"] != Role {
		t.Fatalf("browse config %+v", cfg)
	}
	if !host.AutoRemove || host.NetworkMode != "none" || len(host.Mounts) != 1 || !host.Mounts[0].ReadOnly || host.Mounts[0].Target != "/.phyless" {
		t.Fatalf("browse host %+v", host)
	}
	// The volume was empty: one populating container, created then removed.
	if !f.volume || len(f.creates) != 2 || len(f.removed) != 1 {
		t.Fatalf("populate: volume=%v creates=%d removed=%v", f.volume, len(f.creates), f.removed)
	}
}

func TestPoolRecreatesVanishedOrExpiringBox(t *testing.T) {
	f := &fakeClient{imported: true, volume: true}
	p := NewPool(f)
	now := time.Unix(0, 0)
	p.now = func() time.Time { return now }
	if _, err := p.Ls(context.Background(), "k", Spec{}, "/"); err != nil {
		t.Fatal(err)
	}
	f.execGoneN = 1 // someone removed it
	if _, err := p.Ls(context.Background(), "k", Spec{}, "/"); err != nil {
		t.Fatal(err)
	}
	if n := len(f.browseCreates()); n != 2 {
		t.Fatalf("vanished box not recreated: creates=%d", n)
	}
	now = now.Add(boxLife - boxMargin + time.Second) // about to exit on its own
	if _, err := p.Ls(context.Background(), "k", Spec{}, "/"); err != nil {
		t.Fatal(err)
	}
	if n := len(f.browseCreates()); n != 3 {
		t.Fatalf("expiring box not replaced: creates=%d", n)
	}
	if !p.Has("k") {
		t.Fatal("live box not reported")
	}
	if err := p.Remove(context.Background(), "k"); err != nil || p.Has("k") {
		t.Fatalf("remove: err=%v has=%v", err, p.Has("k"))
	}
}

func TestPoolRepairsAnEmptyBusyboxVolume(t *testing.T) {
	f := &fakeClient{imported: true, volume: true, execMissN: 1}
	p := NewPool(f)
	entries, err := p.Ls(context.Background(), "k", Spec{}, "/")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	// Box removed, blank volume dropped and refilled, box recreated.
	if f.volRemoved != 1 || !f.volume || len(f.browseCreates()) != 2 {
		t.Fatalf("volRemoved=%d volume=%v creates=%d", f.volRemoved, f.volume, len(f.browseCreates()))
	}
}
