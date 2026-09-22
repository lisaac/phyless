package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockersystem "github.com/docker/docker/api/types/system"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"

	"phyless/backend/internal/docker/imagefs"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type systemInfoClient struct {
	client.APIClient
	info       dockersystem.Info
	version    dockertypes.Version
	infoErr    error
	versionErr error
}

func (c *systemInfoClient) Info(context.Context) (dockersystem.Info, error) {
	return c.info, c.infoErr
}

func (c *systemInfoClient) ServerVersion(context.Context) (dockertypes.Version, error) {
	return c.version, c.versionErr
}

func TestNormalizeArch(t *testing.T) {
	cases := map[string]string{
		"x86_64":  "amd64",
		"aarch64": "arm64",
		"armv7l":  "arm",
		"armhf":   "arm",
		"amd64":   "amd64",
		"ARM64":   "arm64",
		" arm64 ": "arm64",
	}
	for in, want := range cases {
		if got := normalizeArch(in); got != want {
			t.Errorf("normalizeArch(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSystemInfoResponse(t *testing.T) {
	server := &Server{docker: &systemInfoClient{
		version: dockertypes.Version{Version: "28.0.1", APIVersion: "1.50", MinAPIVersion: "1.24"},
		info: dockersystem.Info{
			Name: "docker-host", ServerVersion: "ignored", OperatingSystem: "Ubuntu 24.04", OSType: "linux", Architecture: "x86_64", KernelVersion: "6.8", NCPU: 8, MemTotal: 16_000_000_000,
			NGoroutines: 42, NFd: 99, DockerRootDir: "/var/lib/docker", Driver: "overlay2", DriverStatus: [][2]string{{"Data Space Available", "120 GB"}},
			CgroupDriver: "systemd", CgroupVersion: "2", LoggingDriver: "json-file", DefaultRuntime: "runc", LiveRestoreEnabled: true,
		},
	}}
	response := httptest.NewRecorder()
	server.handleSystemInfo(response, httptest.NewRequest(http.MethodGet, "/api/system/info", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var got dockerInfoResponse
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ServerVersion != "28.0.1" || got.APIVersion != "1.50" || got.Architecture != "amd64" || got.StorageAvailable != "120 GB" || got.DockerRootDir != "/var/lib/docker" || !got.LiveRestore {
		t.Fatalf("unexpected Docker info: %#v", got)
	}
}

func TestSystemInfoFailure(t *testing.T) {
	server := &Server{docker: &systemInfoClient{versionErr: errors.New("unavailable")}}
	response := httptest.NewRecorder()
	server.handleSystemInfo(response, httptest.NewRequest(http.MethodGet, "/api/system/info", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

type summaryClient struct {
	client.APIClient
	containers []container.Summary
	calls      int
	fail       bool
}

func (c *summaryClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	c.calls++
	if c.fail {
		return nil, errors.New("offline")
	}
	return c.containers, nil
}
func (*summaryClient) ImageList(context.Context, image.ListOptions) ([]image.Summary, error) {
	return make([]image.Summary, 3), nil
}
func (*summaryClient) VolumeList(context.Context, volume.ListOptions) (volume.ListResponse, error) {
	return volume.ListResponse{Volumes: make([]*volume.Volume, 2)}, nil
}
func (*summaryClient) NetworkList(context.Context, network.ListOptions) ([]network.Summary, error) {
	return make([]network.Summary, 4), nil
}

func TestSystemSummaryUsesOneContainerScanAndMatchesComposeList(t *testing.T) {
	st := store.New(filepath.Join(t.TempDir(), "config.json"))
	p := models.ComposeProject{ID: "saved", Name: "display", BaseDir: "/app", ComposeFile: "/app/compose.yaml"}
	if err := st.Update(func(c *store.Config) error { c.ComposeProjects = []models.ComposeProject{p}; return nil }); err != nil {
		t.Fatal(err)
	}
	cli := &summaryClient{containers: []container.Summary{
		{State: "running", Labels: map[string]string{labelProject: "app", labelWorkingDir: "/app", labelConfigFiles: "/app/compose.yaml"}},
		{State: "exited", Labels: map[string]string{labelProject: "other"}},
		{Labels: map[string]string{imagefs.RoleLabel: imagefs.RoleValue}},
	}}
	s := &Server{store: st, docker: cli}
	response := httptest.NewRecorder()
	s.handleSystemSummary(response, httptest.NewRequest("GET", "/api/system/summary", nil))
	var got map[string]int
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"containers": 2, "running": 1, "images": 3, "volumes": 2, "networks": 4, "compose": 2}
	if response.Code != 200 || !reflect.DeepEqual(got, want) || cli.calls != 1 {
		t.Fatalf("response=%s calls=%d", response.Body, cli.calls)
	}
	cli.fail = true
	response = httptest.NewRecorder()
	s.handleSystemSummary(response, httptest.NewRequest("GET", "/api/system/summary", nil))
	if response.Code != 503 {
		t.Fatalf("failure returned %d", response.Code)
	}
}
