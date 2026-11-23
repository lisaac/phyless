package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	dockersystem "github.com/moby/moby/api/types/system"
	volumetypes "github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/auth"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/docker/fsbrowse"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

type routeClient struct {
	client.APIClient
	volumeRoot string
}

func (c *routeClient) ContainerList(context.Context, client.ContainerListOptions) (client.ContainerListResult, error) {
	return client.ContainerListResult{}, nil
}

func (c *routeClient) ContainerInspect(context.Context, string, client.ContainerInspectOptions) (client.ContainerInspectResult, error) {
	return client.ContainerInspectResult{Container: container.InspectResponse{Config: &container.Config{}}}, nil
}

func (c *routeClient) ContainerTop(context.Context, string, client.ContainerTopOptions) (client.ContainerTopResult, error) {
	return client.ContainerTopResult{}, nil
}

func (c *routeClient) ExecCreate(context.Context, string, client.ExecCreateOptions) (client.ExecCreateResult, error) {
	return client.ExecCreateResult{}, errors.New("exec unavailable")
}

func (c *routeClient) ContainerRemove(context.Context, string, client.ContainerRemoveOptions) (client.ContainerRemoveResult, error) {
	return client.ContainerRemoveResult{}, nil
}

func (c *routeClient) ContainerExport(context.Context, string, client.ContainerExportOptions) (client.ContainerExportResult, error) {
	return io.NopCloser(strings.NewReader("tar")), nil
}

func (c *routeClient) CopyFromContainer(context.Context, string, client.CopyFromContainerOptions) (client.CopyFromContainerResult, error) {
	return client.CopyFromContainerResult{Content: io.NopCloser(strings.NewReader("tar"))}, nil
}

func (c *routeClient) ImageList(context.Context, client.ImageListOptions) (client.ImageListResult, error) {
	return client.ImageListResult{}, nil
}

func (c *routeClient) ImageInspect(_ context.Context, id string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: id}}, nil
}

func (c *routeClient) ContainerCreate(context.Context, client.ContainerCreateOptions) (client.ContainerCreateResult, error) {
	return client.ContainerCreateResult{ID: "helper"}, nil
}

func (c *routeClient) ImageHistory(context.Context, string, ...client.ImageHistoryOption) (client.ImageHistoryResult, error) {
	return client.ImageHistoryResult{}, nil
}

func (c *routeClient) ImageSave(context.Context, []string, ...client.ImageSaveOption) (client.ImageSaveResult, error) {
	return io.NopCloser(strings.NewReader("tar")), nil
}

func (c *routeClient) NetworkList(context.Context, client.NetworkListOptions) (client.NetworkListResult, error) {
	return client.NetworkListResult{}, nil
}

func (c *routeClient) NetworkInspect(context.Context, string, client.NetworkInspectOptions) (client.NetworkInspectResult, error) {
	return client.NetworkInspectResult{}, nil
}

func (c *routeClient) VolumeList(context.Context, client.VolumeListOptions) (client.VolumeListResult, error) {
	return client.VolumeListResult{}, nil
}

func (c *routeClient) VolumeInspect(context.Context, string, client.VolumeInspectOptions) (client.VolumeInspectResult, error) {
	return client.VolumeInspectResult{Volume: volumetypes.Volume{Mountpoint: c.volumeRoot}}, nil
}

func (*routeClient) Info(context.Context, client.InfoOptions) (client.SystemInfoResult, error) {
	return client.SystemInfoResult{Info: dockersystem.Info{OSType: "linux", Architecture: "amd64"}}, nil
}

func (*routeClient) ServerVersion(context.Context, client.ServerVersionOptions) (client.ServerVersionResult, error) {
	return client.ServerVersionResult{Version: "28.0.0", APIVersion: "1.50"}, nil
}

func routeTestServer(t *testing.T) (*Server, http.Handler, string, map[models.Role]string) {
	t.Helper()
	secret := "route-test-secret"
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	users := []models.User{
		{ID: "viewer", Username: "viewer", Role: models.RoleViewer},
		{ID: "operator", Username: "operator", Role: models.RoleOperator},
		{ID: "admin", Username: "admin", Role: models.RoleAdmin},
	}
	if err := s.Write(&store.Config{Users: users}); err != nil {
		t.Fatal(err)
	}
	dockerClient := &routeClient{volumeRoot: t.TempDir()}
	server := &Server{
		store:     s,
		jwtSecret: []byte(secret),
		docker:    &docker.Client{APIClient: dockerClient},
		fs:        fsbrowse.New(dockerClient),
		audit:     audit.New(filepath.Join(t.TempDir(), "audit.log")),
	}
	tokens := make(map[models.Role]string, len(users))
	for _, user := range users {
		token, err := auth.GenerateTokenWithVersion(user.ID, user.Username, user.Role, user.TokenVersion, []byte(secret))
		if err != nil {
			t.Fatal(err)
		}
		tokens[user.Role] = token
	}
	return server, server.routes(), secret, tokens
}

func TestViewerCanReadResourceDetailsThroughCompleteRouter(t *testing.T) {
	_, handler, _, tokens := routeTestServer(t)
	cases := []struct {
		path string
		want int
	}{
		{"/api/containers/c1", http.StatusOK},
		{"/api/containers/c1/inspect", http.StatusOK},
		{"/api/containers/c1/top", http.StatusOK},
		{"/api/containers/c1/files", http.StatusBadRequest},
		{"/api/images/detail?id=image", http.StatusOK},
		{"/api/images/inspect?id=image", http.StatusOK},
		{"/api/images/history?id=image", http.StatusOK},
		{"/api/networks/n1", http.StatusOK},
		{"/api/networks/n1/inspect", http.StatusOK},
		{"/api/volumes/v1", http.StatusOK},
		{"/api/volumes/v1/inspect", http.StatusOK},
		{"/api/volumes/v1/files?path=missing", http.StatusBadRequest},
		{"/api/compose/detail?id=missing", http.StatusNotFound},
		{"/api/compose/config?id=missing", http.StatusNotFound},
		{"/api/compose/files?id=missing", http.StatusNotFound},
		{"/api/compose/files/content?id=missing&path=compose.yaml", http.StatusNotFound},
		{"/api/compose/files/download?id=missing&path=compose.yaml", http.StatusNotFound},
		{"/api/system/info", http.StatusOK},
		{"/api/system/summary", http.StatusOK},
		{"/api/config/files", http.StatusOK},
		{"/api/config/files/content?path=hosts", http.StatusOK},
		{"/api/config/files/download?path=hosts", http.StatusOK},
		{"/api/fs/list?path=/tmp", http.StatusOK},
		{"/api/fs/file?path=/etc/hosts", http.StatusOK},
		{"/api/registries", http.StatusOK},
		{"/api/templates", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+tokens[models.RoleViewer])
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != tc.want {
				t.Fatalf("GET %s status = %d, want %d; body=%s", tc.path, response.Code, tc.want, response.Body.String())
			}
		})
	}
}

func TestViewerCannotUseOperatorRoutesThroughCompleteRouter(t *testing.T) {
	_, handler, _, tokens := routeTestServer(t)
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/containers/c1/start"},
		{http.MethodPut, "/api/config/files/content?path=phyless-test"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			path := strings.Replace(tc.path, "token=ignored", "token="+url.QueryEscape(tokens[models.RoleViewer]), 1)
			req := httptest.NewRequest(tc.method, path, strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer "+tokens[models.RoleViewer])
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusForbidden {
				t.Fatalf("%s %s status = %d, want 403; body=%s", tc.method, tc.path, response.Code, response.Body.String())
			}
		})
	}
}

func TestViewerCanUseReadOnlyQueryRoutesThroughCompleteRouter(t *testing.T) {
	_, handler, _, tokens := routeTestServer(t)
	viewerToken := url.QueryEscape(tokens[models.RoleViewer])
	for _, path := range []string{
		"/api/containers/c1/export?token=" + viewerToken,
		"/api/images/save?id=image&token=" + viewerToken,
		"/api/containers/c1/files/download?path=/tmp&token=" + viewerToken,
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusOK {
				t.Fatalf("GET %s status = %d, want 200; body=%s", path, response.Code, response.Body.String())
			}
		})
	}
}

func TestImageFilesRoutesRequireViewerAuth(t *testing.T) {
	_, handler, _, tokens := routeTestServer(t)
	viewerToken := url.QueryEscape(tokens[models.RoleViewer])

	listReq := httptest.NewRequest(http.MethodGet, "/api/images/files?id=image", nil)
	listReq.Header.Set("Authorization", "Bearer "+tokens[models.RoleViewer])
	listResp := httptest.NewRecorder()
	handler.ServeHTTP(listResp, listReq)
	if listResp.Code == http.StatusUnauthorized || listResp.Code == http.StatusForbidden {
		t.Fatalf("viewer GET /api/images/files status = %d, want authorized", listResp.Code)
	}

	downloadResp := httptest.NewRecorder()
	handler.ServeHTTP(downloadResp, httptest.NewRequest(http.MethodGet, "/api/images/files/download?id=image&token="+viewerToken, nil))
	if downloadResp.Code == http.StatusUnauthorized || downloadResp.Code == http.StatusForbidden {
		t.Fatalf("viewer GET /api/images/files/download status = %d, want authorized", downloadResp.Code)
	}

	anonListResp := httptest.NewRecorder()
	handler.ServeHTTP(anonListResp, httptest.NewRequest(http.MethodGet, "/api/images/files?id=image", nil))
	if anonListResp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET /api/images/files status = %d, want 401", anonListResp.Code)
	}

	anonDownloadResp := httptest.NewRecorder()
	handler.ServeHTTP(anonDownloadResp, httptest.NewRequest(http.MethodGet, "/api/images/files/download?id=image", nil))
	if anonDownloadResp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET /api/images/files/download status = %d, want 401", anonDownloadResp.Code)
	}
}

func TestStoreLookupFailureIsServiceUnavailableForHeaderAndQueryAuth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	secret := []byte("lookup-failure-secret")
	server := &Server{store: store.New(path), jwtSecret: secret}
	token, err := auth.GenerateToken("u1", "viewer", models.RoleViewer, secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := server.routes()

	headerRequest := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	headerRequest.Header.Set("Authorization", "Bearer "+token)
	headerResponse := httptest.NewRecorder()
	handler.ServeHTTP(headerResponse, headerRequest)
	if headerResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("header auth status = %d, want 503", headerResponse.Code)
	}

	queryRequest := httptest.NewRequest(http.MethodGet, "/ws/events?token="+url.QueryEscape(token), nil)
	queryResponse := httptest.NewRecorder()
	handler.ServeHTTP(queryResponse, queryRequest)
	if queryResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("query auth status = %d, want 503", queryResponse.Code)
	}
}
