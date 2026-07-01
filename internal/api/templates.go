package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
)

func (s *Server) mountTemplateRoutes(r chi.Router) {
	r.Get("/api/templates", s.handleListTemplates)
	r.Post("/api/templates", s.handleCreateTemplate)
	r.Delete("/api/templates/{id}", s.handleDeleteTemplate)
}

func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	cfg, _ := s.store.Read()
	if cfg.Templates == nil {
		cfg.Templates = []models.Template{}
	}
	writeJSON(w, http.StatusOK, cfg.Templates)
}

func (s *Server) handleCreateTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Cmd  string `json:"cmd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.Cmd == "" {
		writeError(w, http.StatusBadRequest, "name and cmd required")
		return
	}
	cfg, _ := s.store.Read()
	t := models.Template{
		ID:      fmt.Sprintf("t%d", time.Now().UnixMicro()),
		Name:    body.Name,
		Cmd:     body.Cmd,
		Created: time.Now().UTC().Format(time.RFC3339),
	}
	cfg.Templates = append(cfg.Templates, t)
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	s.auditFromCtx(r, "template.create", t.Name, "ok")
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()
	for i, t := range cfg.Templates {
		if t.ID == id {
			cfg.Templates = append(cfg.Templates[:i], cfg.Templates[i+1:]...)
			s.store.Write(cfg) //nolint:errcheck
			s.auditFromCtx(r, "template.delete", id, "ok")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}
