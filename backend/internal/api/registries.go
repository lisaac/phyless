package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"phyless/backend/internal/docker"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

var errRegistryNotFound = errors.New("registry not found")

func (s *Server) mountRegistryRoutes(r chi.Router) {
	r.Post("/api/registries", s.handleCreateRegistry)
	r.Put("/api/registries/{id}", s.handleUpdateRegistry)
	r.Delete("/api/registries/{id}", s.handleDeleteRegistry)
	r.Post("/api/registries/{id}/test", s.handleTestRegistry)
	r.Post("/api/registries/{id}/credentials", s.handleRegistryCredentials)
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
		enc, err := s.encrypt(body.Password)
		if err != nil {
			return err
		}
		reg = models.Registry{ID: id, URL: body.URL, Username: body.Username, PasswordEnc: enc}
		cfg.Registries = append(cfg.Registries, reg)
		return s.upgradeLegacyPasswords(cfg)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save registry")
		return
	}
	s.auditFromCtx(r, "registry.create", reg.URL, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": reg.ID})
}

// handleUpdateRegistry edits an account in place so selections keep its ID.
// An empty password keeps the stored one.
func (s *Server) handleUpdateRegistry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
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
	err := s.store.Update(func(cfg *store.Config) error {
		for i := range cfg.Registries {
			if cfg.Registries[i].ID != id {
				continue
			}
			cfg.Registries[i].URL = body.URL
			cfg.Registries[i].Username = body.Username
			if body.Password != "" {
				enc, err := s.encrypt(body.Password)
				if err != nil {
					return err
				}
				cfg.Registries[i].PasswordEnc = enc
			}
			return s.upgradeLegacyPasswords(cfg)
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
	s.auditFromCtx(r, "registry.update", body.URL, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteRegistry(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.Update(func(cfg *store.Config) error {
		for i, reg := range cfg.Registries {
			if reg.ID == id {
				cfg.Registries = append(cfg.Registries[:i], cfg.Registries[i+1:]...)
				return s.upgradeLegacyPasswords(cfg)
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

// handleTestRegistry logs in with a stored account over the same network path
// a pull with these options would use. Failures answer 400, never 401: a 401
// would read as phyless's own session expiring.
func (s *Server) handleTestRegistry(w http.ResponseWriter, r *http.Request) {
	var body requestPullOptions
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read registries")
		return
	}
	var reg *models.Registry
	for i := range cfg.Registries {
		if cfg.Registries[i].ID == chi.URLParam(r, "id") {
			reg = &cfg.Registries[i]
		}
	}
	if reg == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	host, err := docker.RegistryHost(reg.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid registry address")
		return
	}
	ctx, err := s.pullContext(r.Context(), body.ProxyURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	t, err := docker.RequestTransport(ctx)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer t.CloseIdleConnections()
	password, err := s.decrypt(reg.PasswordEnc)
	if err != nil {
		writeError(w, http.StatusBadRequest, "cannot decrypt stored password; re-enter it")
		return
	}
	if err := docker.CheckRegistryLogin(ctx, t, host, reg.Username, password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleRegistryCredentials hands a stored account to the browser so the
// frontend proxy (CF Worker) path can use it: that path talks to the registry
// from the browser and needs the secret itself. Same role as pulling, audited
// per use; the browser keeps it in memory only.
func (s *Server) handleRegistryCredentials(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read registries")
		return
	}
	for _, reg := range cfg.Registries {
		if reg.ID != id {
			continue
		}
		password, err := s.decrypt(reg.PasswordEnc)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		s.auditFromCtx(r, "registry.credentials", reg.URL, "ok")
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"url": reg.URL, "username": reg.Username, "password": password})
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}
