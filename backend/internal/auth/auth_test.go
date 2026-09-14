package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"phyless/backend/internal/auth"
	"phyless/backend/internal/models"
)

var secret = []byte("test-secret")

func TestTokenRoundTrip(t *testing.T) {
	token, err := auth.GenerateToken("u1", "admin", models.RoleAdmin, secret)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := auth.ValidateToken(token, secret)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != "u1" || claims.Role != models.RoleAdmin {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestMiddlewareRejectsViewer(t *testing.T) {
	token, _ := auth.GenerateToken("u2", "viewer", models.RoleViewer, secret)

	handler := auth.Middleware(secret, models.RoleOperator)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rr.Code)
	}
}

func TestMiddlewareAllowsAdmin(t *testing.T) {
	token, _ := auth.GenerateToken("u1", "admin", models.RoleAdmin, secret)

	handler := auth.Middleware(secret, models.RoleOperator)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestMiddlewareWithUserRevokesChangedAccount(t *testing.T) {
	token, err := auth.GenerateTokenWithVersion("u1", "admin", models.RoleAdmin, 2, secret)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(context.Context, string) (*models.User, error) {
		return &models.User{ID: "u1", Username: "admin", Role: models.RoleAdmin, TokenVersion: 3}, nil
	}
	handler := auth.MiddlewareWithUser(secret, models.RoleViewer, lookup)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}

	missing := auth.MiddlewareWithUser(secret, models.RoleViewer, func(context.Context, string) (*models.User, error) {
		return nil, nil
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	rr = httptest.NewRecorder()
	missing.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("deleted account status = %d", rr.Code)
	}

	storageFailure := auth.MiddlewareWithUser(secret, models.RoleViewer, func(context.Context, string) (*models.User, error) {
		return nil, errors.New("disk unavailable")
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	rr = httptest.NewRecorder()
	storageFailure.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("storage failure status = %d", rr.Code)
	}
}
