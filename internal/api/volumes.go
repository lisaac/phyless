package api

import (
	"encoding/json"
	"net/http"

	"github.com/docker/docker/api/types/container"
	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/go-chi/chi/v5"
	dockercontainer "phyless/internal/docker/container"
)

func (s *Server) handleListVolumes(w http.ResponseWriter, r *http.Request) {
	resp, err := s.docker.VolumeList(r.Context(), volumetypes.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp.Volumes)
}

func (s *Server) handleCreateVolume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string            `json:"name"`
		Driver string            `json:"driver"`
		Labels map[string]string `json:"labels,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	vol, err := s.docker.VolumeCreate(r.Context(), volumetypes.CreateOptions{
		Name:   body.Name,
		Driver: body.Driver,
		Labels: body.Labels,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, vol)
}

func (s *Server) handleGetVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	vol, err := s.docker.VolumeInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vol)
}

func (s *Server) handleDeleteVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	if err := s.docker.VolumeRemove(r.Context(), id, force); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVolumeInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetVolume(w, r)
}

// handleVolumeListFiles mounts the volume in a temporary busybox container and lists files.
func (s *Server) handleVolumeListFiles(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/data"
	}

	// ponytail: temp container just to read volume files; removed immediately after
	resp, err := s.docker.ContainerCreate(r.Context(),
		&container.Config{Image: "busybox", Cmd: []string{"sh"}},
		&container.HostConfig{Binds: []string{id + ":/data"}},
		nil, nil, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	cid := resp.ID
	defer s.docker.ContainerRemove(r.Context(), cid, container.RemoveOptions{Force: true}) //nolint:errcheck

	headers, err := dockercontainer.ListFiles(r.Context(), s.docker, cid, path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	type fileEntry struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		Mode  string `json:"mode"`
		IsDir bool   `json:"is_dir"`
	}
	out := make([]fileEntry, len(headers))
	for i, h := range headers {
		out[i] = fileEntry{
			Name:  h.Name,
			Size:  h.Size,
			Mode:  h.FileInfo().Mode().String(),
			IsDir: h.Typeflag == 53,
		}
	}
	writeJSON(w, http.StatusOK, out)
}
