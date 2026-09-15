package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"phyless/backend/internal/auth"
	"phyless/backend/internal/store"
)

func TestInitialSetupCreatesAdminAndTokenOnce(t *testing.T) {
	secret := []byte("initial-setup-test-secret-0123456789")
	s := &Server{store: store.New(filepath.Join(t.TempDir(), "config.json")), jwtSecret: secret}

	res := httptest.NewRecorder()
	s.handleSetup(res, httptest.NewRequest(http.MethodPost, "/api/auth/setup", strings.NewReader(`{"password":"secret"}`)))
	if res.Code != http.StatusOK {
		t.Fatalf("setup status=%d body=%s", res.Code, res.Body.String())
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	claims, err := auth.ValidateToken(out.Token, secret)
	if err != nil || claims.Username != "admin" {
		t.Fatalf("setup token claims=%+v err=%v", claims, err)
	}
	cfg, err := s.store.Read()
	if err != nil || len(cfg.Users) != 1 || bcrypt.CompareHashAndPassword([]byte(cfg.Users[0].PasswordHash), []byte("secret")) != nil {
		t.Fatalf("persisted setup account=%+v err=%v", cfg.Users, err)
	}

	res = httptest.NewRecorder()
	s.handleSetup(res, httptest.NewRequest(http.MethodPost, "/api/auth/setup", strings.NewReader(`{"password":"other"}`)))
	if res.Code != http.StatusConflict {
		t.Fatalf("second setup status=%d body=%s", res.Code, res.Body.String())
	}
}
