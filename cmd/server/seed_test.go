package main

import (
	"path/filepath"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"phyless/internal/models"
	"phyless/internal/store"
)

func TestSeedAdminRequiresPasswordOnlyForEmptyStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	s := store.New(path)
	if err := seedAdmin(s, ""); err == nil {
		t.Fatal("expected first startup password requirement")
	}
	if err := s.Update(func(cfg *store.Config) error {
		cfg.Users = append(cfg.Users, models.User{ID: "existing", Username: "existing", Role: models.RoleAdmin})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := seedAdmin(s, ""); err != nil {
		t.Fatalf("existing store rejected without bootstrap password: %v", err)
	}
	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Users) != 1 || cfg.Users[0].ID != "existing" {
		t.Fatalf("existing users changed: %+v", cfg.Users)
	}
}

func TestSeedAdminHashesConfiguredPassword(t *testing.T) {
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	password := " configured-password "
	if err := seedAdmin(s, password); err != nil {
		t.Fatal(err)
	}
	cfg, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Users) != 1 || bcrypt.CompareHashAndPassword([]byte(cfg.Users[0].PasswordHash), []byte(password)) != nil {
		t.Fatalf("bootstrap password was not stored as a valid hash: %+v", cfg.Users)
	}
}
