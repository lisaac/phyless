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

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/network"
	dockersystem "github.com/moby/moby/api/types/system"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"

	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type systemInfoClient struct {
	client.APIClient
	info       dockersystem.Info
	version    client.ServerVersionResult
	infoErr    error
	versionErr error
}

func (c *systemInfoClient) Info(context.Context, client.InfoOptions) (client.SystemInfoResult, error) {
	return client.SystemInfoResult{Info: c.info}, c.infoErr
}

func (c *systemInfoClient) ServerVersion(context.Context, client.ServerVersionOptions) (client.ServerVersionResult, error) {
	return c.version, c.versionErr
}

func TestSystemInfoResponse(t *testing.T) {
	server := &Server{docker: &docker.Client{APIClient: &systemInfoClient{
		version: client.ServerVersionResult{Version: "28.0.1", APIVersion: "1.50", MinAPIVersion: "1.24"},
		info: dockersystem.Info{
			Name: "docker-host", ServerVersion: "ignored", OperatingSystem: "Ubuntu 24.04", OSType: "linux", Architecture: "x86_64", KernelVersion: "6.8", NCPU: 8, MemTotal: 16_000_000_000,
			NGoroutines: 42, NFd: 99, DockerRootDir: "/var/lib/docker", Driver: "overlay2", DriverStatus: [][2]string{{"Data Space Available", "120 GB"}},
			CgroupDriver: "systemd", CgroupVersion: "2", LoggingDriver: "json-file", DefaultRuntime: "runc", LiveRestoreEnabled: true,
		},
	}}}
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
	server := &Server{docker: &docker.Client{APIClient: &systemInfoClient{versionErr: errors.New("unavailable")}}}
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

func (c *summaryClient) ContainerList(context.Context, client.ContainerListOptions) (client.ContainerListResult, error) {
	c.calls++
	if c.fail {
		return client.ContainerListResult{}, errors.New("offline")
	}
	return client.ContainerListResult{Items: c.containers}, nil
}
func (*summaryClient) ImageList(context.Context, client.ImageListOptions) (client.ImageListResult, error) {
	return client.ImageListResult{Items: []image.Summary{{}, {}, {}, {Labels: map[string]string{docker.RoleLabel: "debug"}}}}, nil
}
func (*summaryClient) VolumeList(context.Context, client.VolumeListOptions) (client.VolumeListResult, error) {
	return client.VolumeListResult{Items: []volume.Volume{{}, {}, {Labels: map[string]string{docker.RoleLabel: "debug"}}}}, nil
}
func (*summaryClient) NetworkList(context.Context, client.NetworkListOptions) (client.NetworkListResult, error) {
	return client.NetworkListResult{Items: make([]network.Summary, 4)}, nil
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
		{Labels: map[string]string{docker.RoleLabel: "debug"}},
	}}
	s := &Server{store: st, docker: &docker.Client{APIClient: cli}}
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
