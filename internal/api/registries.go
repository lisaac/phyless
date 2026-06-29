package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
)

func (s *Server) mountRegistryRoutes(r chi.Router) {
	r.Get("/api/registries", s.handleListRegistries)
	r.Post("/api/registries", s.handleCreateRegistry)
	r.Delete("/api/registries/{id}", s.handleDeleteRegistry)
	r.Post("/api/registries/{id}/test", s.handleTestRegistry)
}

func (s *Server) handleListRegistries(w http.ResponseWriter, r *http.Request) {
	cfg, _ := s.store.Read()
	type safeReg struct {
		ID       string `json:"id"`
		URL      string `json:"url"`
		Username string `json:"username"`
	}
	out := make([]safeReg, len(cfg.Registries))
	for i, reg := range cfg.Registries {
		out[i] = safeReg{ID: reg.ID, URL: reg.URL, Username: reg.Username}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateRegistry(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	cfg, _ := s.store.Read()
	reg := models.Registry{
		ID:          fmt.Sprintf("%d", len(cfg.Registries)+1),
		URL:         body.URL,
		Username:    body.Username,
		PasswordEnc: encrypt(body.Password),
	}
	cfg.Registries = append(cfg.Registries, reg)
	s.store.Write(cfg)
	s.auditFromCtx(r, "registry.create", reg.URL, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": reg.ID})
}

func (s *Server) handleDeleteRegistry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()
	for i, reg := range cfg.Registries {
		if reg.ID == id {
			cfg.Registries = append(cfg.Registries[:i], cfg.Registries[i+1:]...)
			s.store.Write(cfg)
			s.auditFromCtx(r, "registry.delete", id, "ok")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleTestRegistry(w http.ResponseWriter, r *http.Request) {
	// ponytail: stub; full impl would ping registry /v2/ endpoint with stored credentials
	writeJSON(w, http.StatusOK, map[string]string{"status": "not implemented yet"})
}
