package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/registry"
	"github.com/go-chi/chi/v5"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/store"
)

func registryRouter(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	s := &Server{store: store.New(filepath.Join(dir, "config.json")), audit: audit.New(filepath.Join(dir, "audit.log")), jwtSecret: testSecret}
	r := chi.NewRouter()
	s.mountRegistryRoutes(r)
	r.Get("/api/registries", s.handleListRegistries)
	return s, r
}

func serve(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	return w
}

func TestRegistryUpdateKeepsIDAndPasswordWhenBlank(t *testing.T) {
	s, h := registryRouter(t)
	w := serve(h, http.MethodPost, "/api/registries", `{"url":"ghcr.io","username":"a","password":"one"}`)
	var created struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if w = serve(h, http.MethodPut, "/api/registries/"+created.ID, `{"url":"ghcr.io","username":"b","password":""}`); w.Code != http.StatusNoContent {
		t.Fatalf("update: %d %s", w.Code, w.Body)
	}
	cfg, _ := s.store.Read()
	if len(cfg.Registries) != 1 || cfg.Registries[0].ID != created.ID || cfg.Registries[0].Username != "b" || mustDecrypt(t, s, cfg.Registries[0].PasswordEnc) != "one" {
		t.Fatalf("stored %+v", cfg.Registries)
	}
	serve(h, http.MethodPut, "/api/registries/"+created.ID, `{"url":"ghcr.io","username":"b","password":"two"}`)
	cfg, _ = s.store.Read()
	if mustDecrypt(t, s, cfg.Registries[0].PasswordEnc) != "two" {
		t.Fatal("password not replaced")
	}
	if w = serve(h, http.MethodPut, "/api/registries/missing", `{"url":"ghcr.io"}`); w.Code != http.StatusNotFound {
		t.Fatalf("missing: %d", w.Code)
	}
}

func TestRegistryTestLogsInWithStoredAccount(t *testing.T) {
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("user:right"))
	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != want {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer reg.Close()
	host := strings.TrimPrefix(reg.URL, "http://")
	_, h := registryRouter(t)
	ids := map[string]string{}
	for _, password := range []string{"right", "wrong"} {
		w := serve(h, http.MethodPost, "/api/registries", `{"url":"`+host+`","username":"user","password":"`+password+`"}`)
		var created struct{ ID string }
		_ = json.Unmarshal(w.Body.Bytes(), &created)
		ids[password] = created.ID
	}
	if w := serve(h, http.MethodPost, "/api/registries/"+ids["right"]+"/test", `{}`); w.Code != http.StatusOK {
		t.Fatalf("right: %d %s", w.Code, w.Body)
	}
	w := serve(h, http.MethodPost, "/api/registries/"+ids["wrong"]+"/test", ``)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "401") {
		t.Fatalf("wrong must be 400 (never 401) naming the registry status: %d %s", w.Code, w.Body)
	}
	if w := serve(h, http.MethodPost, "/api/registries/"+ids["right"]+"/test", `{"proxy_url":"ftp://x"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad proxy: %d", w.Code)
	}
}

func TestRegistryCredentialsForTheFrontendProxyAreAudited(t *testing.T) {
	s, h := registryRouter(t)
	w := serve(h, http.MethodPost, "/api/registries", `{"url":"docker.io","username":"alice","password":"pat-secret"}`)
	var created struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	w = serve(h, http.MethodPost, "/api/registries/"+created.ID+"/credentials", "")
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || got["password"] != "pat-secret" || got["username"] != "alice" || got["url"] != "docker.io" {
		t.Fatalf("credentials: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("credentials must not be cached")
	}
	entries, _ := s.audit.ReadTail(10)
	found := false
	for _, e := range entries {
		found = found || e.Action == "registry.credentials"
	}
	if !found {
		t.Fatalf("credential reads must be audited: %+v", entries)
	}
	if w = serve(h, http.MethodPost, "/api/registries/missing/credentials", ""); w.Code != http.StatusNotFound {
		t.Fatalf("missing: %d", w.Code)
	}
}

func TestRequestRegistryAuthPicksOneAccountPerRegistry(t *testing.T) {
	s, h := registryRouter(t)
	ids := []string{}
	for _, body := range []string{`{"url":"docker.io","username":"hub","password":"h"}`, `{"url":"ghcr.io","username":"gh","password":"g"}`} {
		w := serve(h, http.MethodPost, "/api/registries", body)
		var created struct{ ID string }
		_ = json.Unmarshal(w.Body.Bytes(), &created)
		ids = append(ids, created.ID)
	}
	for ref, want := range map[string]string{"nginx": "hub", "ghcr.io/o/app:v1": "gh", "quay.io/o/app": ""} {
		encoded, err := s.requestRegistryAuth(ref, requestPullOptions{RegistryIDs: ids})
		if err != nil {
			t.Fatalf("%s: %v", ref, err)
		}
		got := ""
		if encoded != "" {
			auth, _ := registry.DecodeAuthConfig(encoded)
			got = auth.Username
		}
		if got != want {
			t.Errorf("%s: account %q, want %q", ref, got, want)
		}
	}
	if _, err := s.requestRegistryAuth("nginx", requestPullOptions{RegistryID: ids[1]}); err == nil {
		t.Fatal("the single registry_id form stays strict about the image host")
	}
}
