package store_test

import (
	"os"
	"path/filepath"
	"testing"

	"phyless/internal/models"
	"phyless/internal/store"
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
