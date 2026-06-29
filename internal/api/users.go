package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
	"phyless/internal/models"
)

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Never expose password hashes
	type safeUser struct {
		ID       string      `json:"id"`
		Username string      `json:"username"`
		Role     models.Role `json:"role"`
	}
	out := make([]safeUser, len(cfg.Users))
	for i, u := range cfg.Users {
		out[i] = safeUser{ID: u.ID, Username: u.Username, Role: u.Role}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string      `json:"username"`
		Password string      `json:"password"`
		Role     models.Role `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash error")
		return
	}
	cfg, _ := s.store.Read()
	id := fmt.Sprintf("%d", len(cfg.Users)+1) // ponytail: simple ID, replace with uuid if collisions matter
	u := models.User{ID: id, Username: body.Username, PasswordHash: string(hash), Role: body.Role}
	cfg.Users = append(cfg.Users, u)
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()
	for _, u := range cfg.Users {
		if u.ID == id {
			writeJSON(w, http.StatusOK, map[string]any{"id": u.ID, "username": u.Username, "role": u.Role})
			return
		}
	}
	writeError(w, http.StatusNotFound, "user not found")
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Password string      `json:"password,omitempty"`
		Role     models.Role `json:"role,omitempty"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	cfg, _ := s.store.Read()
	for i, u := range cfg.Users {
		if u.ID == id {
			if body.Password != "" {
				hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
				cfg.Users[i].PasswordHash = string(hash)
			}
			if body.Role != "" {
				cfg.Users[i].Role = body.Role
			}
			s.store.Write(cfg)
			writeJSON(w, http.StatusOK, map[string]string{"id": id})
			return
		}
	}
	writeError(w, http.StatusNotFound, "user not found")
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()
	for i, u := range cfg.Users {
		if u.ID == id {
			cfg.Users = append(cfg.Users[:i], cfg.Users[i+1:]...)
			s.store.Write(cfg)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "user not found")
}
