package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
	"phyless/internal/store"
)

func userRequest(method, id, body string) *http.Request {
	req := httptest.NewRequest(method, "/api/users/"+id, strings.NewReader(body))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func TestUserMutationsValidateAdminAndUniqueNames(t *testing.T) {
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := s.Write(&store.Config{Users: []models.User{{ID: "admin", Username: "admin", Role: models.RoleAdmin}}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{store: s}

	response := httptest.NewRecorder()
	server.handleUpdateUser(response, userRequest(http.MethodPut, "admin", `{"role":"viewer"}`))
	if response.Code != http.StatusConflict {
		t.Fatalf("last-admin update status = %d", response.Code)
	}
	response = httptest.NewRecorder()
	server.handleDeleteUser(response, userRequest(http.MethodDelete, "admin", ""))
	if response.Code != http.StatusConflict {
		t.Fatalf("last-admin delete status = %d", response.Code)
	}

	response = httptest.NewRecorder()
	server.handleCreateUser(response, httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(`{"username":"admin","password":"secret","role":"viewer"}`)))
	if response.Code != http.StatusConflict {
		t.Fatalf("duplicate username status = %d", response.Code)
	}

	response = httptest.NewRecorder()
	server.handleCreateUser(response, httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(`{"username":"viewer","password":"secret","role":"invalid"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid role status = %d", response.Code)
	}

	response = httptest.NewRecorder()
	server.handleCreateUser(response, httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(`{"username":"viewer","password":"secret","role":"viewer"}`)))
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}
	var first map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	server.handleDeleteUser(response, userRequest(http.MethodDelete, first["id"], ""))
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d", response.Code)
	}
	response = httptest.NewRecorder()
	server.handleCreateUser(response, httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(`{"username":"viewer2","password":"secret","role":"viewer"}`)))
	if response.Code != http.StatusCreated {
		t.Fatalf("second create status = %d", response.Code)
	}
	var second map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if first["id"] == second["id"] {
		t.Fatalf("reused user ID %q", first["id"])
	}
}
