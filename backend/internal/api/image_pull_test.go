package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

func newImagePullTestServer(t *testing.T, client *createPullClient) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "audit.log")
	s := &Server{docker: &docker.Client{APIClient: client}, store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(logPath), jwtSecret: testSecret}
	if err := s.store.Write(&store.Config{Registries: []models.Registry{
		{ID: "selected", URL: "registry.example", Username: "user", PasswordEnc: mustEncrypt(t, s, "registry-secret")},
	}}); err != nil {
		t.Fatal(err)
	}
	return s, logPath
}

func assertImagePullAudit(t *testing.T, logPath string, failure bool) {
	t.Helper()
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	want := `"result":"ok"`
	if failure {
		want = `"result":"failed"`
	}
	if !strings.Contains(string(log), want) || strings.Contains(string(log), "secret") {
		t.Fatalf("unexpected audit result: %s", log)
	}
}

func TestImagePullForwardsRequestOptionsAndAuditsStreamFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "stream-error"}[failure], func(t *testing.T) {
			client := &createPullClient{pullFailure: failure}
			s, logPath := newImagePullTestServer(t, client)
			body, _ := json.Marshal(map[string]string{
				"image": "registry.example/app:latest", "registry_id": "selected", "platform": "linux/arm64",
			})
			request := httptest.NewRequest("POST", "/api/images/pull", strings.NewReader(string(body)))
			response := httptest.NewRecorder()
			s.handleImagePull(response, request)
			if !client.pulled || client.proxied || len(client.options.Platforms) != 1 || client.options.Platforms[0].OS != "linux" || client.options.Platforms[0].Architecture != "arm64" {
				t.Fatal("request options did not reach ImagePull")
			}
			auth, err := docker.DecodeAuth(client.options.RegistryAuth)
			if err != nil || auth.Password != "registry-secret" {
				t.Fatal("selected credentials did not reach ImagePull")
			}
			if strings.Contains(response.Body.String(), `"error"`) != failure {
				t.Fatalf("response = %s", response.Body.String())
			}
			assertImagePullAudit(t, logPath, failure)
		})
	}
}

// A request proxy routes the pull through docker.Client's proxied registry
// path (not the daemon's ImagePull), so the proxy itself must see the traffic.
func TestImagePullRoutesThroughRequestProxy(t *testing.T) {
	var hits atomic.Int32
	var proxyAuth atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" {
			proxyAuth.Store(true)
		}
		http.Error(w, "refused", http.StatusBadGateway)
	}))
	defer proxy.Close()
	client := &createPullClient{}
	s, logPath := newImagePullTestServer(t, client)
	body, _ := json.Marshal(map[string]string{
		"image": "registry.example/app:latest", "registry_id": "selected",
		"proxy_url": "http://proxy-user:proxy-secret@" + proxy.Listener.Addr().String(), "platform": "linux/arm64",
	})
	response := httptest.NewRecorder()
	s.handleImagePull(response, httptest.NewRequest("POST", "/api/images/pull", strings.NewReader(string(body))))
	if hits.Load() == 0 || !proxyAuth.Load() || client.pulled {
		t.Fatalf("proxy hits=%d auth=%v daemonPull=%v: request proxy was not used", hits.Load(), proxyAuth.Load(), client.pulled)
	}
	if !strings.Contains(response.Body.String(), `"error"`) {
		t.Fatalf("response = %s", response.Body.String())
	}
	assertImagePullAudit(t, logPath, true)
}
