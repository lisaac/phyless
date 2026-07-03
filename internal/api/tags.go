package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/go-chi/chi/v5"
	"phyless/internal/models"
)

func (s *Server) mountTagRoutes(r chi.Router) {
	r.Get("/api/tags", s.handleListTags)
	r.Post("/api/tags", s.handleCreateTag)
	r.Put("/api/tags/{id}", s.handleUpdateTag)
	r.Delete("/api/tags/{id}", s.handleDeleteTag)
	r.Get("/api/tags/{id}/resources", s.handleTagResources)
	r.Get("/api/tag-bindings", s.handleListBindingsForResource)
	r.Post("/api/tag-bindings", s.handleCreateBinding)
	r.Delete("/api/tag-bindings", s.handleDeleteBinding)
}

type tagWithCount struct {
	models.Tag
	Count int `json:"count"`
}

func (s *Server) handleListTags(w http.ResponseWriter, r *http.Request) {
	cfg, _ := s.store.Read()
	counts := make(map[string]int)
	for _, b := range cfg.TagBindings {
		counts[b.TagID]++
	}
	out := make([]tagWithCount, len(cfg.Tags))
	for i, t := range cfg.Tags {
		out[i] = tagWithCount{Tag: t, Count: counts[t.ID]}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateTag(w http.ResponseWriter, r *http.Request) {
	var t models.Tag
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil || strings.TrimSpace(t.Name) == "" {
		writeError(w, http.StatusBadRequest, "invalid JSON or empty name")
		return
	}
	cfg, _ := s.store.Read()
	for _, existing := range cfg.Tags {
		if strings.EqualFold(existing.Name, t.Name) {
			writeError(w, http.StatusConflict, "标签已存在")
			return
		}
	}
	t.ID = fmt.Sprintf("%d", len(cfg.Tags)+1)
	cfg.Tags = append(cfg.Tags, t)
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	s.auditFromCtx(r, "tag.create", t.Name, "ok")
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleUpdateTag(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var patch models.Tag
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg, _ := s.store.Read()
	for i, t := range cfg.Tags {
		if t.ID == id {
			if strings.TrimSpace(patch.Name) != "" {
				cfg.Tags[i].Name = patch.Name
			}
			cfg.Tags[i].Color = patch.Color
			if err := s.store.Write(cfg); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to save")
				return
			}
			s.auditFromCtx(r, "tag.update", cfg.Tags[i].Name, "ok")
			writeJSON(w, http.StatusOK, cfg.Tags[i])
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()
	for i, t := range cfg.Tags {
		if t.ID == id {
			cfg.Tags = append(cfg.Tags[:i], cfg.Tags[i+1:]...)
			kept := cfg.TagBindings[:0]
			for _, b := range cfg.TagBindings {
				if b.TagID != id {
					kept = append(kept, b)
				}
			}
			cfg.TagBindings = kept
			if err := s.store.Write(cfg); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to save")
				return
			}
			s.auditFromCtx(r, "tag.delete", t.Name, "ok")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}

// handleListBindingsForResource returns the tag IDs bound to one resource —
// used by the per-row tag picker on the container/image list pages.
func (s *Server) handleListBindingsForResource(w http.ResponseWriter, r *http.Request) {
	resourceType := r.URL.Query().Get("resource_type")
	resourceID := r.URL.Query().Get("resource_id")
	cfg, _ := s.store.Read()
	var ids []string
	for _, b := range cfg.TagBindings {
		if b.ResourceType == resourceType && b.ResourceID == resourceID {
			ids = append(ids, b.TagID)
		}
	}
	writeJSON(w, http.StatusOK, ids)
}

func (s *Server) handleCreateBinding(w http.ResponseWriter, r *http.Request) {
	var b models.TagBinding
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.TagID == "" || b.ResourceType == "" || b.ResourceID == "" {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg, _ := s.store.Read()
	for _, existing := range cfg.TagBindings {
		if existing == b {
			w.WriteHeader(http.StatusNoContent) // already bound, idempotent
			return
		}
	}
	cfg.TagBindings = append(cfg.TagBindings, b)
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteBinding(w http.ResponseWriter, r *http.Request) {
	b := models.TagBinding{
		TagID:        r.URL.Query().Get("tag_id"),
		ResourceType: r.URL.Query().Get("resource_type"),
		ResourceID:   r.URL.Query().Get("resource_id"),
	}
	cfg, _ := s.store.Read()
	kept := cfg.TagBindings[:0]
	for _, existing := range cfg.TagBindings {
		if existing != b {
			kept = append(kept, existing)
		}
	}
	cfg.TagBindings = kept
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TaggedResource enriches a binding with live Docker state so the tags page
// can show and act on real containers/images, not just stored references.
type TaggedResource struct {
	ResourceType string   `json:"resource_type"`
	ResourceID   string   `json:"resource_id"`
	Name         string   `json:"name"`
	State        string   `json:"state,omitempty"`     // container only
	RepoTags     []string `json:"repo_tags,omitempty"` // image only
	Missing      bool     `json:"missing"`              // no longer exists in Docker
}

func (s *Server) handleTagResources(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, _ := s.store.Read()

	var containerIDs, imageIDs []string
	for _, b := range cfg.TagBindings {
		if b.TagID != id {
			continue
		}
		if b.ResourceType == "container" {
			containerIDs = append(containerIDs, b.ResourceID)
		} else if b.ResourceType == "image" {
			imageIDs = append(imageIDs, b.ResourceID)
		}
	}

	containers, _ := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	containerByID := make(map[string]container.Summary, len(containers))
	for _, c := range containers {
		containerByID[c.ID] = c
	}
	images, _ := s.docker.ImageList(r.Context(), image.ListOptions{All: true})
	imageByID := make(map[string]image.Summary, len(images))
	for _, img := range images {
		imageByID[img.ID] = img
	}

	var out []TaggedResource
	for _, cid := range containerIDs {
		c, ok := containerByID[cid]
		if !ok {
			out = append(out, TaggedResource{ResourceType: "container", ResourceID: cid, Missing: true})
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out = append(out, TaggedResource{ResourceType: "container", ResourceID: cid, Name: name, State: c.State})
	}
	for _, iid := range imageIDs {
		img, ok := imageByID[iid]
		if !ok {
			out = append(out, TaggedResource{ResourceType: "image", ResourceID: iid, Missing: true})
			continue
		}
		out = append(out, TaggedResource{ResourceType: "image", ResourceID: iid, Name: iid, RepoTags: img.RepoTags})
	}

	writeJSON(w, http.StatusOK, out)
}
