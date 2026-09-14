package api

import (
	"path/filepath"
	"testing"

	"github.com/docker/docker/api/types/registry"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

func TestRegistryAuthSelection(t *testing.T) {
	s := &Server{store: store.New(filepath.Join(t.TempDir(), "config.json"))}
	password := "quote\"slash\\secret"
	if err := s.store.Write(&store.Config{Registries: []models.Registry{
		{ID: "hub", URL: "https://index.docker.io/v1/", Username: "user", PasswordEnc: encrypt(password)},
		{ID: "hub2", URL: "docker.io", Username: "another"},
		{ID: "private", URL: "registry.example:5000", Username: "private"},
	}}); err != nil {
		t.Fatal(err)
	}
	encoded, err := s.registryAuthForImage("alpine", "hub")
	if err != nil {
		t.Fatal(err)
	}
	auth, err := registry.DecodeAuthConfig(encoded)
	if err != nil || auth.Password != password || auth.ServerAddress != "docker.io" {
		t.Fatalf("auth roundtrip failed: %v", err)
	}
	if _, err := s.registryAuthForImage("registry-1.docker.io/library/alpine:latest", "hub"); err != nil {
		t.Fatalf("Docker Hub alias rejected: %v", err)
	}
	for _, tc := range []struct{ ref, id string }{{"alpine", "private"}, {"alpine", "unknown"}, {"BAD REF", ""}} {
		if _, err := s.registryAuthForImage(tc.ref, tc.id); err == nil {
			t.Fatalf("accepted %q/%q", tc.ref, tc.id)
		}
	}
	if _, err := s.composeRegistryAuth([]string{"hub", "hub2"}); err == nil {
		t.Fatal("accepted ambiguous accounts")
	}
	if auth, err := s.composeRegistryAuth([]string{"hub", "hub"}); err != nil || len(auth) != 1 {
		t.Fatalf("duplicate ID: %v", err)
	}
}

func TestRegistryURLAndAuditTarget(t *testing.T) {
	for _, raw := range []string{"registry.example", "https://registry.example/v2", "https://registry.example/v2/"} {
		if host, err := docker.RegistryHost(raw); err != nil || host != "registry.example" {
			t.Fatalf("host=%q err=%v", host, err)
		}
	}
	for _, raw := range []string{"registry.example:", "registry.example:0", "registry.example:70000", "https://user:password@registry.example", "registry.example/path"} {
		if _, err := docker.RegistryHost(raw); err == nil {
			t.Fatalf("accepted invalid registry address %q", raw)
		}
	}
	if got := safePullTarget("https://user:password@registry.example/image"); got != "<invalid image>" {
		t.Fatalf("unsafe audit target %q", got)
	}
}
