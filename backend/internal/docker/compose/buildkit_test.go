package compose

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/cli/cli/config/configfile"
)

func strp(s string) *string { return &s }

func TestSolveOptionsMapsComposeBuild(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	extra := t.TempDir()
	project := &composetypes.Project{
		Name:        "proj",
		Environment: composetypes.Mapping{"FROM_ENV": "resolved"},
		Services: composetypes.Services{
			"base": {Name: "base", WorkloadSpec: composetypes.WorkloadSpec{Build: &composetypes.BuildConfig{Context: dir}}},
		},
	}
	service := composetypes.ServiceConfig{
		Name:          "app",
		ContainerSpec: composetypes.ContainerSpec{Image: "registry.example/app:1"},
		WorkloadSpec: composetypes.WorkloadSpec{Build: &composetypes.BuildConfig{
			Context:            dir,
			Dockerfile:         "docker/Dockerfile.prod",
			Args:               composetypes.MappingWithEquals{"A": strp("1"), "FROM_ENV": nil, "UNSET": nil},
			Labels:             composetypes.Labels{"custom": "x"},
			Target:             "final",
			NoCache:            true,
			Pull:               true,
			Platforms:          composetypes.StringList{"linux/amd64", "linux/arm64"},
			Network:            "host",
			Privileged:         true,
			ExtraHosts:         composetypes.HostsList{"db": {"10.0.0.2"}},
			ShmSize:            1024,
			Ulimits:            map[string]*composetypes.UlimitsConfig{"nofile": {Soft: 10, Hard: 20}, "nproc": {Single: 5}},
			CacheFrom:          composetypes.StringList{"registry.example/cache", "type=local,src=/tmp/c"},
			Tags:               composetypes.StringList{"registry.example/app:latest", "registry.example/app:1"},
			AdditionalContexts: composetypes.Mapping{"dep": "service:base", "img": "docker-image://alpine", "src": extra},
		}},
	}
	opt, cleanup, err := solveOptions(project, service, configfile.New(""))
	defer cleanup()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"filename":           "Dockerfile.prod",
		"build-arg:A":        "1",
		"build-arg:FROM_ENV": "resolved",
		"label:custom":       "x",
		"target":             "final",
		"no-cache":           "",
		"image-resolve-mode": "pull",
		"platform":           "linux/amd64,linux/arm64",
		"multi-platform":     "true",
		"force-network-mode": "host",
		"add-hosts":          "db=10.0.0.2",
		"shm-size":           "1024",
		"ulimit":             "nofile=10:20,nproc=5:5",
		"context:dep":        "docker-image://proj-base",
		"context:img":        "docker-image://alpine",
		"context:src":        "local:ctx-src",
	}
	for k, v := range want {
		if got, ok := opt.FrontendAttrs[k]; !ok || got != v {
			t.Errorf("attr %s = %q (present %v), want %q", k, got, ok, v)
		}
	}
	if _, ok := opt.FrontendAttrs["build-arg:UNSET"]; ok {
		t.Error("unresolved build arg must not be sent")
	}
	if opt.FrontendAttrs["label:com.docker.compose.project"] != "proj" || opt.FrontendAttrs["label:com.docker.compose.service"] != "app" {
		t.Errorf("compose labels missing: %v", opt.FrontendAttrs)
	}
	for _, m := range []string{"context", "dockerfile", "ctx-src"} {
		if opt.LocalMounts[m] == nil {
			t.Errorf("local mount %q missing", m)
		}
	}
	if len(opt.Exports) != 1 || opt.Exports[0].Type != "moby" || opt.Exports[0].Attrs["name"] != "registry.example/app:1,registry.example/app:latest" {
		t.Errorf("exports = %+v", opt.Exports)
	}
	if !slices.Equal(opt.AllowedEntitlements, []string{"network.host", "security.insecure"}) {
		t.Errorf("entitlements = %v", opt.AllowedEntitlements)
	}
	if len(opt.CacheImports) != 2 || opt.CacheImports[0].Type != "registry" || opt.CacheImports[0].Attrs["ref"] != "registry.example/cache" ||
		opt.CacheImports[1].Type != "local" || opt.CacheImports[1].Attrs["src"] != "/tmp/c" {
		t.Errorf("cache imports = %+v", opt.CacheImports)
	}
	if len(opt.Session) != 1 {
		t.Errorf("want only the auth provider attached, got %d attachables", len(opt.Session))
	}
}

func TestSolveOptionsInlineAndRemote(t *testing.T) {
	project := &composetypes.Project{Name: "p"}
	inline := composetypes.ServiceConfig{Name: "a", WorkloadSpec: composetypes.WorkloadSpec{Build: &composetypes.BuildConfig{
		Context: t.TempDir(), DockerfileInline: "FROM scratch\n",
	}}}
	opt, cleanup, err := solveOptions(project, inline, configfile.New(""))
	if err != nil {
		t.Fatal(err)
	}
	if opt.FrontendAttrs["filename"] != "Dockerfile" || opt.LocalMounts["dockerfile"] == nil {
		t.Fatalf("inline dockerfile attrs = %v", opt.FrontendAttrs)
	}
	cleanup()

	remote := composetypes.ServiceConfig{Name: "b", WorkloadSpec: composetypes.WorkloadSpec{Build: &composetypes.BuildConfig{
		Context: "https://github.com/example/repo.git#main", Dockerfile: "Dockerfile.x",
	}}}
	opt, cleanup, err = solveOptions(project, remote, configfile.New(""))
	defer cleanup()
	if err != nil {
		t.Fatal(err)
	}
	if opt.FrontendAttrs["context"] != "https://github.com/example/repo.git#main" || opt.FrontendAttrs["filename"] != "Dockerfile.x" || len(opt.LocalMounts) != 0 {
		t.Fatalf("remote context attrs = %v mounts = %v", opt.FrontendAttrs, opt.LocalMounts)
	}
}

func TestSecretStoreUsesProjectDefinitionsOnly(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s")
	if err := os.WriteFile(file, []byte("from-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PHYLESS_HOST_ONLY", "host-secret")
	project := &composetypes.Project{
		Environment: composetypes.Mapping{"TOKEN": "from-env"},
		Secrets: composetypes.Secrets{
			"f": {File: file},
			"e": {Environment: "TOKEN"},
			"c": {Content: "inline"},
			"h": {Environment: "PHYLESS_HOST_ONLY"},
		},
	}
	store, err := secretStore(project, []composetypes.ServiceSecretConfig{{Source: "f"}, {Source: "e", Target: "renamed"}, {Source: "c"}})
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{"f": "from-file", "renamed": "from-env", "c": "inline"} {
		got, err := store.GetSecret(context.Background(), id)
		if err != nil || string(got) != want {
			t.Errorf("secret %s = %q, %v; want %q", id, got, err, want)
		}
	}
	if _, err := store.GetSecret(context.Background(), "missing"); err == nil {
		t.Error("unknown secret must fail")
	}
	// The project environment, not phyless's process environment, is the source.
	if _, err := secretStore(project, []composetypes.ServiceSecretConfig{{Source: "h"}}); err == nil {
		t.Error("secret from phyless's own environment must not resolve")
	}
}

func TestBuildOrderPutsServiceContextsFirst(t *testing.T) {
	svc := func(ctx composetypes.Mapping) composetypes.ServiceConfig {
		return composetypes.ServiceConfig{WorkloadSpec: composetypes.WorkloadSpec{Build: &composetypes.BuildConfig{AdditionalContexts: ctx}}}
	}
	project := &composetypes.Project{Services: composetypes.Services{
		"a": svc(composetypes.Mapping{"x": "service:b"}),
		"b": svc(composetypes.Mapping{"y": "service:c"}),
		"c": svc(nil),
	}}
	order, err := buildOrder(project, []string{"a", "b", "c"})
	if err != nil || !reflect.DeepEqual(order, []string{"c", "b", "a"}) {
		t.Fatalf("order = %v, %v", order, err)
	}
	// A dependency not being built is used as-is (its existing image).
	if order, err := buildOrder(project, []string{"a"}); err != nil || !reflect.DeepEqual(order, []string{"a"}) {
		t.Fatalf("partial order = %v, %v", order, err)
	}
	project.Services["c"] = svc(composetypes.Mapping{"z": "service:a"})
	if _, err := buildOrder(project, []string{"a", "b", "c"}); err == nil {
		t.Fatal("cycle must fail")
	}
}
