package debugshell

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"regexp"
	"slices"
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
	names      []string
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

func (f *fakeClient) ContainerCreate(_ context.Context, c *container.Config, h *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, name string) (container.CreateResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.names = append(f.names, name)
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
	if f.platform != "linux/arm64" || f.files["bin/busybox"] != 0o755 || f.files["usr/share/licenses/busybox/COPYING"] != 0o644 {
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
	ctx, used := Track(context.Background())
	if _, err := p.Ls(ctx, "k", Spec{Name: "app"}, "/"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(used(), "phyless-autoremove-browse-app-") {
		t.Fatalf("tracked helper = %q", used())
	}
	f.execGoneN = 1 // someone removed it
	if _, err := p.Ls(context.Background(), "k", Spec{}, "/"); err != nil {
		t.Fatal(err)
	}
	if n := len(f.browseCreates()); n != 2 {
		t.Fatalf("vanished box not recreated: creates=%d", n)
	}
	now = now.Add(BoxLife - boxMargin + time.Second) // about to exit on its own
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

func TestHelperNamesAreReadableAndDockerSafe(t *testing.T) {
	valid := regexp.MustCompile(`^phyless-autoremove-[a-zA-Z0-9][a-zA-Z0-9_.-]*-[0-9a-f]{6}$`)
	for target, want := range map[string]string{
		"/sntlbb":       "phyless-autoremove-browse-sntlbb-",
		"ghcr.io/a/b:1": "phyless-autoremove-browse-ghcr.io-a-b-1-",
		"sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789": "phyless-autoremove-browse-abcdef012345-",
		"": "phyless-autoremove-browse-",
	} {
		got := HelperName("browse", target)
		if !strings.HasPrefix(got, want) || len(got) != len(want)+6 || !valid.MatchString(got) {
			t.Errorf("HelperName(%q) = %q, want %s<6 hex>", target, got, want)
		}
	}
	if HelperName("x", "y") == HelperName("x", "y") {
		t.Error("names must not collide")
	}
	f := &fakeClient{imported: true, volume: true}
	if _, err := NewPool(f).Ls(context.Background(), "k", Spec{Name: "/web"}, "/"); err != nil {
		t.Fatal(err)
	}
	if len(f.names) != 1 || !strings.HasPrefix(f.names[0], "phyless-autoremove-browse-web-") {
		t.Fatalf("browse container names %v", f.names)
	}
}

type pruneClient struct {
	fakeClient
	imgs         []image.Summary
	vols         []*volume.Volume
	rmImg, rmVol []string
}

func (c *pruneClient) ImageList(context.Context, image.ListOptions) ([]image.Summary, error) {
	return c.imgs, nil
}
func (c *pruneClient) ImageRemove(_ context.Context, id string, _ image.RemoveOptions) ([]image.DeleteResponse, error) {
	c.rmImg = append(c.rmImg, id)
	return nil, nil
}
func (c *pruneClient) VolumeList(context.Context, volume.ListOptions) (volume.ListResponse, error) {
	return volume.ListResponse{Volumes: c.vols}, nil
}
func (c *pruneClient) VolumeRemove(_ context.Context, name string, _ bool) error {
	c.rmVol = append(c.rmVol, name)
	return nil
}

func TestPruneKeepsOnlyTheCurrentDebugImageAndVolume(t *testing.T) {
	c := &pruneClient{}
	a, err := assetFor(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	c.imgs = []image.Summary{{ID: "cur", RepoTags: []string{a.image()}}, {ID: "old", RepoTags: []string{"phyless-debug:arm64-000000000000"}}}
	c.vols = []*volume.Volume{{Name: a.volume()}, {Name: "phyless-busybox-arm64-000000000000"}, {Name: "users-own-volume"}}
	Prune(context.Background(), c)
	if !slices.Equal(c.rmImg, []string{"old"}) || !slices.Equal(c.rmVol, []string{"phyless-busybox-arm64-000000000000"}) {
		t.Fatalf("removed images=%v volumes=%v", c.rmImg, c.rmVol)
	}
}

func TestEmbeddedBusyboxMatchesEachArch(t *testing.T) {
	machine := map[string]uint16{"amd64": 62, "arm64": 183, "arm": 40, "386": 3} // ELF e_machine
	for arch, want := range machine {
		a := assets[arch]()
		zr, err := gzip.NewReader(strings.NewReader(a.gz))
		if err != nil {
			t.Fatalf("%s: %v", arch, err)
		}
		bin, err := io.ReadAll(zr)
		if err != nil || len(bin) < 20 || string(bin[:4]) != "\x7fELF" {
			t.Fatalf("%s: not an ELF (%d bytes, err=%v)", arch, len(bin), err)
		}
		if got := binary.LittleEndian.Uint16(bin[18:]); got != want {
			t.Errorf("%s: e_machine %d, want %d", arch, got, want)
		}
	}
	if len(assets) != len(machine) {
		t.Errorf("assets %d, tested %d", len(assets), len(machine))
	}
}
