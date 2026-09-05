package api

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

type imageActionClient struct {
	client.APIClient
	source       image.ImportSource
	ref          string
	pruneFilters filters.Args
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

func TestImageImportAndPruneUseRemoteSourceAndUnusedFilter(t *testing.T) {
	client := &imageActionClient{}
	s := &Server{docker: client}

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
}
