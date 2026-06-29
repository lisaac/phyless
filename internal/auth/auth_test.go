package auth_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"phyless/internal/auth"
	"phyless/internal/models"
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
