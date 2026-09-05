package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
	"phyless/internal/store"
)

var errRegistryNotFound = errors.New("registry not found")

func (s *Server) mountRegistryRoutes(r chi.Router) {
	r.Post("/api/registries", s.handleCreateRegistry)
	r.Delete("/api/registries/{id}", s.handleDeleteRegistry)
	r.Post("/api/registries/{id}/test", s.handleTestRegistry)
}

func (s *Server) handleListRegistries(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read registries")
		return
	}
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
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.URL = strings.TrimSpace(body.URL)
	body.Username = strings.TrimSpace(body.Username)
	if body.URL == "" {
		writeError(w, http.StatusBadRequest, "url required")
		return
	}
	var reg models.Registry
	err := s.store.Update(func(cfg *store.Config) error {
		id, err := store.NewID("r")
		if err != nil {
			return err
		}
		reg = models.Registry{ID: id, URL: body.URL, Username: body.Username, PasswordEnc: encrypt(body.Password)}
		cfg.Registries = append(cfg.Registries, reg)
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save registry")
		return
	}
	s.auditFromCtx(r, "registry.create", reg.URL, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": reg.ID})
}

func (s *Server) handleDeleteRegistry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.Update(func(cfg *store.Config) error {
		for i, reg := range cfg.Registries {
			if reg.ID == id {
				cfg.Registries = append(cfg.Registries[:i], cfg.Registries[i+1:]...)
				return nil
			}
		}
		return errRegistryNotFound
	})
	if err != nil {
		if errors.Is(err, errRegistryNotFound) {
			writeError(w, http.StatusNotFound, "not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to save registry")
		}
		return
	}
	s.auditFromCtx(r, "registry.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTestRegistry(w http.ResponseWriter, r *http.Request) {
	// ponytail: stub; full impl would ping registry /v2/ endpoint with stored credentials
	writeError(w, http.StatusNotImplemented, "registry test is not implemented")
}
