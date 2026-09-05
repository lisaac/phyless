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

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"phyless/internal/audit"
	"phyless/internal/auth"
	"phyless/internal/models"
	"phyless/internal/store"
)

type routeClient struct {
	client.APIClient
	volumeRoot string
}

func (c *routeClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return nil, nil
}

func (c *routeClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return container.InspectResponse{Config: &container.Config{}}, nil
}

func (c *routeClient) ContainerTop(context.Context, string, []string) (container.TopResponse, error) {
	return container.TopResponse{}, nil
}

func (c *routeClient) ContainerExecCreate(context.Context, string, container.ExecOptions) (container.ExecCreateResponse, error) {
	return container.ExecCreateResponse{}, errors.New("exec unavailable")
}

func (c *routeClient) ContainerExport(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("tar")), nil
}

func (c *routeClient) CopyFromContainer(context.Context, string, string) (io.ReadCloser, container.PathStat, error) {
	return io.NopCloser(strings.NewReader("tar")), container.PathStat{}, nil
}

func (c *routeClient) ImageList(context.Context, image.ListOptions) ([]image.Summary, error) {
	return nil, nil
}

func (c *routeClient) ImageInspectWithRaw(context.Context, string) (image.InspectResponse, []byte, error) {
	return image.InspectResponse{}, nil, nil
}

func (c *routeClient) ImageHistory(context.Context, string, ...client.ImageHistoryOption) ([]image.HistoryResponseItem, error) {
	return nil, nil
}

func (c *routeClient) ImageSave(context.Context, []string, ...client.ImageSaveOption) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("tar")), nil
}

func (c *routeClient) NetworkList(context.Context, network.ListOptions) ([]network.Summary, error) {
	return nil, nil
}

func (c *routeClient) NetworkInspect(context.Context, string, network.InspectOptions) (network.Inspect, error) {
	return network.Inspect{}, nil
}

func (c *routeClient) VolumeList(context.Context, volumetypes.ListOptions) (volumetypes.ListResponse, error) {
	return volumetypes.ListResponse{}, nil
}

func (c *routeClient) VolumeInspect(context.Context, string) (volumetypes.Volume, error) {
	return volumetypes.Volume{Mountpoint: c.volumeRoot}, nil
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
		docker:    dockerClient,
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
