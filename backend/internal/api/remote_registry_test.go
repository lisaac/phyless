package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

func remoteRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	(&Server{}).handleRemoteRegistry(w, httptest.NewRequest(http.MethodPost, "/api/images/remote", strings.NewReader(body)))
	return w
}

func TestRemoteRegistryRejectsUnsupportedTargets(t *testing.T) {
	for _, target := range []string{
		"http://hub.docker.com/v2/search/repositories/?query=nginx",
		"https://user:pw@hub.docker.com/v2/search/repositories/",
		"https://hub.docker.com/v2/users/login",
		"https://hub.docker.com/v2/namespaces/library/repositories/nginx",
		"https://evil.example/v2/search/repositories/",
		"https://registry.example/v2/../etc/tags/list",
		"https://registry.example/v2/app/blobs/uploads/",
	} {
		body, _ := json.Marshal(map[string]string{"url": target})
		if w := remoteRequest(t, string(body)); w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", target, w.Code)
		}
	}
	if w := remoteRequest(t, `{"url":"https://hub.docker.com/v2/search/repositories/","proxy_url":"ftp://proxy"}`); w.Code != http.StatusBadRequest {
		t.Errorf("invalid proxy: status %d", w.Code)
	}
}

func TestRemoteRegistryRelaysDockerHub(t *testing.T) {
	var gotPath, gotQuery string
	status := http.StatusOK
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		if status != http.StatusOK {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"detail":"Rate limit exceeded"}`))
			return
		}
		_, _ = w.Write([]byte(`{"count":1,"results":[{"repo_name":"nginx"}]}`))
	}))
	defer hub.Close()
	old := hubAPIBase
	hubAPIBase = hub.URL
	defer func() { hubAPIBase = old }()

	w := remoteRequest(t, `{"url":"https://hub.docker.com/v2/namespaces/library/repositories/nginx/tags?page=2&name=1.27"}`)
	if w.Code != http.StatusOK || w.Body.String() != `{"count":1,"results":[{"repo_name":"nginx"}]}` {
		t.Fatalf("relay: %d %s", w.Code, w.Body)
	}
	if gotPath != "/v2/namespaces/library/repositories/nginx/tags" || gotQuery != "page=2&name=1.27" {
		t.Fatalf("upstream got %s?%s", gotPath, gotQuery)
	}
	status = http.StatusTooManyRequests
	w = remoteRequest(t, `{"url":"https://hub.docker.com/v2/search/repositories/?query=nginx"}`)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" || !strings.Contains(w.Body.String(), "HTTP 429") {
		t.Fatalf("rate limit: %d %v %s", w.Code, w.Header(), w.Body)
	}
}

func TestRemoteRegistryListsV2Tags(t *testing.T) {
	reg := httptest.NewServer(registry.New())
	defer reg.Close()
	host := strings.TrimPrefix(reg.URL, "http://")
	img, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{"v1", "v2", "latest"} {
		ref, err := name.NewTag(host + "/team/app:" + tag)
		if err != nil {
			t.Fatal(err)
		}
		if err := remote.Write(ref, img); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := json.Marshal(map[string]string{"url": (&url.URL{Scheme: "https", Host: host, Path: "/v2/team/app/tags/list", RawQuery: "n=1000"}).String()})
	w := remoteRequest(t, string(body))
	var got struct{ Tags []string }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || strings.Join(got.Tags, ",") != "latest,v1,v2" {
		t.Fatalf("tags: %d %s", w.Code, w.Body)
	}
	body, _ = json.Marshal(map[string]string{"url": "https://" + host + "/v2/team/missing/tags/list"})
	if w := remoteRequest(t, string(body)); w.Code == http.StatusOK {
		t.Fatalf("missing repo: %d %s", w.Code, w.Body)
	}
}

func TestRemoteRegistryRelaysManifestsAndSmallBlobs(t *testing.T) {
	reg := httptest.NewServer(registry.New())
	defer reg.Close()
	host := strings.TrimPrefix(reg.URL, "http://")
	img, err := random.Image(2<<20, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := name.NewTag(host + "/team/app:v1")
	if err := remote.Write(ref, img); err != nil {
		t.Fatal(err)
	}
	digest, _ := img.Digest()
	cfgName, _ := img.ConfigName()
	layers, _ := img.Layers()
	layerDigest, _ := layers[0].Digest()
	get := func(path, accept string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"url": "https://" + host + path, "accept": accept})
		return remoteRequest(t, string(body))
	}
	w := get("/v2/team/app/manifests/v1", "application/vnd.docker.distribution.manifest.v2+json")
	if w.Code != http.StatusOK || w.Header().Get("Docker-Content-Digest") != digest.String() || !strings.Contains(w.Body.String(), cfgName.String()) {
		t.Fatalf("manifest: %d %v", w.Code, w.Header())
	}
	if w = get("/v2/team/app/blobs/"+cfgName.String(), ""); w.Code != http.StatusOK || !json.Valid(w.Body.Bytes()) {
		t.Fatalf("config: %d", w.Code)
	}
	if w = get("/v2/team/app/blobs/"+layerDigest.String(), ""); w.Code != http.StatusBadGateway {
		t.Fatalf("a 2 MiB layer must be refused: %d", w.Code)
	}
	for _, bad := range []string{"/v2/team/app/manifests/../x", "/v2/team/app/blobs/latest", "/v2/team/app/blobs/sha256:abc"} {
		if w = get(bad, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", bad, w.Code)
		}
	}
}
