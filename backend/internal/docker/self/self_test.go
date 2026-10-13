package self

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
)

type statClient struct {
	client.APIClient
	ids   []string
	fs    map[string]string // container ID -> path present in it
	fail  string            // container ID whose stat fails transiently
	stats int
}

func (c *statClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	out := make([]container.Summary, len(c.ids))
	for i, id := range c.ids {
		out[i] = container.Summary{ID: id}
	}
	return out, nil
}

func (c *statClient) ContainerStatPath(_ context.Context, id, path string) (container.PathStat, error) {
	c.stats++
	if id == c.fail {
		return container.PathStat{}, errors.New("daemon busy")
	}
	if c.fs[id] == path {
		return container.PathStat{Name: filepath.Base(path)}, nil
	}
	return container.PathStat{}, errdefs.NotFound(os.ErrNotExist)
}

func TestInitAndID(t *testing.T) {
	ctx := context.Background()
	if id, err := ID(ctx, &statClient{ids: []string{"x"}}); id != "" || err != nil {
		t.Fatalf("no marker: ID = %q, %v", id, err)
	}

	dir := t.TempDir()
	t.Chdir(dir)
	stale := filepath.Join(dir, markerPrefix+"old")
	if err := os.WriteFile(stale, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	Init(filepath.Join(dir, "data"))
	t.Cleanup(func() { marker = "" })
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale marker kept: %v", err)
	}
	if filepath.Dir(marker) != dir {
		t.Fatalf("marker %q not in working directory", marker)
	}

	host, _ := os.Hostname()
	me := host + "-me" // Docker's default hostname is the short ID: tried first
	cli := &statClient{ids: []string{"other", "bare", me}, fs: map[string]string{me: marker, "other": stale}}
	if id, err := ID(ctx, cli); id != me || err != nil {
		t.Fatalf("ID = %q, %v", id, err)
	}
	if cli.stats != 1 {
		t.Fatalf("hostname match should be stat'ed first, got %d stats", cli.stats)
	}

	bare := &statClient{ids: []string{"a", "b"}, fs: map[string]string{"a": stale}}
	if id, err := ID(ctx, bare); id != "" || err != nil {
		t.Fatalf("bare: ID = %q, %v", id, err)
	}
	if _, err := ID(ctx, &statClient{ids: []string{"a"}, fail: "a"}); err == nil {
		t.Fatal("a transient stat error must not read as \"not ours\"")
	}
}
