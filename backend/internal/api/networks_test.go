package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

type networkActionClient struct {
	client.APIClient
	connected, disconnected string
}

func (c *networkActionClient) NetworkConnect(context.Context, string, string, *network.EndpointSettings) error {
	c.connected = "called"
	return nil
}

func (c *networkActionClient) NetworkDisconnect(context.Context, string, string, bool) error {
	c.disconnected = "called"
	return nil
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
	server := &Server{docker: client}
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
