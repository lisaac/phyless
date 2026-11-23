package api

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/client"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/docker/fsbrowse"
)

type imageActionClient struct {
	client.APIClient
	source        client.ImageImportSource
	ref           string
	pruneFilters  client.Filters
	deleted       []string
	deleteForce   bool
	tag           string
	imageListErr  error
	containerErr  error
	volumeListErr error
}

func (c *imageActionClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: id}}, nil
}

func (c *imageActionClient) ImageList(context.Context, client.ImageListOptions) (client.ImageListResult, error) {
	return client.ImageListResult{Items: []image.Summary{{ID: "sha256:image"}}}, c.imageListErr
}

func (c *imageActionClient) ContainerList(context.Context, client.ContainerListOptions) (client.ContainerListResult, error) {
	return client.ContainerListResult{}, c.containerErr
}

func (c *imageActionClient) VolumeList(context.Context, client.VolumeListOptions) (client.VolumeListResult, error) {
	return client.VolumeListResult{}, c.volumeListErr
}

func (c *imageActionClient) ImageImport(_ context.Context, source client.ImageImportSource, ref string, _ client.ImageImportOptions) (client.ImageImportResult, error) {
	c.source, c.ref = source, ref
	return io.NopCloser(strings.NewReader(`{"status":"imported"}`)), nil
}

func (c *imageActionClient) ImagePrune(_ context.Context, opts client.ImagePruneOptions) (client.ImagePruneResult, error) {
	c.pruneFilters = opts.Filters
	return client.ImagePruneResult{Report: image.PruneReport{
		ImagesDeleted:  []image.DeleteResponse{{Deleted: "sha256:unused"}},
		SpaceReclaimed: 42,
	}}, nil
}

func (c *imageActionClient) ImageRemove(_ context.Context, id string, options client.ImageRemoveOptions) (client.ImageRemoveResult, error) {
	c.deleted = append(c.deleted, id)
	c.deleteForce = options.Force
	return client.ImageRemoveResult{}, nil
}

func TestImageImportAndPruneUseRemoteSourceAndUnusedFilter(t *testing.T) {
	client := &imageActionClient{}
	s := &Server{docker: &docker.Client{APIClient: client}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log")), fs: fsbrowse.New(client)}

	importResponse := httptest.NewRecorder()
	s.handleImageImport(importResponse, httptest.NewRequest(
		"POST", "/api/images/import",
		strings.NewReader(`{"source":"https://example.test/rootfs.tar","ref":"imported/app:latest"}`),
	))
	if importResponse.Code != 200 || client.source.SourceName != "https://example.test/rootfs.tar" || client.ref != "imported/app:latest" {
		t.Fatalf("import response=%d source=%q ref=%q", importResponse.Code, client.source.SourceName, client.ref)
	}

	pruneResponse := httptest.NewRecorder()
	s.handleImagePrune(pruneResponse, httptest.NewRequest("POST", "/api/images/prune", nil))
	if pruneResponse.Code != 200 || !maps.Equal(client.pruneFilters["dangling"], map[string]bool{"false": true}) {
		t.Fatalf("prune response=%d filters=%v", pruneResponse.Code, client.pruneFilters)
	}

	localRequest := httptest.NewRequest("POST", "/api/images/import?ref=imported/local:latest", strings.NewReader("tar"))
	localRequest.Header.Set("Content-Type", "application/x-tar")
	localResponse := httptest.NewRecorder()
	s.handleImageImport(localResponse, localRequest)
	if localResponse.Code != 200 || client.source.SourceName != "-" || client.source.Source == nil || client.ref != "imported/local:latest" {
		t.Fatalf("local import response=%d source=%q ref=%q", localResponse.Code, client.source.SourceName, client.ref)
	}

	deleteResponse := httptest.NewRecorder()
	s.handleImageDeleteProgress(deleteResponse, httptest.NewRequest(
		"POST", "/api/images/delete", strings.NewReader(`{"ids":["sha256:a","sha256:b"],"force":true}`),
	))
	if deleteResponse.Code != 200 || len(client.deleted) != 2 || client.deleted[0] != "sha256:a" || client.deleted[1] != "sha256:b" || !client.deleteForce || !strings.Contains(deleteResponse.Body.String(), "已删除镜像") {
		t.Fatalf("delete response=%d ids=%v force=%v body=%q", deleteResponse.Code, client.deleted, client.deleteForce, deleteResponse.Body.String())
	}
}

func (c *imageActionClient) ImageTag(_ context.Context, opts client.ImageTagOptions) (client.ImageTagResult, error) {
	c.tag = opts.Target
	return client.ImageTagResult{}, nil
}

func TestImageTagRequiresValidJSONAndTag(t *testing.T) {
	client := &imageActionClient{}
	server := &Server{docker: &docker.Client{APIClient: client}}
	for _, body := range []string{"", "{}", `{"tag":"   "}`, "not-json"} {
		response := httptest.NewRecorder()
		server.handleImageTag(response, httptest.NewRequest(http.MethodPost, "/api/images/tag?id=image", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %q status = %d, want 400", body, response.Code)
		}
	}
	response := httptest.NewRecorder()
	server.handleImageTag(response, httptest.NewRequest(http.MethodPost, "/api/images/tag?id=image", strings.NewReader(`{"tag":"  latest  "}`)))
	if response.Code != http.StatusNoContent || client.tag != "latest" {
		t.Fatalf("valid tag status = %d, tag = %q", response.Code, client.tag)
	}
}

// imageHelperClient simulates an image with a live imagefs helper container so
// deletion/listing paths that must account for it can be exercised.
type imageHelperClient struct {
	client.APIClient
	calls []string
}

func (c *imageHelperClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: id}}, nil
}

func (c *imageHelperClient) ContainerList(_ context.Context, opts client.ContainerListOptions) (client.ContainerListResult, error) {
	// ReleaseImage finds an image's helpers by their image label.
	if opts.Filters["label"][fsbrowse.ImageLabel+"=sha256:image"] {
		return client.ContainerListResult{Items: []container.Summary{{
			ID:     "helper1",
			Labels: map[string]string{docker.RoleLabel: "debug", fsbrowse.ImageLabel: "sha256:image"},
		}}}, nil
	}
	return client.ContainerListResult{}, nil
}

func (c *imageHelperClient) ContainerRemove(_ context.Context, id string, _ client.ContainerRemoveOptions) (client.ContainerRemoveResult, error) {
	c.calls = append(c.calls, "ContainerRemove:"+id)
	return client.ContainerRemoveResult{}, nil
}

func (c *imageHelperClient) ImageRemove(_ context.Context, id string, _ client.ImageRemoveOptions) (client.ImageRemoveResult, error) {
	c.calls = append(c.calls, "ImageRemove:"+id)
	return client.ImageRemoveResult{}, nil
}

func TestDeleteImageReleasesHelperContainerBeforeRemovingImage(t *testing.T) {
	client := &imageHelperClient{}
	s := &Server{docker: &docker.Client{APIClient: client}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log")), fs: fsbrowse.New(client)}

	response := httptest.NewRecorder()
	s.handleDeleteImage(response, httptest.NewRequest(http.MethodDelete, "/api/images?id=sha256:image", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	want := []string{"ContainerRemove:helper1", "ImageRemove:sha256:image"}
	if len(client.calls) != len(want) || client.calls[0] != want[0] || client.calls[1] != want[1] {
		t.Fatalf("calls = %v, want %v", client.calls, want)
	}
}

func TestListContainersHidesFileBrowsingHelper(t *testing.T) {
	s := &Server{docker: &docker.Client{APIClient: &imageHelperClientList{}}}
	response := httptest.NewRecorder()
	s.handleListContainers(response, httptest.NewRequest(http.MethodGet, "/api/containers", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "helper1") {
		t.Fatalf("helper container leaked into list: %s", response.Body.String())
	}
}

type imageHelperClientList struct {
	client.APIClient
}

func (c *imageHelperClientList) ContainerList(context.Context, client.ContainerListOptions) (client.ContainerListResult, error) {
	return client.ContainerListResult{Items: []container.Summary{
		{ID: "app1", Names: []string{"/app"}},
		{ID: "helper1", Labels: map[string]string{docker.RoleLabel: "debug", fsbrowse.ImageLabel: "sha256:image"}},
	}}, nil
}

func TestResourceUsageDiscoveryErrorsAreReported(t *testing.T) {
	client := &imageActionClient{containerErr: context.Canceled}
	response := httptest.NewRecorder()
	(&Server{docker: &docker.Client{APIClient: client}}).handleListImages(response, httptest.NewRequest("GET", "/api/images", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("image discovery status = %d", response.Code)
	}

	client = &imageActionClient{containerErr: context.Canceled}
	response = httptest.NewRecorder()
	(&Server{docker: &docker.Client{APIClient: client}}).handleListVolumes(response, httptest.NewRequest("GET", "/api/volumes", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("volume discovery status = %d", response.Code)
	}
}

type platformClient struct {
	imageActionClient
	inspects int
}

func (c *platformClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	c.inspects++
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: id, Os: "linux", Architecture: "arm64", Variant: "v8"}}, nil
}

func (c *platformClient) ImageList(context.Context, client.ImageListOptions) (client.ImageListResult, error) {
	return client.ImageListResult{Items: []image.Summary{{ID: "sha256:platform-test"}}}, nil
}

func TestListImagesReportsCachedPlatform(t *testing.T) {
	c := &platformClient{}
	for range 2 {
		response := httptest.NewRecorder()
		(&Server{docker: &docker.Client{APIClient: c}}).handleListImages(response, httptest.NewRequest("GET", "/api/images", nil))
		var out []imageWithUsage
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil || len(out) != 1 || out[0].Platform != "linux/arm64/v8" {
			t.Fatalf("list = %s (%v)", response.Body.String(), err)
		}
	}
	if c.inspects != 1 {
		t.Fatalf("inspects = %d, want 1 (cached by image ID)", c.inspects)
	}
}
