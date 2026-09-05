package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadJWTSecretPersistsGeneratedValue(t *testing.T) {
	dir := t.TempDir()
	first, err := loadJWTSecret(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadJWTSecret(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) < 32 || !bytes.Equal(first, second) {
		t.Fatalf("generated secret was not reused")
	}
	info, err := os.Stat(filepath.Join(dir, jwtSecretFile))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("secret mode=%v", info.Mode().Perm())
	}
}

func TestLoadJWTSecretValidatesConfiguredValue(t *testing.T) {
	if _, err := loadJWTSecret(t.TempDir(), "short"); err == nil {
		t.Fatal("short configured secret accepted")
	}
	want := "0123456789abcdef0123456789abcdef"
	got, err := loadJWTSecret(t.TempDir(), want)
	if err != nil || string(got) != want {
		t.Fatalf("configured secret=%q err=%v", got, err)
	}
}
