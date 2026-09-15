package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadJWTSecretPersistsGeneratedValue(t *testing.T) {
	dir := t.TempDir()
	first, err := loadJWTSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadJWTSecret(dir)
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
