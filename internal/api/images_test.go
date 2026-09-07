package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"phyless/internal/audit"
	"phyless/internal/docker/imagefs"
)

type imageActionClient struct {
	client.APIClient
	source        image.ImportSource
	ref           string
	pruneFilters  filters.Args
	deleted       []string
	deleteForce   bool
	tag           string
	imageListErr  error
	containerErr  error
	volumeListErr error
}

func (c *imageActionClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: id}, nil
}

func (c *imageActionClient) ImageList(context.Context, image.ListOptions) ([]image.Summary, error) {
	return []image.Summary{{ID: "sha256:image"}}, c.imageListErr
}

func (c *imageActionClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return nil, c.containerErr
}

func (c *imageActionClient) VolumeList(context.Context, volumetypes.ListOptions) (volumetypes.ListResponse, error) {
	return volumetypes.ListResponse{}, c.volumeListErr
}

func (c *imageActionClient) ImageImport(_ context.Context, source image.ImportSource, ref string, _ image.ImportOptions) (io.ReadCloser, error) {
	c.source, c.ref = source, ref
	return io.NopCloser(strings.NewReader(`{"status":"imported"}`)), nil
}

func (c *imageActionClient) ImagesPrune(_ context.Context, pruneFilters filters.Args) (image.PruneReport, error) {
	c.pruneFilters = pruneFilters
	return image.PruneReport{
		ImagesDeleted:  []image.DeleteResponse{{Deleted: "sha256:unused"}},
		SpaceReclaimed: 42,
	}, nil
}

func (c *imageActionClient) ImageRemove(_ context.Context, id string, options image.RemoveOptions) ([]image.DeleteResponse, error) {
	c.deleted = append(c.deleted, id)
	c.deleteForce = options.Force
	return nil, nil
}

func TestImageImportAndPruneUseRemoteSourceAndUnusedFilter(t *testing.T) {
	client := &imageActionClient{}
	s := &Server{docker: client, audit: audit.New(filepath.Join(t.TempDir(), "audit.log")), imagefs: imagefs.New(client)}

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
	if pruneResponse.Code != 200 || len(client.pruneFilters.Get("dangling")) != 1 || client.pruneFilters.Get("dangling")[0] != "false" {
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

func (c *imageActionClient) ImageTag(_ context.Context, _ string, tag string) error {
	c.tag = tag
	return nil
}

func TestImageTagRequiresValidJSONAndTag(t *testing.T) {
	client := &imageActionClient{}
	server := &Server{docker: client}
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

func (c *imageHelperClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: id}, nil
}

func (c *imageHelperClient) ContainerList(_ context.Context, opts container.ListOptions) ([]container.Summary, error) {
	// m.find (label=role + label=image) is the only caller passing both
	// filters at once; other callers (e.g. GC cleanup) filter on role alone.
	if len(opts.Filters.Get("label")) == 2 {
		return []container.Summary{{
			ID:     "helper1",
			Labels: map[string]string{imagefs.RoleLabel: imagefs.RoleValue, imagefs.ImageLabel: "sha256:image"},
		}}, nil
	}
	return nil, nil
}

func (c *imageHelperClient) ContainerRemove(_ context.Context, id string, _ container.RemoveOptions) error {
	c.calls = append(c.calls, "ContainerRemove:"+id)
	return nil
}

func (c *imageHelperClient) ImageRemove(_ context.Context, id string, _ image.RemoveOptions) ([]image.DeleteResponse, error) {
	c.calls = append(c.calls, "ImageRemove:"+id)
	return nil, nil
}

func TestDeleteImageReleasesHelperContainerBeforeRemovingImage(t *testing.T) {
	client := &imageHelperClient{}
	s := &Server{docker: client, audit: audit.New(filepath.Join(t.TempDir(), "audit.log")), imagefs: imagefs.New(client)}

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

func TestListContainersHidesImagefsHelper(t *testing.T) {
	s := &Server{docker: &imageHelperClientList{}}
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

func (c *imageHelperClientList) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return []container.Summary{
		{ID: "app1", Names: []string{"/app"}},
		{ID: "helper1", Labels: map[string]string{imagefs.RoleLabel: imagefs.RoleValue, imagefs.ImageLabel: "sha256:image"}},
	}, nil
}

func TestResourceUsageDiscoveryErrorsAreReported(t *testing.T) {
	client := &imageActionClient{containerErr: context.Canceled}
	response := httptest.NewRecorder()
	(&Server{docker: client}).handleListImages(response, httptest.NewRequest("GET", "/api/images", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("image discovery status = %d", response.Code)
	}

	client = &imageActionClient{containerErr: context.Canceled}
	response = httptest.NewRecorder()
	(&Server{docker: client}).handleListVolumes(response, httptest.NewRequest("GET", "/api/volumes", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("volume discovery status = %d", response.Code)
	}
}
