package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	dockertypes "github.com/docker/docker/api/types"
	dockersystem "github.com/docker/docker/api/types/system"
	"github.com/docker/docker/client"
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
