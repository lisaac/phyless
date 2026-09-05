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
	deleted      []string
	deleteForce  bool
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
