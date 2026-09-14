package api

import (
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"
	"phyless/backend/internal/auth"
)

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
		if u.Username == body.Username && u.Role.Valid() {
			if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(body.Password)); err != nil {
				break
			}
			token, err := auth.GenerateTokenWithVersion(u.ID, u.Username, u.Role, u.TokenVersion, s.jwtSecret)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "token error")
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"token": token})
			return
		}
	}
	writeError(w, http.StatusUnauthorized, "invalid credentials")
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
