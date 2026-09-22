package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"phyless/backend/internal/docker"
)

func TestUpdateStatus(t *testing.T) {
	remote := docker.RemoteImage{Digest: "sha256:idx", ManifestDigest: "sha256:plat", ConfigDigest: "sha256:new"}
	cur := image.InspectResponse{ID: "sha256:old", RepoDigests: []string{"nginx@sha256:oldidx"}}
	noTag := errors.New("no such image")
	cases := []struct {
		name      string
		current   image.InspectResponse
		tag       image.InspectResponse
		tagErr    error
		remoteErr error
		want      string
	}{
		{"repo digest match", image.InspectResponse{ID: "sha256:x", RepoDigests: []string{"nginx@sha256:idx"}}, image.InspectResponse{}, noTag, nil, updateLatest},
		{"imported image matches config", image.InspectResponse{ID: "sha256:new"}, image.InspectResponse{}, noTag, nil, updateLatest},
		{"containerd store id is index digest", image.InspectResponse{ID: "sha256:idx"}, image.InspectResponse{}, noTag, nil, updateLatest},
		{"newer remote", cur, image.InspectResponse{ID: "sha256:old"}, nil, nil, updateAvailable},
		{"tag already pulled", cur, image.InspectResponse{ID: "sha256:new"}, nil, nil, updateLocalNewer},
		{"offline but tag moved", cur, image.InspectResponse{ID: "sha256:other"}, nil, errors.New("x"), updateLocalNewer},
		{"offline", cur, image.InspectResponse{}, noTag, errors.New("x"), updateError},
		{"browser-loaded under containerd store", image.InspectResponse{ID: "sha256:plat"}, image.InspectResponse{}, noTag, nil, updateLatest},
	}
	for _, c := range cases {
		if got, _ := updateStatus(c.current, c.tag, c.tagErr, remote, c.remoteErr); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

type updateCheckClient struct {
	client.APIClient
	distCalls int
}

func (c *updateCheckClient) ContainerInspect(_ context.Context, id string) (container.InspectResponse, error) {
	img := map[string]string{"a": "nginx:latest", "b": "nginx:latest", "c": "sha256:pinned"}[id]
	return container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{ID: id, Image: "sha256:" + id},
		Config:            &container.Config{Image: img},
	}, nil
}

func (c *updateCheckClient) ImageInspect(_ context.Context, ref string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	if ref == "nginx:latest" {
		ref = "sha256:a"
	}
	switch ref {
	case "sha256:a":
		return image.InspectResponse{ID: ref, Os: "linux", Architecture: "amd64", RepoDigests: []string{"nginx@sha256:cur"}}, nil
	case "sha256:b":
		return image.InspectResponse{ID: ref, Os: "linux", Architecture: "amd64", RepoDigests: []string{"nginx@sha256:old"}}, nil
	}
	return image.InspectResponse{}, errors.New("not found")
}

func (c *updateCheckClient) DistributionInspect(context.Context, string, string) (registry.DistributionInspect, error) {
	c.distCalls++
	return registry.DistributionInspect{Descriptor: ocispec.Descriptor{Digest: "sha256:cur"}}, nil
}

func TestUpdateStatusDigestOnlyWithoutRepoDigests(t *testing.T) {
	// Daemon answered, phyless could not fetch the config digest: an image
	// without RepoDigests cannot be compared and must not show as upgradable.
	st, msg := updateStatus(image.InspectResponse{ID: "sha256:x"}, image.InspectResponse{}, errors.New("none"), docker.RemoteImage{Digest: "sha256:idx"}, nil)
	if st != updateError || msg == "" {
		t.Fatalf("got %s %q", st, msg)
	}
}

func TestHandleCheckUpdatesDirect(t *testing.T) {
	c := &updateCheckClient{}
	s := &Server{docker: c}
	rec := httptest.NewRecorder()
	s.handleCheckUpdates(rec, httptest.NewRequest(http.MethodPost, "/api/containers/check-updates", strings.NewReader(`{"ids":["a","b","c"]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var out []updateCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range out {
		got[r.ID] = r.Status
	}
	// b's tag now points at a's (current) image: already pulled, just not recreated.
	want := map[string]string{"a": updateLatest, "b": updateLocalNewer, "c": updateUnsupported}
	for id, st := range want {
		if got[id] != st {
			t.Errorf("%s: got %s want %s", id, got[id], st)
		}
	}
	if c.distCalls != 1 {
		t.Errorf("same ref/platform should be resolved once, got %d calls", c.distCalls)
	}
}

type missingUpdateImageClient struct{ updateCheckClient }

func (*missingUpdateImageClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{}, errors.New("image unavailable")
}

func TestCheckUpdatesStopsAtMissingCurrentImage(t *testing.T) {
	c := &missingUpdateImageClient{}
	s := &Server{docker: c}
	rec := httptest.NewRecorder()
	s.handleCheckUpdates(rec, httptest.NewRequest(http.MethodPost, "/api/containers/check-updates", strings.NewReader(`{"ids":["a"]}`)))
	var out []updateCheckResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Status != updateError || out[0].Error == "" || c.distCalls != 0 {
		t.Fatalf("unexpected result: %+v, remote calls=%d", out, c.distCalls)
	}
}
