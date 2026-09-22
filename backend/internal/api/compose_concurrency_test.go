package api

import (
	"context"
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
