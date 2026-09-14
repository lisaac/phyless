package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"phyless/internal/auth"
	"phyless/internal/models"
	"phyless/internal/store"
)

func TestDockerRuntimeSwitchesActiveServer(t *testing.T) {
	first := dockerAPITestServer("first")
	second := dockerAPITestServer("second")
	t.Cleanup(first.Close)
	t.Cleanup(second.Close)
	handler, config, tokens := newDockerRuntimeForTest(t, first.URL, second.URL)

	if body := runtimeContainers(t, handler, tokens[models.RoleViewer]); !strings.Contains(body, "first") {
		t.Fatalf("initial containers = %s", body)
	}
	selectRequest := httptest.NewRequest(http.MethodPost, "/api/settings/docker/servers/second/select", nil)
	selectRequest.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	selectResponse := httptest.NewRecorder()
	handler.ServeHTTP(selectResponse, selectRequest)
	if selectResponse.Code != http.StatusNoContent {
		t.Fatalf("select status = %d, body=%s", selectResponse.Code, selectResponse.Body.String())
	}
	if cfg, err := config.Read(); err != nil {
		t.Fatal(err)
	} else if cfg.ActiveDockerServerID != "second" {
		t.Fatalf("active Docker server = %q", cfg.ActiveDockerServerID)
	}
	if body := runtimeContainers(t, handler, tokens[models.RoleViewer]); !strings.Contains(body, "second") {
		t.Fatalf("containers after switch = %s", body)
	}
}

func TestDockerRuntimeSwitchCancelsPreviousRequests(t *testing.T) {
	started := make(chan struct{}, 1)
	first := blockedDockerAPITestServer(started)
	second := dockerAPITestServer("second")
	t.Cleanup(first.Close)
	t.Cleanup(second.Close)
	handler, _, tokens := newDockerRuntimeForTest(t, first.URL, second.URL)

	previousDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := httptest.NewRequest(http.MethodGet, "/api/containers", nil)
		request.Header.Set("Authorization", "Bearer "+tokens[models.RoleViewer])
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		previousDone <- response
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("previous Docker request did not start")
	}

	selectRequest := httptest.NewRequest(http.MethodPost, "/api/settings/docker/servers/second/select", nil)
	selectRequest.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	selectResponse := httptest.NewRecorder()
	handler.ServeHTTP(selectResponse, selectRequest)
	if selectResponse.Code != http.StatusNoContent {
		t.Fatalf("select status = %d, body=%s", selectResponse.Code, selectResponse.Body.String())
	}
	select {
	case response := <-previousDone:
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("canceled request status = %d, body=%s", response.Code, response.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("previous Docker request was not canceled")
	}
	if body := runtimeContainers(t, handler, tokens[models.RoleViewer]); !strings.Contains(body, "second") {
		t.Fatalf("containers after switch = %s", body)
	}
}

func newDockerRuntimeForTest(t *testing.T, firstURL, secondURL string) (http.Handler, *store.Store, map[models.Role]string) {
	t.Helper()
	t.Setenv("DOCKER_CONFIG", t.TempDir())
	t.Setenv("COMPOSE_BAKE", "false")
	t.Setenv("BUILDX_BUILDER", "default")
	secret := []byte("runtime-switch-secret")
	users := []models.User{
		{ID: "viewer", Username: "viewer", Role: models.RoleViewer},
		{ID: "admin", Username: "admin", Role: models.RoleAdmin},
	}
	config := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := config.Write(&store.Config{
		Users: users,
		DockerServers: []models.DockerServer{
			{ID: "first", Name: "First", DockerEndpoint: models.DockerEndpoint{Host: dockerEndpointURL(firstURL)}},
			{ID: "second", Name: "Second", DockerEndpoint: models.DockerEndpoint{Host: dockerEndpointURL(secondURL)}},
		},
		ActiveDockerServerID: "first",
	}); err != nil {
		t.Fatal(err)
	}
	handler := New(config, secret, t.TempDir())
	runtime, ok := handler.(*dockerRuntime)
	if !ok {
		t.Fatalf("handler = %T, want *dockerRuntime", handler)
	}
	t.Cleanup(runtime.close)
	tokens := make(map[models.Role]string, len(users))
	for _, user := range users {
		token, err := auth.GenerateTokenWithVersion(user.ID, user.Username, user.Role, user.TokenVersion, secret)
		if err != nil {
			t.Fatal(err)
		}
		tokens[user.Role] = token
	}
	return handler, config, tokens
}

func runtimeContainers(t *testing.T, handler http.Handler, token string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/containers", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("containers status = %d, body=%s", response.Code, response.Body.String())
	}
	return response.Body.String()
}

func dockerAPITestServer(name string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(request.URL.Path, "/_ping"):
			w.Header().Set("Api-Version", "1.49")
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(request.URL.Path, "/version"):
			_ = json.NewEncoder(w).Encode(map[string]string{"ApiVersion": "1.49", "MinAPIVersion": "1.24", "Version": "27.0.0"})
		case strings.HasSuffix(request.URL.Path, "/containers/json"):
			if request.URL.Query().Get("filters") != "" {
				_ = json.NewEncoder(w).Encode([]any{})
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{{"Id": name, "Names": []string{"/" + name}}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
}

func blockedDockerAPITestServer(started chan<- struct{}) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(request.URL.Path, "/_ping"):
			w.Header().Set("Api-Version", "1.49")
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(request.URL.Path, "/version"):
			_ = json.NewEncoder(w).Encode(map[string]string{"ApiVersion": "1.49", "MinAPIVersion": "1.24", "Version": "27.0.0"})
		case strings.HasSuffix(request.URL.Path, "/containers/json"):
			if request.URL.Query().Get("filters") != "" {
				_ = json.NewEncoder(w).Encode([]any{})
				return
			}
			select {
			case started <- struct{}{}:
			default:
			}
			<-request.Context().Done()
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
}

func dockerEndpointURL(rawURL string) string {
	return "tcp://" + strings.TrimPrefix(rawURL, "http://")
}
