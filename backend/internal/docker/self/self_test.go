package self

import (
	"context"
	"errors"
	"io"
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

type helperClient struct {
	client.APIClient
	gone bool
}

func (c *helperClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	if c.gone {
		return container.InspectResponse{}, errdefs.NotFound(os.ErrNotExist)
	}
	return container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{
		ID: "h", State: &container.State{ExitCode: 1, FinishedAt: "t"},
	}}, nil
}

func (c *helperClient) ContainerLogs(context.Context, string, container.LogsOptions) (io.ReadCloser, error) {
	return nil, errors.New("no logs")
}

func (c *helperClient) ContainerRemove(context.Context, string, container.RemoveOptions) error {
	c.gone = true
	return nil
}

func TestLastResultSavesAndRemoves(t *testing.T) {
	ctx, dir := context.Background(), t.TempDir()
	cli := &helperClient{}
	if res, _ := LastResult(ctx, cli, dir); res.State != "failed" || !cli.gone {
		t.Fatalf("first read = %+v, removed = %v", res, cli.gone)
	}
	res, err := LastResult(ctx, cli, dir)
	if err != nil || res.State != "failed" || res.Finished != "t" {
		t.Fatalf("saved result = %+v, %v", res, err)
	}
	if res, _ := LastResult(ctx, cli, t.TempDir()); res.State != "none" {
		t.Fatalf("no helper, no file: %+v", res)
	}
}
