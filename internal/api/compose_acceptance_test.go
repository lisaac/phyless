package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	composeapi "github.com/docker/compose/v2/pkg/api"
	containertypes "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	imageTypes "github.com/docker/docker/api/types/image"
	networkTypes "github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/jsonmessage"
	"phyless/internal/audit"
	phyDocker "phyless/internal/docker"
	dockercompose "phyless/internal/docker/compose"
	"phyless/internal/models"
	"phyless/internal/store"
)

const defaultComposeAPIAcceptanceImage = "busybox@sha256:fd8d9aa63ba2f0982b5304e1ee8d3b90a210bc1ffb5314d980eb6962f1a9715d"

// TestComposeAPIHandlerRealAcceptance exercises the HTTP handler boundary with
// a real daemon. It intentionally constructs the SDK client and embedded
// Compose runtime directly, so it does not require docker/compose/buildx
// executables. The test is opt-in because it creates a container, network, and
// named volume on the configured daemon.
func TestComposeAPIHandlerRealAcceptance(t *testing.T) {
	if os.Getenv("PHYLESS_COMPOSE_API_ACCEPTANCE") != "1" {
		t.Skip("set PHYLESS_COMPOSE_API_ACCEPTANCE=1 to run Compose API acceptance")
	}

	imageRef := strings.TrimSpace(os.Getenv("PHYLESS_ACCEPTANCE_IMAGE"))
	if imageRef == "" {
		imageRef = defaultComposeAPIAcceptanceImage
	}
	t.Setenv("COMPOSE_BAKE", "false")
	t.Setenv("BUILDX_BUILDER", "default")
	t.Setenv("DOCKER_AUTH_CONFIG", "")
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	t.Setenv("BUILDX_CONFIG", t.TempDir())
	t.Setenv("COMPOSE_ENV_FILES", "")

	raw, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal("create Docker SDK client:", err)
	}
	// Register raw.Close first: Go runs cleanups in LIFO order, so the SDK
	// connection is closed after every Docker API cleanup.
	t.Cleanup(func() {
		if err := raw.Close(); err != nil {
			t.Errorf("close Docker SDK client: %v", err)
		}
	})
	dc := &phyDocker.Client{APIClient: raw}

	operationCtx, operationCancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer operationCancel()
	if _, err := raw.Info(operationCtx); err != nil {
		t.Fatal("Docker daemon is unavailable:", err)
	}

	projectName := composeAPIAcceptanceProjectName()
	displayName := "display-only-" + projectName
	workingDir := t.TempDir()
	composePath := filepath.Join(workingDir, "compose.yaml")
	if err := os.WriteFile(composePath, []byte(fmt.Sprintf(`name: %s
services:
  app:
    image: %s
    pull_policy: never
    command: ["sh", "-c", "while true; do sleep 1; done"]
    volumes:
      - data:/data
volumes:
  data:
`, projectName, imageRef)), 0o600); err != nil {
		t.Fatal("write acceptance Compose file:", err)
	}

	assertComposeAPIAcceptanceResourcesUnused(t, operationCtx, dc, projectName)
	if err := ensureComposeAPIAcceptanceImage(operationCtx, dc, imageRef); err != nil {
		t.Fatal("cache acceptance image:", err)
	}

	registered := models.ComposeProject{
		ID:          "acceptance-1",
		Name:        displayName,
		BaseDir:     workingDir,
		ComposeFile: composePath,
	}
	stateDir := t.TempDir()
	projectStore := store.New(filepath.Join(stateDir, "config.json"))
	if err := projectStore.Write(&store.Config{ComposeProjects: []models.ComposeProject{registered}}); err != nil {
		t.Fatal("write acceptance store:", err)
	}
	runtime, err := dockercompose.NewRuntime(dc)
	if err != nil {
		t.Fatal("initialize Compose runtime:", err)
	}
	server := &Server{
		store:          projectStore,
		docker:         dc,
		composeRuntime: runtime,
		audit:          audit.New(filepath.Join(stateDir, "audit.log")),
	}

	// This cleanup is deliberately independent of the operation context. It
	// filters by this test's exact Compose project label and never prunes or
	// removes resources outside this unique project. It is registered after the
	// raw.Close cleanup above, so it runs first.
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cleanupComposeAPIAcceptanceResources(t, cleanupCtx, dc, projectName)
	})

	// The YAML name, not a process environment override or the display name,
	// must determine the new project's identity.
	t.Setenv("COMPOSE_PROJECT_NAME", "")
	callComposeAPIAcceptanceOperation(t, server.handleComposeUp, registered.ID)
	waitComposeAPIAcceptanceState(t, operationCtx, dc, projectName, true)

	// The registered record still points at the original path, while Docker's
	// Compose labels retain that path. This forces the lifecycle handlers to use
	// the trusted running project label and their missing-file fallback.
	movedPath := filepath.Join(workingDir, "compose.yaml.moved")
	if err := os.Rename(composePath, movedPath); err != nil {
		t.Fatal("move acceptance Compose file:", err)
	}
	callComposeAPIAcceptanceOperation(t, server.handleComposeStop, registered.ID)
	waitComposeAPIAcceptanceState(t, operationCtx, dc, projectName, false)
	callComposeAPIAcceptanceOperation(t, server.handleComposeRestart, registered.ID)
	waitComposeAPIAcceptanceState(t, operationCtx, dc, projectName, true)
	callComposeAPIAcceptanceOperation(t, server.handleComposeDown, registered.ID)
	waitComposeAPIAcceptanceGone(t, operationCtx, dc, projectName)

	if _, err := dc.VolumeInspect(operationCtx, projectName+"_data"); err != nil {
		t.Fatalf("compose down removed named volume %q: %v", projectName+"_data", err)
	}
}

func composeAPIAcceptanceProjectName() string {
	return fmt.Sprintf("phyless-acceptance-api-%d", time.Now().UnixNano())
}

func ensureComposeAPIAcceptanceImage(ctx context.Context, dc client.APIClient, imageRef string) error {
	if _, _, err := dc.ImageInspectWithRaw(ctx, imageRef); err == nil {
		return nil
	} else if !errdefs.IsNotFound(err) {
		return err
	}
	stream, err := dc.ImagePull(ctx, imageRef, imageTypes.PullOptions{})
	if err != nil {
		return err
	}
	defer stream.Close()
	return jsonmessage.DisplayJSONMessagesStream(stream, io.Discard, 0, false, nil)
}

func assertComposeAPIAcceptanceResourcesUnused(t *testing.T, ctx context.Context, dc client.APIClient, projectName string) {
	t.Helper()
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true})
	if err != nil {
		t.Fatal("list acceptance containers:", err)
	}
	for _, c := range containers {
		if c.Labels[composeapi.ProjectLabel] == projectName {
			t.Fatalf("acceptance project %q already owns container %s", projectName, c.ID)
		}
		for _, name := range c.Names {
			if strings.HasPrefix(strings.TrimPrefix(name, "/"), projectName+"-") {
				t.Fatalf("acceptance project %q already owns container %s", projectName, name)
			}
		}
	}
	if _, err := dc.NetworkInspect(ctx, projectName+"_default", networkTypes.InspectOptions{}); err == nil {
		t.Fatalf("acceptance network %q already exists", projectName+"_default")
	} else if !errdefs.IsNotFound(err) {
		t.Fatalf("inspect acceptance network: %v", err)
	}
	if _, err := dc.VolumeInspect(ctx, projectName+"_data"); err == nil {
		t.Fatalf("acceptance volume %q already exists", projectName+"_data")
	} else if !errdefs.IsNotFound(err) {
		t.Fatalf("inspect acceptance volume: %v", err)
	}
}

func callComposeAPIAcceptanceOperation(t *testing.T, handler http.HandlerFunc, id string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/compose?id="+id, nil).WithContext(ctx)
	response := httptest.NewRecorder()
	handler(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("Compose operation status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), `"error"`) {
		t.Fatalf("Compose operation returned an error: %s", response.Body.String())
	}
}

func waitComposeAPIAcceptanceState(t *testing.T, ctx context.Context, dc client.APIClient, projectName string, running bool) {
	t.Helper()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		containers, err := composeAPIAcceptanceContainers(ctx, dc, projectName)
		if err == nil && len(containers) == 1 && (containers[0].State == "running") == running {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for Compose project %q running=%v: %v", projectName, running, ctx.Err())
		case <-deadline.C:
			t.Fatalf("Compose project %q did not reach running=%v (containers=%#v, err=%v)", projectName, running, containers, err)
		case <-ticker.C:
		}
	}
}

func waitComposeAPIAcceptanceGone(t *testing.T, ctx context.Context, dc client.APIClient, projectName string) {
	t.Helper()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		containers, err := composeAPIAcceptanceContainers(ctx, dc, projectName)
		if err == nil && len(containers) == 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for Compose project %q to be down: %v", projectName, ctx.Err())
		case <-deadline.C:
			t.Fatalf("Compose project %q still has containers: %#v (err=%v)", projectName, containers, err)
		case <-ticker.C:
		}
	}
}

func composeAPIAcceptanceContainers(ctx context.Context, dc client.APIClient, projectName string) ([]containertypes.Summary, error) {
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", composeapi.ProjectLabel+"="+projectName)),
	})
	if err != nil {
		return nil, err
	}
	for _, c := range containers {
		if c.Labels[composeapi.ProjectLabel] != projectName {
			return nil, fmt.Errorf("container %s has unexpected Compose project label %q", c.ID, c.Labels[composeapi.ProjectLabel])
		}
	}
	return containers, nil
}

func cleanupComposeAPIAcceptanceResources(t *testing.T, ctx context.Context, dc client.APIClient, projectName string) {
	t.Helper()
	label := filters.NewArgs(filters.Arg("label", composeapi.ProjectLabel+"="+projectName))
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true, Filters: label})
	if err != nil {
		t.Errorf("list acceptance containers during cleanup: %v", err)
	} else {
		for _, c := range containers {
			if err := dc.ContainerRemove(ctx, c.ID, containertypes.RemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !errdefs.IsNotFound(err) {
				t.Errorf("remove acceptance container %s: %v", c.ID, err)
			}
		}
	}

	networks, err := dc.NetworkList(ctx, networkTypes.ListOptions{Filters: label})
	if err != nil {
		t.Errorf("list acceptance networks during cleanup: %v", err)
	} else {
		for _, network := range networks {
			if err := dc.NetworkRemove(ctx, network.ID); err != nil && !errdefs.IsNotFound(err) {
				t.Errorf("remove acceptance network %s: %v", network.ID, err)
			}
		}
	}

	volumes, err := dc.VolumeList(ctx, volume.ListOptions{Filters: label})
	if err != nil {
		t.Errorf("list acceptance volumes during cleanup: %v", err)
	} else {
		for _, volume := range volumes.Volumes {
			if err := dc.VolumeRemove(ctx, volume.Name, true); err != nil && !errdefs.IsNotFound(err) {
				t.Errorf("remove acceptance volume %s: %v", volume.Name, err)
			}
		}
	}
}
