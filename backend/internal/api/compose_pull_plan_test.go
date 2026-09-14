package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	dockercompose "phyless/backend/internal/docker/compose"
	"phyless/backend/internal/models"
)

func TestComposePullPlanClassifiesServices(t *testing.T) {
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	dir := t.TempDir()
	composeFile := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3.20\nRUN echo build\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(composeFile, []byte(`name: plan-test
services:
  web:
    image: nginx:1.27
    platform: linux/amd64
  db:
    image: postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000
  builder:
    build: .
    image: myapp:local
  builder2:
    build: .
    image: myapp2:local
`), 0o600); err != nil {
		t.Fatal(err)
	}
	p := models.ComposeProject{ID: "1", Name: "display", BaseDir: dir, ComposeFile: composeFile}
	server := newComposeDiscoveryServer(t, p, nil)
	runtime, err := dockercompose.NewRuntime(server.docker)
	if err != nil {
		t.Fatal(err)
	}
	server.composeRuntime = runtime

	req := httptest.NewRequest(http.MethodGet, "/api/compose/pull-plan?id=1", nil)
	res := httptest.NewRecorder()
	server.handleComposePullPlan(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}

	var body struct {
		Images []struct {
			Service  string `json:"service"`
			Ref      string `json:"ref"`
			Platform string `json:"platform"`
		} `json:"images"`
		Rejected []struct {
			Service string `json:"service"`
			Ref     string `json:"ref"`
			Reason  string `json:"reason"`
		} `json:"rejected"`
		BuildBases []struct {
			Service  string `json:"service"`
			Ref      string `json:"ref"`
			Platform string `json:"platform"`
		} `json:"build_bases"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if len(body.Images) != 1 || body.Images[0].Service != "web" || body.Images[0].Ref != "nginx:1.27" || body.Images[0].Platform != "linux/amd64" {
		t.Fatalf("images = %+v", body.Images)
	}
	reasons := map[string]string{}
	for _, r := range body.Rejected {
		reasons[r.Service] = r.Reason
	}
	if reasons["db"] != "digest" {
		t.Fatalf("db reason = %q, want digest", reasons["db"])
	}
	if reasons["builder"] != "build" {
		t.Fatalf("builder reason = %q, want build", reasons["builder"])
	}
	if reasons["builder2"] != "build" {
		t.Fatalf("builder2 reason = %q, want build", reasons["builder2"])
	}
	if len(body.BuildBases) != 1 || body.BuildBases[0].Service != "builder" || body.BuildBases[0].Ref != "alpine:3.20" {
		t.Fatalf("build bases = %+v", body.BuildBases)
	}
}
