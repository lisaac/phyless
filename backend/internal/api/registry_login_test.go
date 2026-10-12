package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"phyless/backend/internal/audit"
)

func TestRegistryLoginRelaysOnePost(t *testing.T) {
	var gotBody, gotType string
	status := http.StatusOK
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		gotBody, gotType = string(data), r.Header.Get("Content-Type")
		switch status {
		case http.StatusOK:
			_, _ = w.Write([]byte(`{"access_token":"jwt"}`))
		case http.StatusFound:
			http.Redirect(w, r, "https://elsewhere.example/", http.StatusFound)
		default:
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(status)
		}
	}))
	defer upstream.Close()
	old := http.DefaultTransport
	http.DefaultTransport = upstream.Client().Transport
	defer func() { http.DefaultTransport = old }()

	s := &Server{audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	login := func(body map[string]string) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		s.handleRegistryLogin(w, httptest.NewRequest(http.MethodPost, "/api/registries/login", strings.NewReader(string(data))))
		return w
	}
	ok := map[string]string{"url": upstream.URL + "/v2/auth/token", "content_type": "application/json", "body": `{"identifier":"u"}`}

	if w := login(ok); w.Code != http.StatusOK || w.Body.String() != `{"access_token":"jwt"}` || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("relay: %d %s", w.Code, w.Body)
	}
	if gotBody != `{"identifier":"u"}` || gotType != "application/json" {
		t.Fatalf("upstream got %q %q", gotType, gotBody)
	}
	status = http.StatusUnauthorized // must not read as phyless's own session expiring
	if w := login(ok); w.Code != http.StatusForbidden {
		t.Fatalf("401: %d", w.Code)
	}
	status = http.StatusTooManyRequests
	if w := login(ok); w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" {
		t.Fatalf("429: %d %v", w.Code, w.Header())
	}
	status = http.StatusFound
	if w := login(ok); w.Code != http.StatusFound {
		t.Fatalf("redirect must not be followed: %d", w.Code)
	}
	for _, bad := range []map[string]string{
		{"url": "http://registry.example/token", "content_type": "application/json"},
		{"url": "https://u:p@registry.example/token", "content_type": "application/json"},
		{"url": upstream.URL, "content_type": "text/plain"},
		{"url": upstream.URL, "content_type": "application/json", "body": strings.Repeat("x", 5000)},
	} {
		if w := login(bad); w.Code < 400 || w.Code >= 500 {
			t.Errorf("%v: status %d", bad, w.Code)
		}
	}
}
