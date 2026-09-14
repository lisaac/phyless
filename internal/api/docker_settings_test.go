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

	"phyless/internal/models"
)

func TestDockerSettingsStoreTLSPEMWithoutReturningIt(t *testing.T) {
	server, handler, _, tokens := routeTestServer(t)
	cert, key := settingsTestPEM(t)
	body := map[string]any{
		"host": "tcp://docker.example:2376", "tls": true,
		"ca_pem": cert, "cert_pem": cert, "key_pem": key,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/settings/docker", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+tokens[models.RoleAdmin])
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("PUT status = %d, body=%s", response.Code, response.Body.String())
	}

	cfg, err := server.store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Docker.Host != "tcp://docker.example:2376" || cfg.Docker.KeyPEM != key {
		t.Fatalf("stored Docker endpoint = %+v", cfg.Docker)
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
