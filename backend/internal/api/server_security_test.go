package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"phyless/backend/internal/auth"
	"phyless/backend/internal/models"
)

func TestSafeRequestURIRedactsQueryToken(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws/events?token=secret-value&since=1", nil)
	uri := safeRequestURI(r)
	if strings.Contains(uri, "secret-value") || !strings.Contains(uri, "REDACTED") {
		t.Fatalf("unsafe URI %q", uri)
	}
}

func TestQueryAuthCancelsExpiryContextAfterHandler(t *testing.T) {
	secret := []byte("query-auth-secret")
	token, err := auth.GenerateTokenWithVersion("u1", "viewer", models.RoleViewer, 0, secret)
	if err != nil {
		t.Fatal(err)
	}
	var requestContext context.Context
	handler := wsAuthWithUser(secret, models.RoleViewer, func(context.Context, string) (*models.User, error) {
		return &models.User{ID: "u1", Username: "viewer", Role: models.RoleViewer}, nil
	}, func(w http.ResponseWriter, r *http.Request) {
		requestContext = r.Context()
		if _, ok := requestContext.Deadline(); !ok {
			t.Error("query-authenticated request has no token expiry deadline")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "/ws/events?token="+url.QueryEscape(token), nil)
	response := httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if requestContext == nil || !errors.Is(requestContext.Err(), context.Canceled) {
		t.Fatalf("query auth context was not canceled after handler: %v", requestContext)
	}
}

func TestLimitJSONBodyBoundsRequestsWithoutContentType(t *testing.T) {
	called := false
	handler := limitJSONBody(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	req := httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(strings.Repeat("x", maxJSONBody+1)))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusRequestEntityTooLarge || called {
		t.Fatalf("status=%d called=%v", res.Code, called)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/images/import", io.NopCloser(strings.NewReader("raw")))
	req.Header.Set("Content-Type", "application/x-tar")
	if boundedBodyRequest(req) {
		t.Fatal("raw image import should not use JSON limit")
	}
}
