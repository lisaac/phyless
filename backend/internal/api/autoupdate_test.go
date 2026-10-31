package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type autoUpdateClient struct{ updateCheckClient }

func (c *autoUpdateClient) ContainerInspect(ctx context.Context, id string) (container.InspectResponse, error) {
	if id == "gone" {
		return container.InspectResponse{}, errdefs.NotFound(errors.New("no such container"))
	}
	ref := id
	if id == "web" || id == "svc" {
		ref = "a"
	}
	info, err := c.updateCheckClient.ContainerInspect(ctx, ref)
	if id == "svc" {
		info.Config.Labels = map[string]string{labelProject: "stack"}
	}
	return info, err
}

func TestRunAutoUpdateRecordsOutcome(t *testing.T) {
	prev := resolveRemoteDigest
	resolveRemoteDigest = func(context.Context, *http.Transport, string, string) (docker.RemoteImage, error) {
		return docker.RemoteImage{Digest: "sha256:cur"}, nil
	}
	t.Cleanup(func() { resolveRemoteDigest = prev })
	dir := t.TempDir()
	s := &Server{docker: &autoUpdateClient{}, store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(filepath.Join(dir, "audit.log"))}
	policies := []models.AutoUpdatePolicy{
		{ID: "1", Kind: "container", Target: "web", Mode: "update"},
		{ID: "2", Kind: "container", Target: "svc", Mode: "update"},
	}
	if err := s.store.Update(func(c *store.Config) error { c.AutoUpdates = policies; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, p := range policies {
		s.runAutoUpdate(context.Background(), p, io.Discard)
	}
	cfg, _ := s.store.Read()
	web, svc := cfg.AutoUpdates[0], cfg.AutoUpdates[1]
	if web.LastStatus != autoLatest || web.LastRunAt == nil || len(web.LastLog) != 1 {
		t.Errorf("web: %+v", web)
	}
	if svc.LastStatus != autoSkipped || !strings.Contains(svc.LastError, "stack") {
		t.Errorf("compose-managed container must be skipped: %+v", svc)
	}
}

func TestAutoUpdateLogKeepsTextTail(t *testing.T) {
	l := &autoUpdateLog{dst: io.Discard}
	io.WriteString(l, `{"status":"Downloading","progress":"[==>  ]","id":"abc"}`+"\n"+`{"stream":"hello"}`+"\n"+`{"error":"bo`)
	io.WriteString(l, `om"}`+"\n")
	for i := 0; i < autoLogLines+5; i++ {
		io.WriteString(l, `{"stream":"x"}`+"\n")
	}
	if len(l.lines) != autoLogLines || l.lines[0] != "x" {
		t.Fatalf("tail not bounded: %d %q", len(l.lines), l.lines[0])
	}
	l = &autoUpdateLog{dst: io.Discard}
	io.WriteString(l, `{"status":"Downloading","progress":"[==>  ]","id":"abc"}`+"\n"+`{"status":"Pull complete","id":"abc"}`+"\n"+
		`{"stream":"hello"}`+"\n"+`{"status":"Status: Downloaded newer image for a:1"}`+"\n"+`{"error":"boom"}`+"\n")
	if strings.Join(l.lines, "|") != "hello|Status: Downloaded newer image for a:1|boom" {
		t.Fatalf("got %q", l.lines)
	}
}

type cleanupClient struct {
	client.APIClient
	removed []string
}

func (*cleanupClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return []container.Summary{{ImageID: "sha256:used"}}, nil
}

func (*cleanupClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: id, RepoTags: map[string][]string{"sha256:tagged": {"app:v1"}}[id]}, nil
}

func (c *cleanupClient) ImageRemove(_ context.Context, id string, _ image.RemoveOptions) ([]image.DeleteResponse, error) {
	c.removed = append(c.removed, id)
	return nil, nil
}

// An old image that is still used or still tagged is never removed.
func TestRemoveUnusedImagesKeepsUsedAndTagged(t *testing.T) {
	c := &cleanupClient{}
	var out strings.Builder
	(&Server{docker: c}).removeUnusedImages(context.Background(), []string{"sha256:used", "sha256:tagged"}, &out)
	if len(c.removed) != 0 {
		t.Fatalf("removed %v\n%s", c.removed, out.String())
	}
	if !strings.Contains(out.String(), "app:v1") {
		t.Errorf("missing note: %s", out.String())
	}
}

func TestAutoUpdateMissingFollowAndInterrupted(t *testing.T) {
	dir := t.TempDir()
	s := &Server{docker: &autoUpdateClient{}, store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(filepath.Join(dir, "audit.log")), serverID: "srv"}
	policies := []models.AutoUpdatePolicy{
		{ID: "1", ServerID: "srv", Kind: "container", Target: "gone", Mode: "update"},
		{ID: "2", ServerID: "srv", Kind: "container", Target: "old", Mode: "update", LastStatus: autoRunning, LastUpdateStatus: autoRunning, LastUpdateMessage: "x"},
		{ID: "3", ServerID: "srv", Kind: "compose", Target: "stack", Mode: "check"},
		{ID: "4", ServerID: "other", Kind: "container", Target: "old", LastStatus: autoRunning},
	}
	if err := s.store.Update(func(c *store.Config) error { c.AutoUpdates = policies; return nil }); err != nil {
		t.Fatal(err)
	}
	get := func(id string) models.AutoUpdatePolicy {
		cfg, _ := s.store.Read()
		for _, p := range cfg.AutoUpdates {
			if p.ID == id {
				return p
			}
		}
		return models.AutoUpdatePolicy{}
	}

	// A missing target is recorded, never deleted; the first sighting sticks.
	s.runAutoUpdate(context.Background(), policies[0], io.Discard)
	first := get("1")
	if first.LastStatus != autoMissing || first.MissingSince == nil || first.LastUpdateStatus != "" {
		t.Fatalf("missing: %+v", first)
	}
	s.runAutoUpdate(context.Background(), policies[0], io.Discard)
	if again := get("1"); again.ID == "" || !again.MissingSince.Equal(*first.MissingSince) {
		t.Fatalf("missing_since must stay at the first sighting: %+v", again)
	}

	// Only this server's leftover "running" runs are settled.
	s.markInterruptedAutoUpdates()
	if p := get("2"); p.LastStatus != autoInterrupted || p.LastUpdateStatus != autoInterrupted || !strings.HasPrefix(p.LastUpdateMessage, "x；") {
		t.Fatalf("interrupted: %+v", p)
	}
	if p := get("4"); p.LastStatus != autoRunning {
		t.Fatalf("other server touched: %+v", p)
	}

	// Rename in phyless moves the policy; delete in phyless drops it.
	s.followAutoUpdate("container", "old", "new")
	if p := get("2"); p.Target != "new" {
		t.Fatalf("rename: %+v", p)
	}
	if p := get("4"); p.Target != "old" {
		t.Fatalf("rename crossed servers: %+v", p)
	}
	s.followAutoUpdate("compose", "stack", "")
	if p := get("3"); p.ID != "" {
		t.Fatalf("delete kept policy: %+v", p)
	}
}

func TestAutoUpdateRecordsUpdateAttempt(t *testing.T) {
	prev := resolveRemoteDigest
	resolveRemoteDigest = func(context.Context, *http.Transport, string, string) (docker.RemoteImage, error) {
		return docker.RemoteImage{Digest: "sha256:newer"}, nil
	}
	t.Cleanup(func() { resolveRemoteDigest = prev })
	dir := t.TempDir()
	s := &Server{docker: &autoUpdateClient{}, store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(filepath.Join(dir, "audit.log"))}
	p := models.AutoUpdatePolicy{ID: "1", Kind: "container", Target: "web", Mode: "update"}
	if err := s.store.Update(func(c *store.Config) error { c.AutoUpdates = []models.AutoUpdatePolicy{p}; return nil }); err != nil {
		t.Fatal(err)
	}
	// The fake cannot pull, so the upgrade fails after the attempt began.
	s.runAutoUpdate(context.Background(), p, io.Discard)
	cfg, _ := s.store.Read()
	got := cfg.AutoUpdates[0]
	if got.LastUpdateStatus != autoFailed || got.LastUpdateAt == nil || !strings.Contains(got.LastUpdateMessage, "nginx:latest") || !strings.Contains(got.LastUpdateMessage, "失败") {
		t.Fatalf("update attempt: %+v", got)
	}
}
