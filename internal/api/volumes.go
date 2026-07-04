package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/go-chi/chi/v5"
)

func (s *Server) handleListVolumes(w http.ResponseWriter, r *http.Request) {
	resp, err := s.docker.VolumeList(r.Context(), volumetypes.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// VolumeList's own order isn't guaranteed stable between calls — same
	// instability class as Mounts/Ports/RepoTags/networks. Sort by creation
	// time (unparsable/empty timestamps sort first) so polling doesn't
	// reshuffle the list.
	sort.Slice(resp.Volumes, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, resp.Volumes[i].CreatedAt)
		tj, _ := time.Parse(time.RFC3339, resp.Volumes[j].CreatedAt)
		return ti.Before(tj)
	})
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
	s.auditFromCtx(r, "volume.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVolumeInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetVolume(w, r)
}

func (s *Server) handleVolumeListFiles(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	subPath := r.URL.Query().Get("path")
	v, err := s.docker.VolumeInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	root := filepath.Join(v.Mountpoint, subPath)
	if !isSubPath(v.Mountpoint, root) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	type fileEntry struct {
		Name  string `json:"name"`
		IsDir bool   `json:"is_dir"`
		Size  int64  `json:"size"`
	}
	out := make([]fileEntry, 0, len(entries))
	for _, e := range entries {
		info, _ := e.Info()
		size := int64(0)
		if info != nil && !e.IsDir() {
			size = info.Size()
		}
		out = append(out, fileEntry{Name: e.Name(), IsDir: e.IsDir(), Size: size})
	}
	writeJSON(w, http.StatusOK, out)
}
