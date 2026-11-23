package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/moby/moby/client"
	"phyless/backend/internal/docker"
)

type networkActionClient struct {
	client.APIClient
	connected, disconnected string
}

func (c *networkActionClient) NetworkConnect(context.Context, string, client.NetworkConnectOptions) (client.NetworkConnectResult, error) {
	c.connected = "called"
	return client.NetworkConnectResult{}, nil
}

func (c *networkActionClient) NetworkDisconnect(context.Context, string, client.NetworkDisconnectOptions) (client.NetworkDisconnectResult, error) {
	c.disconnected = "called"
	return client.NetworkDisconnectResult{}, nil
}

func networkRequest(method, path, id, body string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	return httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(
		context.WithValue(context.Background(), chi.RouteCtxKey, routeCtx),
	)
}

func TestNetworkActionsRequireContainerJSON(t *testing.T) {
	client := &networkActionClient{}
	server := &Server{docker: &docker.Client{APIClient: client}}
	for _, method := range []string{http.MethodPost} {
		for _, body := range []string{"", "{}", `{"container":"   "}`, "not-json"} {
			response := httptest.NewRecorder()
			server.handleNetworkConnect(response, networkRequest(method, "/api/networks/n/connect", "n", body))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("connect body %q status = %d, want 400", body, response.Code)
			}
			response = httptest.NewRecorder()
			server.handleNetworkDisconnect(response, networkRequest(method, "/api/networks/n/disconnect", "n", body))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("disconnect body %q status = %d, want 400", body, response.Code)
			}
		}
	}
	response := httptest.NewRecorder()
	server.handleNetworkConnect(response, networkRequest(http.MethodPost, "/api/networks/n/connect", "n", `{"container":" c1 "}`))
	if response.Code != http.StatusNoContent || client.connected == "" {
		t.Fatalf("valid connect status = %d", response.Code)
	}
	response = httptest.NewRecorder()
	server.handleNetworkDisconnect(response, networkRequest(http.MethodPost, "/api/networks/n/disconnect", "n", `{"container":" c1 ","force":true}`))
	if response.Code != http.StatusNoContent || client.disconnected == "" {
		t.Fatalf("valid disconnect status = %d", response.Code)
	}
}
