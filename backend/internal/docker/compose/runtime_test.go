package compose

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/buildx/builder"
	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
)

type fakeAPIClient struct {
	client.APIClient
	host string
}

func (f *fakeAPIClient) DaemonHost() string    { return f.host }
func (f *fakeAPIClient) ClientVersion() string { return "1.49" }
func (f *fakeAPIClient) Ping(context.Context) (dockertypes.Ping, error) {
	return dockertypes.Ping{APIVersion: "1.49", OSType: "linux"}, nil
}
func (f *fakeAPIClient) NegotiateAPIVersionPing(dockertypes.Ping) {}

func newTestRuntime(t *testing.T) *Runtime {
	t.Helper()
	t.Setenv("COMPOSE_BAKE", "false")
	t.Setenv("BUILDX_BUILDER", "default")
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	t.Setenv("BUILDX_CONFIG", t.TempDir())
	runtime, err := NewRuntime(&fakeAPIClient{host: "unix:///var/run/docker.sock"})
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}

func TestRuntimeInitializesBuildxDependencies(t *testing.T) {
	runtime := newTestRuntime(t)
	service, err := runtime.NewService(context.Background(), ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if service.cli.ContextStore() == nil {
		t.Fatal("compose request CLI has no context store")
	}
	if service.cli.CurrentContext() != "default" {
		t.Fatalf("current context = %q, want default", service.cli.CurrentContext())
	}
	if service.cli.DockerEndpoint().Host != "unix:///var/run/docker.sock" {
		t.Fatalf("endpoint = %q, want injected daemon endpoint", service.cli.DockerEndpoint().Host)
	}

	// builder.New is the first buildx boundary used by Compose. This check is
	// intentionally against the request adapter: a nil ContextStore used to
	// panic here when only NewDockerCli(WithAPIClient(...)) was supplied.
	if _, err := builder.New(service.cli); err != nil && !strings.Contains(err.Error(), "no builder") {
		t.Fatalf("builder initialization failed: %v", err)
	}
}

func TestLoadProjectPreservesComposeLoaderSemantics(t *testing.T) {
	runtime := newTestRuntime(t)
	dir := t.TempDir()
	base := filepath.Join(dir, "compose.yaml")
	override := filepath.Join(dir, "compose.override.yaml")
	envFile := filepath.Join(dir, "stack.env")
	if err := os.WriteFile(base, []byte(`name: loader-test
services:
  api:
    image: "busybox:${IMAGE_TAG}"
    profiles: [dev]
  ops:
    image: busybox
    profiles: [ops]
  db:
    image: busybox
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(override, []byte(`services:
  db:
    environment:
      FROM_OVERRIDE: yes
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envFile, []byte("IMAGE_TAG=latest\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	project, err := runtime.LoadProject(context.Background(), ProjectOptions{
		WorkingDir:  dir,
		ConfigPaths: []string{"compose.yaml", "compose.override.yaml"},
		EnvFiles:    []string{"stack.env"},
		Environment: []string{"COMPOSE_PROFILES=dev"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "loader-test" {
		t.Fatalf("project name = %q", project.Name)
	}
	if got := project.Services["api"].Image; got != "busybox:latest" {
		t.Fatalf("interpolated image = %q", got)
	}
	if got := project.Services["db"].Environment["FROM_OVERRIDE"]; got == nil || *got != "yes" {
		t.Fatalf("override environment = %#v", got)
	}
	if got := project.Services["api"].CustomLabels["com.docker.compose.project.config_files"]; got != strings.Join([]string{base, override}, ",") {
		t.Fatalf("config files label = %q", got)
	}
	if got := project.Services["api"].CustomLabels["com.docker.compose.project.environment_file"]; got != envFile {
		t.Fatalf("environment file label = %q", got)
	}
	if _, ok := project.DisabledServices["ops"]; !ok {
		t.Fatal("ops service was not retained as disabled")
	}
}

func TestLoadProjectPreservesIncludeAndCreateHostPathSemantics(t *testing.T) {
	runtime := newTestRuntime(t)
	dir := t.TempDir()
	main := filepath.Join(dir, "compose.yaml")
	included := filepath.Join(dir, "included.yaml")
	if err := os.WriteFile(included, []byte(`services:
  included:
    image: busybox
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(main, []byte(`name: include-test
include:
  - included.yaml
services:
  app:
    image: busybox
    profiles: [ops]
    volumes:
      - type: bind
        source: ./default
        target: /default
      - type: bind
        source: ./created
        target: /created
        bind:
          create_host_path: true
      - type: bind
        source: ./existing
        target: /existing
        bind:
          create_host_path: false
`), 0o600); err != nil {
		t.Fatal(err)
	}
	project, err := runtime.LoadProject(context.Background(), ProjectOptions{
		WorkingDir:  dir,
		ConfigPaths: []string{"compose.yaml"},
		Environment: []string{"COMPOSE_PROFILES=ops"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := project.Services["included"]; !ok {
		t.Fatalf("include service missing: %#v", project.Services)
	}
	app, ok := project.Services["app"]
	if !ok {
		t.Fatal("profile-enabled app service missing")
	}
	if len(app.Volumes) != 3 {
		t.Fatalf("got %d app volumes, want 3", len(app.Volumes))
	}
	if app.Volumes[0].Bind != nil && app.Volumes[0].Bind.CreateHostPath {
		t.Fatalf("omitted create_host_path = %#v, want false for long syntax", app.Volumes[0].Bind)
	}
	if app.Volumes[1].Bind == nil || !app.Volumes[1].Bind.CreateHostPath {
		t.Fatalf("true create_host_path = %#v", app.Volumes[1].Bind)
	}
	if app.Volumes[2].Bind == nil || app.Volumes[2].Bind.CreateHostPath {
		t.Fatalf("false create_host_path = %#v", app.Volumes[2].Bind)
	}
}

func TestLoadProjectRejectsRemoteConfigSources(t *testing.T) {
	runtime := newTestRuntime(t)
	_, err := runtime.LoadProject(context.Background(), ProjectOptions{
		WorkingDir:  t.TempDir(),
		ConfigPaths: []string{"oci://registry.example/compose:latest"},
	})
	if err == nil || !strings.Contains(err.Error(), "remote Compose config source") {
		t.Fatalf("remote config error = %v", err)
	}
}

func TestServiceConfigUsesOnlyExplicitRegistryCredentials(t *testing.T) {
	runtime := newTestRuntime(t)
	service, err := runtime.NewService(context.Background(), ServiceOptions{
		AuthConfigs: map[string]registry.AuthConfig{
			"docker.io": {Username: "user", Password: "pass"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	config := service.ConfigFile()
	if config.CredentialsStore != "" || len(config.CredentialHelpers) != 0 {
		t.Fatalf("service config retained external credential stores: %#v", config)
	}
	if got := config.AuthConfigs["https://index.docker.io/v1/"]; got.Username != "user" || got.Password != "pass" {
		t.Fatalf("docker hub auth = %#v", got)
	}
}

func TestNewRuntimeRejectsImplicitAuthEnvironment(t *testing.T) {
	t.Setenv("COMPOSE_BAKE", "false")
	t.Setenv("BUILDX_BUILDER", "default")
	t.Setenv("DOCKER_AUTH_CONFIG", `{"auths":{}}`)
	if _, err := NewRuntime(&fakeAPIClient{host: "unix:///var/run/docker.sock"}); err == nil || !strings.Contains(err.Error(), "DOCKER_AUTH_CONFIG") {
		t.Fatalf("NewRuntime error = %v", err)
	}
}

func TestNewRuntimeDisablesImplicitBakeAtStartup(t *testing.T) {
	oldBake, hadBake := os.LookupEnv("COMPOSE_BAKE")
	oldBuilder, hadBuilder := os.LookupEnv("BUILDX_BUILDER")
	if err := os.Unsetenv("COMPOSE_BAKE"); err != nil {
		t.Fatal(err)
	}
	if err := os.Unsetenv("BUILDX_BUILDER"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if hadBake {
			_ = os.Setenv("COMPOSE_BAKE", oldBake)
		} else {
			_ = os.Unsetenv("COMPOSE_BAKE")
		}
		if hadBuilder {
			_ = os.Setenv("BUILDX_BUILDER", oldBuilder)
		} else {
			_ = os.Unsetenv("BUILDX_BUILDER")
		}
	})
	if _, err := NewRuntime(&fakeAPIClient{host: "unix:///var/run/docker.sock"}); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("COMPOSE_BAKE"); got != "false" {
		t.Fatalf("COMPOSE_BAKE = %q, want false", got)
	}
	if got := os.Getenv("BUILDX_BUILDER"); got != "default" {
		t.Fatalf("BUILDX_BUILDER = %q, want default", got)
	}
}

func TestNewRuntimeRejectsBakeAndNonDefaultBuilder(t *testing.T) {
	t.Run("bake", func(t *testing.T) {
		t.Setenv("COMPOSE_BAKE", "true")
		t.Setenv("BUILDX_BUILDER", "default")
		if _, err := NewRuntime(&fakeAPIClient{host: "unix:///var/run/docker.sock"}); err == nil || !strings.Contains(err.Error(), "COMPOSE_BAKE") {
			t.Fatalf("NewRuntime error = %v", err)
		}
	})
	t.Run("builder", func(t *testing.T) {
		t.Setenv("COMPOSE_BAKE", "false")
		t.Setenv("BUILDX_BUILDER", "remote-builder")
		if _, err := NewRuntime(&fakeAPIClient{host: "unix:///var/run/docker.sock"}); err == nil || !strings.Contains(err.Error(), "BUILDX_BUILDER") {
			t.Fatalf("NewRuntime error = %v", err)
		}
	})
}
