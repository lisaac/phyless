package api

import (
	"context"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type autoUpdateClient struct{ updateCheckClient }

func (c *autoUpdateClient) ContainerInspect(ctx context.Context, id string) (container.InspectResponse, error) {
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
	io.WriteString(l, `{"status":"Downloading","progress":"[==>  ]","id":"abc"}`+"\n"+`{"stream":"hello"}`+"\n"+`{"error":"boom"}`+"\n")
	if strings.Join(l.lines, "|") != "hello|boom" {
		t.Fatalf("got %q", l.lines)
	}
}
