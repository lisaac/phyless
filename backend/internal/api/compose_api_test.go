package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	dockercompose "phyless/backend/internal/docker/compose"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type composeDiscoveryClient struct {
	client.APIClient
	containers []container.Summary
	err        error
}

func (c *composeDiscoveryClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return c.containers, c.err
}

func (c *composeDiscoveryClient) DaemonHost() string    { return "unix:///var/run/docker.sock" }
func (c *composeDiscoveryClient) ClientVersion() string { return "1.49" }
func (c *composeDiscoveryClient) Ping(context.Context) (dockertypes.Ping, error) {
	return dockertypes.Ping{APIVersion: "1.49", OSType: "linux"}, nil
}
func (c *composeDiscoveryClient) NegotiateAPIVersionPing(dockertypes.Ping) {}

func newComposeDiscoveryServer(t *testing.T, p models.ComposeProject, containers []container.Summary) *Server {
	t.Helper()
	projectStore := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := projectStore.Write(&store.Config{ComposeProjects: []models.ComposeProject{p}}); err != nil {
		t.Fatal(err)
	}
	return &Server{
		store:  projectStore,
		docker: &composeDiscoveryClient{containers: containers},
	}
}

func composeSummary(name, project, configFiles, workingDir, envFile string) container.Summary {
	return container.Summary{
		Names: []string{"/" + name},
		State: "running",
		Labels: map[string]string{
			labelProject:         project,
			labelConfigFiles:     configFiles,
			labelWorkingDir:      workingDir,
			labelEnvironmentFile: envFile,
		},
	}
}

func TestResolveRegisteredComposeUsesRunningProjectLabels(t *testing.T) {
	dir := t.TempDir()
	mainFile := filepath.Join(dir, "compose.yaml")
	overrideFile := filepath.Join(dir, "override.yaml")
	envFile := filepath.Join(dir, "stack.env")
	p := models.ComposeProject{ID: "1", Name: "display name", BaseDir: dir, ComposeFile: mainFile}
	server := newComposeDiscoveryServer(t, p, []container.Summary{
		composeSummary("app", "actual-name", strings.Join([]string{mainFile, overrideFile}, ","), dir, envFile),
	})

	resolved, err := server.resolveCompose(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.display.Name != "display name" {
		t.Fatalf("display name = %q", resolved.display.Name)
	}
	if resolved.projectName != "actual-name" || resolved.effective.Name != "actual-name" {
		t.Fatalf("resolved project name = %q/%q", resolved.projectName, resolved.effective.Name)
	}
	if resolved.effective.ComposeFile != strings.Join([]string{mainFile, overrideFile}, ",") {
		t.Fatalf("resolved config files = %q", resolved.effective.ComposeFile)
	}
	if resolved.effective.EnvFile != envFile {
		t.Fatalf("resolved env file = %q", resolved.effective.EnvFile)
	}
}

func TestResolveRegisteredComposeRejectsAmbiguousRunningNames(t *testing.T) {
	dir := t.TempDir()
	mainFile := filepath.Join(dir, "compose.yaml")
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: mainFile}
	server := newComposeDiscoveryServer(t, p, []container.Summary{
		composeSummary("a", "first", mainFile, dir, ""),
		composeSummary("b", "second", mainFile, dir, ""),
	})

	_, err := server.resolveCompose(context.Background(), p.ID)
	var lookupErr *composeLookupError
	if !errors.As(err, &lookupErr) || lookupErr.status != http.StatusConflict {
		t.Fatalf("error = %v, want compose conflict", err)
	}
	if !strings.Contains(lookupErr.message, "first") || !strings.Contains(lookupErr.message, "second") {
		t.Fatalf("ambiguous error = %q", lookupErr.message)
	}
}

func TestResolveComposePropagatesDiscoveryFailure(t *testing.T) {
	dir := t.TempDir()
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: filepath.Join(dir, "compose.yaml")}
	server := newComposeDiscoveryServer(t, p, nil)
	server.docker = &composeDiscoveryClient{err: errors.New("daemon unavailable")}

	_, err := server.resolveCompose(context.Background(), p.ID)
	var lookupErr *composeLookupError
	if !errors.As(err, &lookupErr) || lookupErr.status != http.StatusServiceUnavailable {
		t.Fatalf("error = %v, want service unavailable", err)
	}
}

func TestListComposePropagatesDiscoveryFailure(t *testing.T) {
	dir := t.TempDir()
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: filepath.Join(dir, "compose.yaml")}
	server := newComposeDiscoveryServer(t, p, nil)
	server.docker = &composeDiscoveryClient{err: errors.New("daemon unavailable")}
	res := httptest.NewRecorder()
	server.handleListCompose(res, httptest.NewRequest(http.MethodGet, "/api/compose", nil))
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestComposeDetailIncludesDisabledServicesAndProjectName(t *testing.T) {
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	dir := t.TempDir()
	composeFile := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(composeFile, []byte(`name: detail-test
services:
  app:
    image: busybox
  debug:
    image: busybox
    profiles: [debug]
`), 0o600); err != nil {
		t.Fatal(err)
	}
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: composeFile}
	server := newComposeDiscoveryServer(t, p, nil)
	runtime, err := dockercompose.NewRuntime(server.docker)
	if err != nil {
		t.Fatal(err)
	}
	server.composeRuntime = runtime
	req := httptest.NewRequest(http.MethodGet, "/api/compose/detail?id=1", nil)
	res := httptest.NewRecorder()
	server.handleGetCompose(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Name        string                                `json:"name"`
		ProjectName string                                `json:"project_name"`
		Services    map[string]composetypes.ServiceConfig `json:"services"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "display" || body.ProjectName != "detail-test" {
		t.Fatalf("names = %q/%q", body.Name, body.ProjectName)
	}
	if _, ok := body.Services["app"]; !ok {
		t.Fatal("active service missing")
	}
	if _, ok := body.Services["debug"]; !ok {
		t.Fatal("disabled service missing")
	}
}

func TestComposeDetailMissingRunningFileReturnsMetadata(t *testing.T) {
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	dir := t.TempDir()
	composeFile := filepath.Join(dir, "compose.yaml")
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: composeFile}
	server := newComposeDiscoveryServer(t, p, []container.Summary{
		composeSummary("app", "actual-name", composeFile, dir, ""),
	})
	runtime, err := dockercompose.NewRuntime(server.docker)
	if err != nil {
		t.Fatal(err)
	}
	server.composeRuntime = runtime
	req := httptest.NewRequest(http.MethodGet, "/api/compose/detail?id=1", nil)
	res := httptest.NewRecorder()
	server.handleGetCompose(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		ProjectName string                                `json:"project_name"`
		LoadError   string                                `json:"load_error"`
		Services    map[string]composetypes.ServiceConfig `json:"services"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ProjectName != "actual-name" || body.LoadError == "" {
		t.Fatalf("fallback detail = %#v", body)
	}
	if len(body.Services) != 0 {
		t.Fatalf("fallback services = %#v, want empty", body.Services)
	}
}

func TestComposeOperationValidationBoundaries(t *testing.T) {
	project := &composetypes.Project{Services: map[string]composetypes.ServiceConfig{
		"builder": {Name: "builder", Build: &composetypes.BuildConfig{Context: "."}},
	}}
	proxied, err := docker.WithPullProxy(context.Background(), "http://proxy.example:8080")
	if err != nil {
		t.Fatal(err)
	}
	// up/build with a proxy are allowed: base images are pre-pulled through the
	// proxy before an offline build; pull skips build services (IgnoreBuildable).
	for _, op := range []string{"up", "build", "pull"} {
		if err := validateComposeOperation(proxied, op, project); err != nil {
			t.Fatalf("proxy %s validation = %v, want nil", op, err)
		}
	}
	if err := validateComposeOperation(context.Background(), "up", &composetypes.Project{Services: map[string]composetypes.ServiceConfig{
		"provider": {Name: "provider", Provider: &composetypes.ServiceProviderConfig{Type: "terraform"}},
	}}); err == nil || !strings.Contains(err.Error(), "external provider") {
		t.Fatalf("provider validation = %v", err)
	}
	if err := validateComposeOperation(context.Background(), "up", &composetypes.Project{Services: map[string]composetypes.ServiceConfig{
		"remote": {Name: "remote", Build: &composetypes.BuildConfig{Context: ".", AdditionalContexts: map[string]string{"source": "git://example/repo"}}},
	}}); err == nil || !strings.Contains(err.Error(), "remote additional context") {
		t.Fatalf("remote context validation = %v", err)
	}
	if err := validateComposeOperation(context.Background(), "up", &composetypes.Project{
		Services:         map[string]composetypes.ServiceConfig{"app": {Name: "app"}},
		DisabledServices: map[string]composetypes.ServiceConfig{"builder": {Name: "builder", Build: &composetypes.BuildConfig{Context: "git://example/repo"}}},
	}); err != nil {
		t.Fatalf("disabled build validation = %v", err)
	}
	// build with a proxy is allowed (pre-pull path), but remote build contexts
	// remain unsupported regardless of proxy.
	if err := validateComposeOperation(proxied, "build", project); err != nil {
		t.Fatalf("proxy build validation = %v, want nil", err)
	}
	if err := validateComposeOperation(context.Background(), "build", &composetypes.Project{Services: map[string]composetypes.ServiceConfig{
		"remote": {Name: "remote", Build: &composetypes.BuildConfig{Context: "git://example/repo"}},
	}}); err == nil || !strings.Contains(err.Error(), "remote build context") {
		t.Fatalf("remote build context validation = %v", err)
	}
}

func TestListComposeReportsCanBuild(t *testing.T) {
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	writeCompose := func(body string) (dir, file string) {
		dir = t.TempDir()
		file = filepath.Join(dir, "compose.yaml")
		if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return dir, file
	}
	buildDir, buildFile := writeCompose("services:\n  app:\n    build: .\n")
	imageDir, imageFile := writeCompose("services:\n  app:\n    image: busybox\n")

	projectStore := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := projectStore.Write(&store.Config{ComposeProjects: []models.ComposeProject{
		{ID: "build", Name: "with-build", BaseDir: buildDir, ComposeFile: buildFile},
		{ID: "image", Name: "image-only", BaseDir: imageDir, ComposeFile: imageFile},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{store: projectStore, docker: &composeDiscoveryClient{}, buildCache: newBuildCapabilityCache()}
	runtime, err := dockercompose.NewRuntime(server.docker)
	if err != nil {
		t.Fatal(err)
	}
	server.composeRuntime = runtime

	res := httptest.NewRecorder()
	server.handleListCompose(res, httptest.NewRequest(http.MethodGet, "/api/compose", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var out []ComposeInfo
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	canBuild := map[string]bool{}
	for _, info := range out {
		canBuild[info.ID] = info.CanBuild
	}
	if !canBuild["build"] {
		t.Errorf("with-build can_build = false, want true")
	}
	if canBuild["image"] {
		t.Errorf("image-only can_build = true, want false")
	}
}

func TestComposeOperationLockIsPerProjectAndRejectsDuplicates(t *testing.T) {
	release, acquired := tryComposeOperation("Project-A")
	if !acquired {
		t.Fatal("first operation was not acquired")
	}
	defer release()
	if _, acquired := tryComposeOperation("project-a"); acquired {
		t.Fatal("duplicate operation acquired the same project")
	}
	otherRelease, acquired := tryComposeOperation("project-b")
	if !acquired {
		t.Fatal("different project was blocked")
	}
	otherRelease()
}

func TestComposeFileMissingFallbackRequiresRunningLabel(t *testing.T) {
	resolved := composeResolution{effective: models.ComposeProject{Name: "actual"}, running: true}
	if !composeCanUseRunningFallback("stop", resolved, os.ErrNotExist) {
		t.Fatal("stop did not allow trusted running-label fallback")
	}
	if !composeCanUseRunningFallback("pause", resolved, os.ErrNotExist) {
		t.Fatal("pause did not allow trusted running-label fallback")
	}
	if composeCanUseRunningFallback("up", resolved, os.ErrNotExist) {
		t.Fatal("up allowed missing-file fallback")
	}
	if composeCanUseRunningFallback("stop", composeResolution{effective: models.ComposeProject{Name: "actual"}}, os.ErrNotExist) {
		t.Fatal("unresolved project allowed missing-file fallback")
	}
}

func TestFindRegisteredComposeWorksWithoutDaemon(t *testing.T) {
	dir := t.TempDir()
	project := models.ComposeProject{
		ID:          "1",
		Name:        "offline",
		BaseDir:     dir,
		ComposeFile: filepath.Join(dir, "compose.yaml"),
	}
	server := newComposeDiscoveryServer(t, project, nil)
	server.docker = &composeDiscoveryClient{err: errors.New("daemon unavailable")}

	got, err := server.findCompose(context.Background(), project.ID)
	if err != nil {
		t.Fatalf("registered project lookup failed while daemon was offline: %v", err)
	}
	if got.ID != project.ID || got.ComposeFile != project.ComposeFile {
		t.Fatalf("project = %#v, want %#v", got, project)
	}
}

func TestComposeFileLookupStoreFailureIsInternalServerError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	server := &Server{store: store.New(path)}
	req := httptest.NewRequest(http.MethodGet, "/api/compose/files?id=registered", nil)
	res := httptest.NewRecorder()
	server.handleComposeListFiles(res, req)
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s; want 500 for store failure", res.Code, res.Body.String())
	}
}

// composePullClient lets the real Compose v2 Pull path run against a fake
// daemon and records whether the request-scoped proxy reached ImagePull.
type composePullClient struct {
	*composeDiscoveryClient
	pulled  bool
	proxied bool
}

func (c *composePullClient) ServerVersion(context.Context) (dockertypes.Version, error) {
	return dockertypes.Version{APIVersion: "1.49"}, nil
}

func (c *composePullClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	if !c.pulled {
		return image.InspectResponse{}, errdefs.NotFound(errors.New("no such image"))
	}
	return image.InspectResponse{ID: "sha256:pulled", Created: "2026-01-01T00:00:00Z"}, nil
}

func (c *composePullClient) ImagePull(ctx context.Context, _ string, _ image.PullOptions) (io.ReadCloser, error) {
	c.pulled = true
	c.proxied = docker.HasPullProxy(ctx)
	return io.NopCloser(strings.NewReader(`{"status":"done"}` + "\n")), nil
}

func newComposePullServer(t *testing.T) (*Server, *composePullClient) {
	t.Helper()
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	dir := t.TempDir()
	composeFile := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(composeFile, []byte("name: pull-test\nservices:\n  app:\n    image: registry.example/app:latest\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := newComposeDiscoveryServer(t, models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: composeFile}, nil)
	fake := &composePullClient{composeDiscoveryClient: server.docker.(*composeDiscoveryClient)}
	server.docker = fake
	server.audit = audit.New(filepath.Join(dir, "audit.log"))
	runtime, err := dockercompose.NewRuntime(fake)
	if err != nil {
		t.Fatal(err)
	}
	server.composeRuntime = runtime
	return server, fake
}

func TestComposePullForwardsProxyContextToImagePull(t *testing.T) {
	server, fake := newComposePullServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/compose/pull?id=1", strings.NewReader(`{"proxy_url":"http://proxy.example:8080"}`))
	res := httptest.NewRecorder()
	server.handleComposePull(res, req)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), `"error"`) {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !fake.pulled || !fake.proxied {
		t.Fatalf("pulled=%v proxied=%v: proxy context did not reach ImagePull", fake.pulled, fake.proxied)
	}
}

func TestComposeUpPullPolicyOption(t *testing.T) {
	for _, tc := range []struct {
		policy   string
		wantCode int
		want     string
	}{
		{"", http.StatusOK, ""},
		{"missing", http.StatusOK, "missing"},
		{"always", http.StatusOK, "always"},
		{"never", http.StatusOK, "never"},
		{"bogus", http.StatusBadRequest, "bogus"}, // helper is blind; composeRequest rejects it
	} {
		t.Run("policy="+tc.policy, func(t *testing.T) {
			project := &composetypes.Project{Services: composetypes.Services{"app": {Name: "app", Image: "busybox"}}}
			applyComposePullPolicy(project, tc.policy)
			if got := project.Services["app"].PullPolicy; got != tc.want {
				t.Fatalf("PullPolicy = %q, want %q", got, tc.want)
			}
			if tc.wantCode != http.StatusBadRequest {
				return // a full Up needs a daemon; the helper above is the whole override
			}
			server, _ := newComposePullServer(t)
			req := httptest.NewRequest(http.MethodPost, "/api/compose/up?id=1", strings.NewReader(`{"pull_policy":"`+tc.policy+`"}`))
			res := httptest.NewRecorder()
			server.handleComposeUp(res, req)
			if res.Code != tc.wantCode || !strings.Contains(res.Body.String(), "pull_policy") {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}
