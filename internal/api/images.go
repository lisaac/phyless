package api

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/docker/docker/api/types/image"
	"github.com/go-chi/chi/v5"
)

func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	imgs, err := s.docker.ImageList(r.Context(), image.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, imgs)
}

func (s *Server) handleGetImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, _, err := s.docker.ImageInspectWithRaw(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	_, err := s.docker.ImageRemove(r.Context(), id, image.RemoveOptions{Force: force})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "image.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleImageInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetImage(w, r)
}

func (s *Server) handleImageHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	hist, err := s.docker.ImageHistory(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, hist)
}

func (s *Server) handleImagePull(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Image      string `json:"image"`
		RegistryID string `json:"registry_id,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	opts := image.PullOptions{}
	if body.RegistryID != "" {
		opts.RegistryAuth = s.registryAuth(body.RegistryID)
	}
	rc, err := s.docker.ImagePull(r.Context(), body.Image, opts)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	io.Copy(w, rc) //nolint:errcheck
	s.auditFromCtx(r, "image.pull", body.Image, "ok")
}

// registryAuth fetches encoded registry auth from store by registry ID.
func (s *Server) registryAuth(registryID string) string {
	cfg, _ := s.store.Read()
	if cfg == nil {
		return ""
	}
	for _, reg := range cfg.Registries {
		if reg.ID == registryID {
			// ponytail: base64-encode {"username":"...","password":"..."} per Docker API spec
			payload := `{"username":"` + reg.Username + `","password":"` + decrypt(reg.PasswordEnc) + `"}`
			return base64Encode(payload)
		}
	}
	return ""
}

func (s *Server) handleImageTag(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Tag string `json:"tag"`
	}
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
	if err := s.docker.ImageTag(r.Context(), id, body.Tag); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleImageDeleteTag(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag := chi.URLParam(r, "tag")
	ref := id + ":" + tag
	_, err := s.docker.ImageRemove(r.Context(), ref, image.RemoveOptions{})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleImageSave(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rc, err := s.docker.ImageSave(r.Context(), []string{id})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+id+`.tar"`)
	io.Copy(w, rc) //nolint:errcheck
}

func (s *Server) handleImageLoad(w http.ResponseWriter, r *http.Request) {
	resp, err := s.docker.ImageLoad(r.Context(), r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "text/plain")
	io.Copy(w, resp.Body) //nolint:errcheck
}
