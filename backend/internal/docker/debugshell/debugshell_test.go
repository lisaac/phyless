package debugshell

import (
	"archive/tar"
	"context"
	"io"
	"net"
	"strings"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/system"
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

func (f *fakeClient) Info(context.Context) (system.Info, error) {
	return system.Info{Architecture: "aarch64"}, nil
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
	f.cfg, f.host = c, h
	return container.CreateResponse{ID: "debug"}, nil
}

func (f *fakeClient) ContainerAttach(context.Context, string, container.AttachOptions) (types.HijackedResponse, error) {
	a, _ := net.Pipe()
	return types.HijackedResponse{Conn: a}, nil
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
