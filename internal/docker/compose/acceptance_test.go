package compose

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	composeapi "github.com/docker/compose/v2/pkg/api"
	containertypes "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	imageTypes "github.com/docker/docker/api/types/image"
	networkTypes "github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/daemon"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"phyless/internal/docker"
)

// TestComposeAPIRealAcceptance is opt-in because it creates a short-lived
// Compose project on a real daemon. The runner deliberately talks to Docker
// through the SDK; it does not need docker, compose, or buildx executables.
func TestComposeAPIRealAcceptance(t *testing.T) {
	if os.Getenv("PHYLESS_ACCEPTANCE") != "1" {
		t.Skip("set PHYLESS_ACCEPTANCE=1 to run against a real Docker daemon")
	}

	t.Setenv("COMPOSE_BAKE", "false")
	t.Setenv("DOCKER_AUTH_CONFIG", "")

	raw, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := raw.Close(); err != nil {
			t.Errorf("close Docker client: %v", err)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	info, err := raw.Info(ctx)
	if err != nil {
		t.Fatal("Docker daemon is unavailable:", err)
	}
	t.Logf("Docker server=%s os=%s arch=%s driver=%s memory=%d containers=%d images=%d", info.ServerVersion, info.OSType, info.Architecture, info.Driver, info.MemTotal, info.Containers, info.Images)
	arch := strings.ToLower(info.Architecture)
	if !strings.EqualFold(info.OSType, "linux") || arch != "amd64" && arch != "x86_64" {
		t.Fatalf("acceptance requires linux/amd64 daemon, got %s/%s", info.OSType, info.Architecture)
	}
	for _, executable := range []string{"docker", "docker-compose", "compose", "buildx"} {
		if path, err := exec.LookPath(executable); err == nil {
			t.Fatalf("external executable %s is available at %s; run this test in the no-CLI image", executable, path)
		}
	}

	protected := snapshotAcceptanceState(t, ctx, raw)
	runtime, err := NewRuntime(raw)
	if err != nil {
		t.Fatal(err)
	}

	projectName := acceptanceProjectName()
	workingDir := t.TempDir()
	builtRef := projectName + ":built"
	assertAcceptanceProjectUnused(t, ctx, raw, projectName, builtRef)
	writeAcceptanceProject(t, workingDir, projectName, builtRef)

	service, err := runtime.NewService(ctx, ServiceOptions{Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	project, err := runtime.LoadProject(ctx, ProjectOptions{
		Name:        projectName,
		WorkingDir:  workingDir,
		ConfigPaths: []string{"compose.yaml"},
		Environment: []string{"COMPOSE_PROFILES=acceptance"},
	})
	if err != nil {
		t.Fatal("load project:", err)
	}
	if project.Name != projectName || len(project.Services) != 3 {
		t.Fatalf("loaded project name/services = %q/%d", project.Name, len(project.Services))
	}
	config, err := project.MarshalYAML()
	if err != nil {
		t.Fatal("marshal config:", err)
	}
	for _, want := range []string{"services:", "profiles:", "volumes:"} {
		if !strings.Contains(string(config), want) {
			t.Fatalf("resolved config does not contain %q:\n%s", want, config)
		}
	}

	t.Cleanup(func() {
		cleanupAcceptanceProject(t, raw, service.Compose(), project, builtRef)
		assertAcceptanceState(t, context.Background(), raw, protected)
	})

	service.MaxConcurrency(1)
	if err := service.Compose().Up(ctx, project, composeapi.UpOptions{
		Create: composeapi.CreateOptions{
			Build: &composeapi.BuildOptions{
				Deps:     true,
				Quiet:    true,
				Progress: "quiet",
				Builder:  "default",
				Out:      io.Discard,
			},
			Recreate:             composeapi.RecreateDiverged,
			RecreateDependencies: composeapi.RecreateDiverged,
			Inherit:              true,
		},
		Start: composeapi.StartOptions{
			Project:     project,
			Wait:        true,
			WaitTimeout: 45 * time.Second,
		},
	}); err != nil {
		t.Fatal("compose up/build:", err)
	}

	ps, err := waitAcceptanceProject(ctx, service.Compose(), project, true)
	if err != nil {
		t.Fatal("compose ps after up:", err)
	}
	if len(ps) != 3 {
		t.Fatalf("compose ps returned %d containers, want 3", len(ps))
	}
	assertAcceptanceResources(t, ctx, raw, projectName)

	logs := &acceptanceLogs{}
	if err := service.Compose().Logs(ctx, projectName, logs, composeapi.LogOptions{
		Project:    project,
		Tail:       "20",
		Timestamps: true,
	}); err != nil {
		t.Fatal("compose logs:", err)
	}
	for _, want := range []string{"app-ready", "worker-ready", "built-ready"} {
		if !logs.contains(want) {
			t.Fatalf("compose logs did not contain %q: %v", want, logs.lines)
		}
	}

	if err := service.Compose().Stop(ctx, projectName, composeapi.StopOptions{Project: project}); err != nil {
		t.Fatal("compose stop:", err)
	}
	if _, err := waitAcceptanceProject(ctx, service.Compose(), project, false); err != nil {
		t.Fatal("compose ps after stop:", err)
	}
	if err := service.Compose().Restart(ctx, projectName, composeapi.RestartOptions{Project: project}); err != nil {
		t.Fatal("compose restart:", err)
	}
	if _, err := waitAcceptanceProject(ctx, service.Compose(), project, true); err != nil {
		t.Fatal("compose ps after restart:", err)
	}

	if err := service.Compose().Down(ctx, projectName, composeapi.DownOptions{Project: project}); err != nil {
		t.Fatal("compose down:", err)
	}
	owned := acceptanceLabelFilter(projectName)
	containers, err := raw.ContainerList(ctx, containertypes.ListOptions{All: true, Filters: owned})
	if err != nil {
		t.Fatal("list containers after down:", err)
	}
	if len(containers) != 0 {
		t.Fatalf("compose down left %d project containers", len(containers))
	}
	if _, err := raw.VolumeInspect(ctx, projectName+"_data"); err != nil {
		t.Fatalf("compose down removed named volume: %v", err)
	}
	if _, _, err := raw.ImageInspectWithRaw(ctx, builtRef); err != nil {
		t.Fatalf("compose down removed built image: %v", err)
	}
}

// TestComposeAPIProxyPullAcceptance keeps the Compose pull path fully local.
// The fixture image is exported from the daemon's cached busybox image into an
// in-memory registry, then an HTTP reverse proxy is the only route available to
// the request-scoped ImagePull implementation. Each case gets a fresh tag and
// Compose project so the pull count is unambiguous.
func TestComposeAPIProxyPullAcceptance(t *testing.T) {
	if os.Getenv("PHYLESS_ACCEPTANCE") != "1" {
		t.Skip("set PHYLESS_ACCEPTANCE=1 to run against a real Docker daemon")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	raw, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := raw.Close(); err != nil {
			t.Errorf("close Docker client: %v", err)
		}
	})
	info, err := raw.Info(ctx)
	if err != nil {
		t.Fatal("Docker daemon is unavailable:", err)
	}
	arch := strings.ToLower(info.Architecture)
	if !strings.EqualFold(info.OSType, "linux") || arch != "amd64" && arch != "x86_64" {
		t.Fatalf("acceptance requires linux/amd64 daemon, got %s/%s", info.OSType, info.Architecture)
	}
	protected := snapshotAcceptanceState(t, ctx, raw)
	t.Cleanup(func() { assertAcceptanceState(t, context.Background(), raw, protected) })

	imageRef, err := name.ParseReference(acceptanceBaseImage)
	if err != nil {
		t.Fatal("parse cached acceptance image:", err)
	}
	cached, err := daemon.Image(imageRef,
		daemon.WithClient(raw),
		daemon.WithContext(ctx),
		daemon.WithBufferedOpener(),
	)
	if err != nil {
		t.Fatal("read cached acceptance image:", err)
	}

	registryServer := httptest.NewServer(registry.New())
	target, err := url.Parse(registryServer.URL)
	if err != nil {
		registryServer.Close()
		t.Fatal("parse registry URL:", err)
	}
	reverseProxy := httputil.NewSingleHostReverseProxy(target)
	baseTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		registryServer.Close()
		t.Fatal("default HTTP transport is not configurable")
	}
	proxyTransport := baseTransport.Clone()
	proxyTransport.Proxy = nil
	reverseProxy.Transport = proxyTransport
	proxyServer := httptest.NewServer(reverseProxy)
	t.Cleanup(func() {
		proxyTransport.CloseIdleConnections()
		proxyServer.Close()
		registryServer.Close()
	})

	counting := &acceptanceCountingClient{APIClient: &docker.Client{APIClient: raw}}
	runtime, err := NewRuntime(counting)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name         string
		pullPolicy   string
		explicitPull bool
	}{
		{name: "missing", pullPolicy: "missing"},
		{name: "always", pullPolicy: "always"},
		{name: "explicit-pull", pullPolicy: "missing", explicitPull: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			caseCtx, caseCancel := context.WithTimeout(ctx, 90*time.Second)
			defer caseCancel()
			projectName := acceptanceProxyProjectName(tc.name)
			imageTag, err := name.NewTag(proxyImageName(registryServer.URL, tc.name), name.Insecure)
			if err != nil {
				t.Fatal("create registry image tag:", err)
			}
			imageName := imageTag.String()
			assertAcceptanceProjectUnused(t, caseCtx, raw, projectName, imageName)

			workingDir := t.TempDir()
			writeAcceptanceProxyProject(t, workingDir, projectName, imageName, tc.pullPolicy)
			service, err := runtime.NewService(caseCtx, ServiceOptions{Output: io.Discard})
			if err != nil {
				t.Fatal("new compose service:", err)
			}
			project, err := runtime.LoadProject(caseCtx, ProjectOptions{
				Name:        projectName,
				WorkingDir:  workingDir,
				ConfigPaths: []string{"compose.yaml"},
			})
			if err != nil {
				t.Fatal("load proxy project:", err)
			}
			t.Cleanup(func() { cleanupAcceptanceProject(t, raw, service.Compose(), project, imageName) })

			transport, ok := http.DefaultTransport.(*http.Transport)
			if !ok {
				t.Fatal("default HTTP transport is not configurable")
			}
			direct := transport.Clone()
			direct.Proxy = nil
			t.Cleanup(direct.CloseIdleConnections)
			if err := remote.Write(imageTag, cached, remote.WithContext(caseCtx), remote.WithTransport(direct)); err != nil {
				t.Fatal("publish cached image to in-memory registry:", err)
			}

			pullCtx, err := docker.WithPullProxy(caseCtx, proxyServer.URL)
			if err != nil {
				t.Fatal("configure compose pull proxy:", err)
			}
			before := counting.countPulls(imageName)
			if tc.explicitPull {
				if err := service.Compose().Pull(pullCtx, project, composeapi.PullOptions{}); err != nil {
					t.Fatal("compose explicit pull:", err)
				}
				assertImportedAcceptanceImage(t, caseCtx, raw, imageName)
			}
			up := func() error {
				return service.Compose().Up(pullCtx, project, composeapi.UpOptions{
					Create: composeapi.CreateOptions{
						Build: &composeapi.BuildOptions{
							Quiet:    true,
							Progress: "quiet",
							Builder:  "default",
							Out:      io.Discard,
						},
						Recreate:             composeapi.RecreateDiverged,
						RecreateDependencies: composeapi.RecreateDiverged,
						Inherit:              true,
					},
					Start: composeapi.StartOptions{
						Project:     project,
						Wait:        true,
						WaitTimeout: 30 * time.Second,
					},
				})
			}
			if err := up(); err != nil {
				t.Fatal("compose proxy up:", err)
			}
			assertImportedAcceptanceImage(t, caseCtx, raw, imageName)
			pulls := counting.countPulls(imageName) - before
			if pulls != 1 {
				t.Fatalf("ImagePull count for %s = %d, want exactly one; refs=%v", tc.name, pulls, counting.pullRefs())
			}
			if !tc.explicitPull {
				if err := up(); err != nil {
					t.Fatal("compose proxy second up:", err)
				}
				wantPulls := 1
				if tc.pullPolicy == "always" {
					wantPulls = 2
				}
				if pulls := counting.countPulls(imageName) - before; pulls != wantPulls {
					t.Fatalf("ImagePull count for second %s up = %d, want %d; refs=%v", tc.name, pulls, wantPulls, counting.pullRefs())
				}
			}
			ps, err := waitAcceptanceProjectCount(caseCtx, service.Compose(), project, true, 1)
			if err != nil {
				t.Fatal("compose proxy ps after up:", err)
			}
			if len(ps) != 1 {
				t.Fatalf("compose proxy ps returned %d containers, want 1", len(ps))
			}
		})
	}
}

type acceptanceCountingClient struct {
	client.APIClient
	mu    sync.Mutex
	pulls []string
}

func (c *acceptanceCountingClient) ImagePull(ctx context.Context, ref string, opts imageTypes.PullOptions) (io.ReadCloser, error) {
	c.mu.Lock()
	c.pulls = append(c.pulls, ref)
	c.mu.Unlock()
	return c.APIClient.ImagePull(ctx, ref, opts)
}
func (c *acceptanceCountingClient) pullRefs() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.pulls...)
}

func (c *acceptanceCountingClient) countPulls(want string) int {
	count := 0
	for _, ref := range c.pullRefs() {
		if ref == want {
			count++
		}
	}
	return count
}

type acceptanceLogs struct {
	mu    sync.Mutex
	lines []string
}

func (l *acceptanceLogs) Log(container, message string)    { l.add(container, message) }
func (l *acceptanceLogs) Err(container, message string)    { l.add(container, message) }
func (l *acceptanceLogs) Status(container, message string) { l.add(container, message) }
func (l *acceptanceLogs) add(container, message string) {
	l.mu.Lock()
	l.lines = append(l.lines, container+": "+message)
	l.mu.Unlock()
}
func (l *acceptanceLogs) contains(want string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, want) {
			return true
		}
	}
	return false
}

type protectedAcceptanceState struct {
	containers map[string]protectedAcceptanceContainer
	imageID    string
	imageFound bool
}

type protectedAcceptanceContainer struct {
	id, image, state string
	names            string
}

func snapshotAcceptanceState(t *testing.T, ctx context.Context, dc client.APIClient) protectedAcceptanceState {
	t.Helper()
	state := protectedAcceptanceState{containers: make(map[string]protectedAcceptanceContainer)}
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true})
	if err != nil {
		t.Fatal("list protected containers:", err)
	}
	for _, c := range containers {
		state.containers[c.ID] = protectedAcceptanceContainer{id: c.ID, image: c.Image, state: c.State, names: strings.Join(c.Names, ",")}
	}
	inspect, _, err := dc.ImageInspectWithRaw(ctx, "phyless:latest")
	if err == nil {
		state.imageID, state.imageFound = inspect.ID, true
	} else if !errdefs.IsNotFound(err) {
		t.Fatal("inspect protected image phyless:latest:", err)
	}
	return state
}

func assertAcceptanceState(t *testing.T, ctx context.Context, dc client.APIClient, want protectedAcceptanceState) {
	t.Helper()
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true})
	if err != nil {
		t.Errorf("list protected containers after acceptance: %v", err)
		return
	}
	got := make(map[string]protectedAcceptanceContainer, len(containers))
	for _, c := range containers {
		got[c.ID] = protectedAcceptanceContainer{id: c.ID, image: c.Image, state: c.State, names: strings.Join(c.Names, ",")}
	}
	for id, expected := range want.containers {
		actual, ok := got[id]
		if !ok {
			t.Errorf("protected container %s disappeared", id)
			continue
		}
		if actual.image != expected.image || actual.state != expected.state || actual.names != expected.names {
			t.Errorf("protected container %s changed: got image=%s state=%s names=%s, want image=%s state=%s names=%s", id, actual.image, actual.state, actual.names, expected.image, expected.state, expected.names)
		}
	}
	inspect, _, err := dc.ImageInspectWithRaw(ctx, "phyless:latest")
	if !want.imageFound {
		if err == nil {
			t.Errorf("protected image phyless:latest was unexpectedly created")
		} else if !errdefs.IsNotFound(err) {
			t.Errorf("inspect protected image phyless:latest after acceptance: %v", err)
		}
	} else if err != nil {
		t.Errorf("protected image phyless:latest disappeared: %v", err)
	} else if inspect.ID != want.imageID {
		t.Errorf("protected image phyless:latest changed: got %s, want %s", inspect.ID, want.imageID)
	}
}

func acceptanceProjectName() string {
	if name := strings.TrimSpace(os.Getenv("PHYLESS_ACCEPTANCE_PROJECT")); acceptanceNameIsSafe(name) {
		return name
	}
	return fmt.Sprintf("phyless-acceptance-%d", time.Now().UnixNano())
}

func acceptanceNameIsSafe(name string) bool {
	if !strings.HasPrefix(name, "phyless-acceptance-") || len(name) > 63 {
		return false
	}
	for _, r := range name {
		if r != '-' && (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return len(name) > len("phyless-acceptance-")
}

func assertAcceptanceProjectUnused(t *testing.T, ctx context.Context, dc client.APIClient, projectName, builtRef string) {
	t.Helper()
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true})
	if err != nil {
		t.Fatal("list containers before acceptance:", err)
	}
	for _, c := range containers {
		if c.Labels[composeapi.ProjectLabel] == projectName {
			t.Fatalf("acceptance project %q already owns container %s", projectName, c.ID)
		}
		for _, name := range c.Names {
			if strings.HasPrefix(strings.TrimPrefix(name, "/"), projectName+"-") {
				t.Fatalf("acceptance project %q already has container %s", projectName, name)
			}
		}
	}
	networks, err := dc.NetworkList(ctx, networkTypes.ListOptions{Filters: acceptanceLabelFilter(projectName)})
	if err != nil {
		t.Fatal("list networks before acceptance:", err)
	}
	if len(networks) > 0 {
		t.Fatalf("acceptance project %q already owns %d networks", projectName, len(networks))
	}
	if _, err := dc.NetworkInspect(ctx, projectName+"_default", networkTypes.InspectOptions{}); err == nil {
		t.Fatalf("acceptance project network %q already exists", projectName+"_default")
	} else if !errdefs.IsNotFound(err) {
		t.Fatal("inspect acceptance network:", err)
	}
	volumes, err := dc.VolumeList(ctx, volume.ListOptions{Filters: acceptanceLabelFilter(projectName)})
	if err != nil {
		t.Fatal("list volumes before acceptance:", err)
	}
	if len(volumes.Volumes) > 0 {
		t.Fatalf("acceptance project %q already owns %d volumes", projectName, len(volumes.Volumes))
	}
	if _, err := dc.VolumeInspect(ctx, projectName+"_data"); err == nil {
		t.Fatalf("acceptance project volume %q already exists", projectName+"_data")
	} else if !errdefs.IsNotFound(err) {
		t.Fatal("inspect acceptance volume:", err)
	}
	if _, _, err := dc.ImageInspectWithRaw(ctx, builtRef); err == nil {
		t.Fatalf("acceptance image %q already exists", builtRef)
	} else if !errdefs.IsNotFound(err) {
		t.Fatal("inspect acceptance image:", err)
	}
}

const acceptanceBaseImage = "busybox@sha256:fd8d9aa63ba2f0982b5304e1ee8d3b90a210bc1ffb5314d980eb6962f1a9715d"

func writeAcceptanceProject(t *testing.T, dir, projectName, builtRef string) {
	t.Helper()
	compose := fmt.Sprintf(`name: %s
services:
  app:
    image: %s
    pull_policy: never
    command: ["sh", "-c", "echo app-ready; while true; do echo app-heartbeat; sleep 1; done"]
    healthcheck:
      test: ["CMD-SHELL", "true"]
      interval: 1s
      timeout: 1s
      retries: 10
    volumes:
      - data:/data
  worker:
    image: %s
    pull_policy: never
    profiles: [acceptance]
    command: ["sh", "-c", "echo worker-ready; while true; do echo worker-heartbeat; sleep 1; done"]
    depends_on:
      app:
        condition: service_healthy
  built:
    build:
      context: .
      dockerfile: Dockerfile
    image: %s
    pull_policy: never
    command: ["sh", "-c", "echo built-ready; while true; do echo built-heartbeat; sleep 1; done"]
    depends_on:
      app:
        condition: service_healthy
volumes:
  data:
`, projectName, acceptanceBaseImage, acceptanceBaseImage, builtRef)
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte(compose), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM "+acceptanceBaseImage+"\nRUN printf acceptance-built >/acceptance-marker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func acceptanceProxyProjectName(caseName string) string {
	return fmt.Sprintf("phyless-acceptance-proxy-%s-%d", caseName, time.Now().UnixNano())
}

func proxyImageName(registryURL, caseName string) string {
	parsed, err := url.Parse(registryURL)
	if err != nil || parsed.Host == "" {
		return "invalid-registry-url"
	}
	return fmt.Sprintf("%s/fixture/%s-%d:cached", parsed.Host, caseName, time.Now().UnixNano())
}

func writeAcceptanceProxyProject(t *testing.T, dir, projectName, imageName, pullPolicy string) {
	t.Helper()
	compose := fmt.Sprintf(`name: %s
services:
  app:
    image: %s
    pull_policy: %s
    command: ["sh", "-c", "echo proxy-ready; while true; do sleep 1; done"]
`, projectName, imageName, pullPolicy)
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte(compose), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertImportedAcceptanceImage(t *testing.T, ctx context.Context, dc client.APIClient, imageName string) {
	t.Helper()
	inspect, _, err := dc.ImageInspectWithRaw(ctx, imageName)
	if err != nil {
		t.Fatalf("inspect imported image %s: %v", imageName, err)
	}
	if inspect.ID == "" {
		t.Fatalf("imported image %s has no image ID", imageName)
	}
	for _, tag := range inspect.RepoTags {
		if tag == imageName {
			return
		}
	}
	t.Fatalf("imported image %s is missing generated tag: %v", imageName, inspect.RepoTags)
}

func waitAcceptanceProject(ctx context.Context, service composeapi.Compose, project *composetypes.Project, running bool) ([]composeapi.ContainerSummary, error) {
	return waitAcceptanceProjectCount(ctx, service, project, running, 3)
}

func waitAcceptanceProjectCount(ctx context.Context, service composeapi.Compose, project *composetypes.Project, running bool, want int) ([]composeapi.ContainerSummary, error) {
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		ps, err := service.Ps(ctx, project.Name, composeapi.PsOptions{Project: project, All: true})
		if err == nil && len(ps) == want && acceptanceStatesMatch(ps, running) {
			return ps, nil
		}
		select {
		case <-ctx.Done():
			if err != nil {
				return nil, err
			}
			return nil, ctx.Err()
		case <-deadline.C:
			if err != nil {
				return nil, err
			}
			return nil, fmt.Errorf("project state did not reach running=%v: %#v", running, ps)
		case <-tick.C:
		}
	}
}

func acceptanceStatesMatch(ps []composeapi.ContainerSummary, running bool) bool {
	for _, p := range ps {
		if (p.State == "running") != running {
			return false
		}
	}
	return true
}

func acceptanceLabelFilter(projectName string) filters.Args {
	return filters.NewArgs(filters.Arg("label", composeapi.ProjectLabel+"="+projectName))
}

func assertAcceptanceResources(t *testing.T, ctx context.Context, dc client.APIClient, projectName string) {
	t.Helper()
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true, Filters: acceptanceLabelFilter(projectName)})
	if err != nil {
		t.Fatal("list acceptance containers:", err)
	}
	if len(containers) != 3 {
		t.Fatalf("acceptance project owns %d containers, want 3", len(containers))
	}
	volumes, err := dc.VolumeList(ctx, volume.ListOptions{Filters: acceptanceLabelFilter(projectName)})
	if err != nil || len(volumes.Volumes) != 1 {
		t.Fatalf("acceptance project volumes = %d, err=%v", len(volumes.Volumes), err)
	}
	networks, err := dc.NetworkList(ctx, networkTypes.ListOptions{Filters: acceptanceLabelFilter(projectName)})
	if err != nil || len(networks) == 0 {
		t.Fatalf("acceptance project networks = %d, err=%v", len(networks), err)
	}
}

func cleanupAcceptanceProject(t *testing.T, dc client.APIClient, composeService composeapi.Compose, project *composetypes.Project, builtRef string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if composeService != nil && project != nil {
		if err := composeService.Down(ctx, project.Name, composeapi.DownOptions{Project: project}); err != nil && !errdefs.IsNotFound(err) {
			t.Errorf("acceptance compose down cleanup: %v", err)
		}
	}
	label := acceptanceLabelFilter(project.Name)
	containers, err := dc.ContainerList(ctx, containertypes.ListOptions{All: true, Filters: label})
	if err != nil {
		t.Errorf("list acceptance containers during cleanup: %v", err)
	}
	for _, c := range containers {
		if err := dc.ContainerRemove(ctx, c.ID, containertypes.RemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !errdefs.IsNotFound(err) {
			t.Errorf("remove acceptance container %s: %v", c.ID, err)
		}
	}
	networks, err := dc.NetworkList(ctx, networkTypes.ListOptions{Filters: label})
	if err != nil {
		t.Errorf("list acceptance networks during cleanup: %v", err)
	}
	for _, n := range networks {
		if err := dc.NetworkRemove(ctx, n.ID); err != nil && !errdefs.IsNotFound(err) {
			t.Errorf("remove acceptance network %s: %v", n.ID, err)
		}
	}
	volumes, err := dc.VolumeList(ctx, volume.ListOptions{Filters: label})
	if err != nil {
		t.Errorf("list acceptance volumes during cleanup: %v", err)
	}
	for _, v := range volumes.Volumes {
		if err := dc.VolumeRemove(ctx, v.Name, true); err != nil && !errdefs.IsNotFound(err) {
			t.Errorf("remove acceptance volume %s: %v", v.Name, err)
		}
	}
	if _, err := dc.ImageRemove(ctx, builtRef, imageTypes.RemoveOptions{Force: false, PruneChildren: false}); err != nil && !errdefs.IsNotFound(err) {
		t.Errorf("remove acceptance image %s: %v", builtRef, err)
	}
}
