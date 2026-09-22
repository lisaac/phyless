package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	dockercompose "phyless/backend/internal/docker/compose"
	"phyless/backend/internal/models"
)

func TestCanBuildDoesNotMutateReturnedResults(t *testing.T) {
	cache := newBuildCapabilityCache()
	cache.entries["blocked"] = buildCacheEntry{canBuild: true}
	cache.inflight["blocked"] = struct{}{}
	s := &Server{composeRuntime: &dockercompose.Runtime{}, buildCache: cache}
	cache.mu.Lock() // Hold the worker until computeCanBuild has returned.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := s.computeCanBuild(ctx, []models.ComposeProject{{ID: "blocked"}})
	cache.mu.Unlock()
	// Exercise readers while the delayed worker completes; -race also checks ownership.
	deadline := time.Now().Add(50 * time.Millisecond)
	for time.Now().Before(deadline) {
		if result[0] {
			t.Fatal("a worker modified the returned snapshot")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCanBuildImmediatelyReloadsIncludedFiles(t *testing.T) {
	dir := t.TempDir()
	root, child := filepath.Join(dir, "compose.yaml"), filepath.Join(dir, "child.yaml")
	if err := os.WriteFile(root, []byte("name: cache-test\ninclude:\n  - child.yaml\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(child, []byte("services:\n  web:\n    image: busybox\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{composeRuntime: &dockercompose.Runtime{}, buildCache: newBuildCapabilityCache()}
	project := models.ComposeProject{ID: "p", BaseDir: dir, ComposeFile: root}
	if s.projectHasBuild(context.Background(), project) {
		t.Fatal("unexpected build")
	}
	if err := os.WriteFile(child, []byte("services:\n  web:\n    build: .\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if !s.projectHasBuild(context.Background(), project) {
		t.Fatal("cache ignored an included file change")
	}
}

func TestCanBuildEnvChangeAndGlobalWorkerLimit(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(root, []byte("name: cache-env\nservices:\n  web:\n    build: .\n    profiles: [build]\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{composeRuntime: &dockercompose.Runtime{}, buildCache: newBuildCapabilityCache()}
	p := models.ComposeProject{ID: "p", BaseDir: dir, ComposeFile: root}
	if s.projectHasBuild(context.Background(), p) {
		t.Fatal("unexpected default build profile")
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("COMPOSE_PROFILES=build\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if !s.projectHasBuild(context.Background(), p) {
		t.Fatal("new .env was not observed immediately")
	}
	for range cap(s.buildCache.slots) {
		s.buildCache.slots <- struct{}{}
	}
	defer func() {
		for range cap(s.buildCache.slots) {
			<-s.buildCache.slots
		}
	}()
	// Saturated checks reuse the known result and do not start more filesystem work.
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if !s.projectHasBuild(context.Background(), p) {
		t.Fatal("saturated check did not reuse cached result")
	}
}
