package debugshell

import (
	"archive/tar"
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type fakeClient struct {
	client.APIClient
	imported bool
	files    map[string]int64
	platform string
	cfg      *container.Config
	host     *container.HostConfig
	started  bool
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
	if !f.imported {
		return image.InspectResponse{}, errdefs.NotFound(io.EOF)
	}
	return image.InspectResponse{}, nil
}

func (f *fakeClient) ImageImport(_ context.Context, src image.ImportSource, _ string, o image.ImportOptions) (io.ReadCloser, error) {
	f.platform, f.files = o.Platform, map[string]int64{}
	tr := tar.NewReader(src.Source)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		f.files[h.Name] = h.Mode
	}
	f.imported = true
	return io.NopCloser(strings.NewReader("{}")), nil
}

func (f *fakeClient) ContainerCreate(_ context.Context, c *container.Config, h *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	if !f.imported {
		return container.CreateResponse{}, errdefs.NotFound(errors.New("No such image"))
	}
	f.cfg, f.host = c, h
	return container.CreateResponse{ID: "debug"}, nil
}

func (f *fakeClient) ContainerAttach(context.Context, string, container.AttachOptions) (types.HijackedResponse, error) {
	a, b := net.Pipe()
	go func() { // stdout frame for one-shot runs, then EOF
		payload := []byte("drwxr-xr-x    2 root     root          4096 Oct 14 03:15 sub\n")
		hdr := []byte{1, 0, 0, 0, 0, 0, 0, byte(len(payload))}
		_, _ = b.Write(append(hdr, payload...))
		_ = b.Close()
	}()
	return types.HijackedResponse{Conn: a, Reader: bufio.NewReader(a)}, nil
}

func (f *fakeClient) ContainerWait(context.Context, string, container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	c := make(chan container.WaitResponse, 1)
	c <- container.WaitResponse{}
	return c, make(chan error)
}

func (f *fakeClient) ContainerStart(context.Context, string, container.StartOptions) error {
	f.started = true
	return nil
}

func TestStartImportsBusyboxAndJoinsTargetNamespaces(t *testing.T) {
	f := &fakeClient{}
	id, hj, err := Start(context.Background(), f, "target")
	if err != nil {
		t.Fatal(err)
	}
	hj.Close()
	if id != "debug" || !f.started {
		t.Fatalf("id=%q started=%v", id, f.started)
	}
	if f.platform != "linux/arm64" || f.files["bin/busybox"] != 0o755 {
		t.Fatalf("import platform=%q files=%v", f.platform, f.files)
	}
	if f.host.PidMode != "container:target" || f.host.NetworkMode != "container:target" || !f.host.AutoRemove {
		t.Fatalf("host config %+v", f.host)
	}
	if !f.cfg.StdinOnce || !f.cfg.Tty || f.cfg.Labels["phyless.role"] != Role || f.cfg.Env[0] != "ROOT=/proc/1/root" {
		t.Fatalf("config %+v", f.cfg)
	}
}

func TestListDirStoppedMountsVolumesReadOnly(t *testing.T) {
	f := &fakeClient{imported: true}
	stopped := container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{ID: "target", State: &container.State{}}}
	entries, err := ListDir(context.Background(), f, stopped, "/data/../data/")
	if err != nil || len(entries) != 1 || entries[0].Name != "sub" || !entries[0].IsDir {
		t.Fatalf("entries=%+v err=%v", entries, err)
	}
	if got := f.host.VolumesFrom; len(got) != 1 || got[0] != "target:ro" || !f.host.AutoRemove || f.host.PidMode != "" {
		t.Fatalf("host config %+v", f.host)
	}
	if got := strings.Join(f.cfg.Cmd, " "); got != "/bin/busybox ls -la -- /data" {
		t.Fatalf("cmd %q", got)
	}
}
