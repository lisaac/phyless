package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/registry"
	"phyless/internal/audit"
	"phyless/internal/models"
	"phyless/internal/store"
)

func TestImagePullForwardsRequestOptionsAndAuditsStreamFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "stream-error"}[failure], func(t *testing.T) {
			dir := t.TempDir()
			logPath := filepath.Join(dir, "audit.log")
			client := &createPullClient{pullFailure: failure}
			s := &Server{docker: client, store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(logPath)}
			if err := s.store.Write(&store.Config{Registries: []models.Registry{
				{ID: "selected", URL: "registry.example", Username: "user", PasswordEnc: encrypt("registry-secret")},
			}}); err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]string{
				"image": "registry.example/app:latest", "registry_id": "selected",
				"proxy_url": "http://proxy-user:proxy-secret@proxy.example:8080", "platform": "linux/arm64",
			})
			request := httptest.NewRequest("POST", "/api/images/pull", strings.NewReader(string(body)))
			response := httptest.NewRecorder()
			s.handleImagePull(response, request)
			if !client.pulled || !client.proxied || client.options.Platform != "linux/arm64" {
				t.Fatal("request options did not reach ImagePull")
			}
			auth, err := registry.DecodeAuthConfig(client.options.RegistryAuth)
			if err != nil || auth.Password != "registry-secret" {
				t.Fatal("selected credentials did not reach ImagePull")
			}
			if strings.Contains(response.Body.String(), `"error"`) != failure {
				t.Fatalf("response = %s", response.Body.String())
			}
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
		})
	}
}
