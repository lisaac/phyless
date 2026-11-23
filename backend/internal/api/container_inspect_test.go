package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	"phyless/backend/internal/docker"
)

type netModeClient struct{ client.APIClient }

func (netModeClient) ContainerInspect(_ context.Context, id string, _ client.ContainerInspectOptions) (client.ContainerInspectResult, error) {
	mode := container.NetworkMode("bridge")
	if id == "app" {
		mode = "container:vpn-id"
	}
	return client.ContainerInspectResult{Container: container.InspectResponse{
		ID: id, Name: "/" + id, HostConfig: &container.HostConfig{NetworkMode: mode},
		Config: &container.Config{Image: "img"},
	}}, nil
}

func TestContainerInspectAddsNetworkContainerName(t *testing.T) {
	s := &Server{docker: &docker.Client{APIClient: netModeClient{}}}
	for id, want := range map[string]string{"app": "vpn-id", "solo": ""} {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", id)
		req := httptest.NewRequest(http.MethodGet, "/api/containers/"+id+"/inspect", nil)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		s.handleContainerInspect(rec, req)

		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["Id"] != id || body["Config"] == nil {
			t.Fatalf("%s: inspect fields lost: %v", id, body)
		}
		got, _ := body["NetworkContainerName"].(string)
		if got != want {
			t.Fatalf("%s: NetworkContainerName = %q, want %q", id, got, want)
		}
	}
}
