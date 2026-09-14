package store_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

func TestReadWriteRoundTrip(t *testing.T) {
	f := filepath.Join(t.TempDir(), "config.json")
	s := store.New(f)

	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Users == nil {
		t.Fatal("expected non-nil Users slice")
	}

	cfg.Users = append(cfg.Users, models.User{ID: "1", Username: "admin", Role: models.RoleAdmin})
	if err := s.Write(cfg); err != nil {
		t.Fatal(err)
	}

	cfg2, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg2.Users) != 1 || cfg2.Users[0].Username != "admin" {
		t.Fatalf("unexpected users: %+v", cfg2.Users)
	}

	// Verify file exists on disk
	if _, err := os.Stat(f); err != nil {
		t.Fatal("config file not created")
	}
}

func TestUpdateSerializesConcurrentChanges(t *testing.T) {
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := s.Update(func(cfg *store.Config) error {
		cfg.Users = append(cfg.Users, models.User{ID: "seed", Username: "seed", Role: models.RoleAdmin})
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	const updates = 32
	done := make(chan error, updates)
	for i := 0; i < updates; i++ {
		go func(i int) {
			done <- s.Update(func(cfg *store.Config) error {
				cfg.Users = append(cfg.Users, models.User{ID: fmt.Sprintf("u%d", i), Username: fmt.Sprintf("user%d", i), Role: models.RoleViewer})
				return nil
			})
		}(i)
	}
	for i := 0; i < updates; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(cfg.Users), updates+1; got != want {
		t.Fatalf("users = %d, want %d", got, want)
	}
}

func TestUpdateCallbackErrorKeepsPreviousConfig(t *testing.T) {
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := s.Write(&store.Config{Users: []models.User{{ID: "1", Username: "admin", Role: models.RoleAdmin}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(cfg *store.Config) error {
		cfg.Users[0].Username = "changed"
		return fmt.Errorf("stop")
	}); err == nil {
		t.Fatal("expected callback error")
	}
	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Users[0].Username != "admin" {
		t.Fatalf("config changed after failed update: %+v", cfg.Users[0])
	}
}

func TestReadMigratesLegacyDockerEndpoint(t *testing.T) {
	f := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(f, []byte(`{"docker":{"host":"tcp://docker.example:2375","tls":false}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s := store.New(f)
	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.DockerServers) != 1 || cfg.ActiveDockerServerID != models.LocalDockerServerID || cfg.DockerServers[0].Host != "tcp://docker.example:2375" {
		t.Fatalf("migrated Docker servers = %+v, active = %q", cfg.DockerServers, cfg.ActiveDockerServerID)
	}
	if err := s.Write(cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]json.RawMessage
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if _, exists := persisted["docker"]; exists {
		t.Fatalf("legacy Docker field was persisted: %s", data)
	}
}

func BenchmarkRead(b *testing.B) {
	for _, size := range []int{1, 1000} {
		b.Run(fmt.Sprintf("users-registries-%d", size), func(b *testing.B) {
			f := filepath.Join(b.TempDir(), "config.json")
			s := store.New(f)
			cfg := &store.Config{
				Users:      make([]models.User, size),
				Registries: make([]models.Registry, size),
			}
			for i := 0; i < size; i++ {
				cfg.Users[i] = models.User{ID: fmt.Sprintf("u%d", i), Username: fmt.Sprintf("user%d", i), PasswordHash: "hash", Role: models.RoleViewer}
				cfg.Registries[i] = models.Registry{ID: fmt.Sprintf("r%d", i), URL: "https://registry.example", Username: "user", PasswordEnc: "encrypted"}
			}
			if err := s.Write(cfg); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := s.Read(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
