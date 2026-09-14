package docker

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"phyless/internal/models"
)

func TestNewClientConnectsToPlainAndTLSRemoteAPI(t *testing.T) {
	ping := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_ping" {
			t.Fatalf("path = %q, want /_ping", r.URL.Path)
		}
		w.Header().Set("Api-Version", "1.49")
		w.WriteHeader(http.StatusOK)
	})

	t.Run("plain", func(t *testing.T) {
		server := httptest.NewServer(ping)
		defer server.Close()
		cli, err := NewClient(models.DockerEndpoint{Host: "tcp://" + strings.TrimPrefix(server.URL, "http://")})
		if err != nil {
			t.Fatal(err)
		}
		defer cli.Close()
		if _, err := cli.Ping(context.Background()); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("tls", func(t *testing.T) {
		server := httptest.NewTLSServer(ping)
		defer server.Close()
		cert, key := testPEM(t, server)
		cli, err := NewClient(models.DockerEndpoint{
			Host:    "tcp://" + strings.TrimPrefix(server.URL, "https://"),
			TLS:     true,
			CAPEM:   cert,
			CertPEM: cert,
			KeyPEM:  key,
		})
		if err != nil {
			t.Fatal(err)
		}
		defer cli.Close()
		if _, err := cli.Ping(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestNormalizeEndpointRejectsIncompleteTLS(t *testing.T) {
	if _, err := NormalizeEndpoint(models.DockerEndpoint{Host: "tcp://docker.example:2376", TLS: true}); err == nil {
		t.Fatal("incomplete TLS endpoint was accepted")
	}
}

func testPEM(t *testing.T, server *httptest.Server) (string, string) {
	t.Helper()
	cert := server.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
}
