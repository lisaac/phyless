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

func TestCanBuildEventuallyReloadsIncludedFiles(t *testing.T) {
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
	s.buildCache.mu.Lock()
	entry := s.buildCache.entries["p"]
	entry.checkedAt = time.Now().Add(-buildCacheTTL - time.Second)
	s.buildCache.entries["p"] = entry
	s.buildCache.mu.Unlock()
	if !s.projectHasBuild(context.Background(), project) {
		t.Fatal("expired cache ignored an included file change")
	}
}
