package api

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"phyless/backend/internal/models"
)

func TestDockerSettingsStoreTLSPEMWithoutReturningIt(t *testing.T) {
	server, handler, _, tokens := routeTestServer(t)
	cert, key := settingsTestPEM(t)
	body := map[string]any{
		"name": "生产 Docker",
		"host": "tcp://docker.example:2376", "tls": true,
		"ca_pem": cert, "cert_pem": cert, "key_pem": key,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/settings/docker/servers", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, body=%s", response.Code, response.Body.String())
	}
	var created struct{ ID string }
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}

	cfg, err := server.store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.DockerServers) != 2 {
		t.Fatalf("servers = %+v", cfg.DockerServers)
	}
	if got := cfg.DockerServers[1]; got.ID != created.ID || got.Host != "tcp://docker.example:2376" || got.KeyPEM != key {
		t.Fatalf("stored Docker server = %+v", got)
	}

	selectRequest := httptest.NewRequest(http.MethodPost, "/api/settings/docker/servers/"+created.ID+"/select", nil)
	selectRequest.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	selectResponse := httptest.NewRecorder()
	handler.ServeHTTP(selectResponse, selectRequest)
	if selectResponse.Code != http.StatusNoContent {
		t.Fatalf("select status = %d, body=%s", selectResponse.Code, selectResponse.Body.String())
	}

	// The old endpoint remains usable for a browser that still has the prior UI
	// cached; omitted PEM fields must preserve the selected server's PEM text.
	legacyBody := []byte(`{"host":"tcp://docker.example:2376","tls":true}`)
	legacyRequest := httptest.NewRequest(http.MethodPut, "/api/settings/docker", bytes.NewReader(legacyBody))
	legacyRequest.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	legacyResponse := httptest.NewRecorder()
	handler.ServeHTTP(legacyResponse, legacyRequest)
	if legacyResponse.Code != http.StatusNoContent {
		t.Fatalf("legacy PUT status = %d, body=%s", legacyResponse.Code, legacyResponse.Body.String())
	}
	if cfg, err = server.store.Read(); err != nil {
		t.Fatal(err)
	} else if cfg.ActiveDockerServerID != created.ID || cfg.DockerServers[1].KeyPEM != key {
		t.Fatalf("selected Docker server = %+v", cfg)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/settings/docker", nil)
	get.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || strings.Contains(getResponse.Body.String(), "BEGIN") {
		t.Fatalf("GET status = %d, body=%s", getResponse.Code, getResponse.Body.String())
	}

	viewer := httptest.NewRequest(http.MethodGet, "/api/settings/docker", nil)
	viewer.Header.Set("Authorization", "Bearer "+tokens[models.RoleViewer])
	viewerResponse := httptest.NewRecorder()
	handler.ServeHTTP(viewerResponse, viewer)
	if viewerResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer GET status = %d, want 403", viewerResponse.Code)
	}
}

func TestComposeDirectoriesAreGlobalSettings(t *testing.T) {
	server, handler, _, tokens := routeTestServer(t)
	send := func(method string, role models.Role, dirs ...string) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"dirs": dirs})
		req := httptest.NewRequest(method, "/api/settings/compose", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tokens[role])
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	if res := send(http.MethodPut, models.RoleAdmin, "/srv/stacks/", " ", "/opt/apps", "/srv/stacks"); res.Code != http.StatusOK {
		t.Fatalf("save = %d %s", res.Code, res.Body.String())
	}
	for _, bad := range [][]string{{"relative/path"}, {"/"}, {}} {
		if res := send(http.MethodPut, models.RoleAdmin, bad...); res.Code != http.StatusBadRequest {
			t.Fatalf("invalid %v = %d %s", bad, res.Code, res.Body.String())
		}
	}
	if res := send(http.MethodPut, models.RoleOperator, "/x"); res.Code != http.StatusForbidden {
		t.Fatalf("operator PUT = %d", res.Code)
	}
	if res := send(http.MethodGet, models.RoleOperator); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `["/srv/stacks","/opt/apps"]`) {
		t.Fatalf("operator GET = %d %s", res.Code, res.Body.String())
	}
	cfg, err := server.store.Read()
	if err != nil || strings.Join(cfg.ComposeDirs, ",") != "/srv/stacks,/opt/apps" {
		t.Fatalf("settings = %+v, %v", cfg, err)
	}
}

func settingsTestPEM(t *testing.T) (string, string) {
	t.Helper()
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	cert := server.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
}
