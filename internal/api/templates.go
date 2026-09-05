package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
	"phyless/internal/store"
)

var errTemplateNotFound = errors.New("template not found")

func (s *Server) mountTemplateRoutes(r chi.Router) {
	r.Post("/api/templates", s.handleCreateTemplate)
	r.Delete("/api/templates/{id}", s.handleDeleteTemplate)
}

func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read templates")
		return
	}
	writeJSON(w, http.StatusOK, cfg.Templates)
}

func (s *Server) handleCreateTemplate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Cmd  string `json:"cmd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.Cmd) == "" {
		writeError(w, http.StatusBadRequest, "name and cmd required")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Cmd = strings.TrimSpace(body.Cmd)
	var t models.Template
	err := s.store.Update(func(cfg *store.Config) error {
		id, err := store.NewID("t")
		if err != nil {
			return err
		}
		t = models.Template{ID: id, Name: body.Name, Cmd: body.Cmd, Created: time.Now().UTC().Format(time.RFC3339)}
		cfg.Templates = append(cfg.Templates, t)
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save template")
		return
	}
	s.auditFromCtx(r, "template.create", t.Name, "ok")
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.Update(func(cfg *store.Config) error {
		for i, t := range cfg.Templates {
			if t.ID == id {
				cfg.Templates = append(cfg.Templates[:i], cfg.Templates[i+1:]...)
				return nil
			}
		}
		return errTemplateNotFound
	})
	if err != nil {
		if errors.Is(err, errTemplateNotFound) {
			writeError(w, http.StatusNotFound, "not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to save template")
		}
		return
	}
	s.auditFromCtx(r, "template.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}
