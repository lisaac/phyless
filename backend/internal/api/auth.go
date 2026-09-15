package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"phyless/backend/internal/auth"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

var errInitialSetupComplete = errors.New("initial account is already configured")

func (s *Server) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"configured": len(cfg.Users) > 0})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Password == "" {
		writeError(w, http.StatusBadRequest, "password is required")
		return
	}
	hash, err := passwordHash(body.Password)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid password")
		return
	}
	var user models.User
	err = s.store.Update(func(cfg *store.Config) error {
		if len(cfg.Users) != 0 {
			return errInitialSetupComplete
		}
		id, err := store.NewID("u")
		if err != nil {
			return err
		}
		user = models.User{ID: id, Username: "admin", PasswordHash: hash, Role: models.RoleAdmin}
		cfg.Users = append(cfg.Users, user)
		return nil
	})
	if err != nil {
		if errors.Is(err, errInitialSetupComplete) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	s.issueToken(w, user)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store error")
		return
	}
	for _, u := range cfg.Users {
		if strings.EqualFold(u.Username, strings.TrimSpace(body.Username)) && u.Role.Valid() {
			if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(body.Password)); err != nil {
				break
			}
			s.issueToken(w, u)
			return
		}
	}
	writeError(w, http.StatusUnauthorized, "invalid credentials")
}

func (s *Server) issueToken(w http.ResponseWriter, user models.User) {
	token, err := auth.GenerateTokenWithVersion(user.ID, user.Username, user.Role, user.TokenVersion, s.jwtSecret)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	// ponytail: stateless JWT, logout is client-side token discard
	writeJSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims := auth.FromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       claims.UserID,
		"username": claims.Username,
		"role":     claims.Role,
	})
}
