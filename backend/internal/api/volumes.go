package api

import (
	"encoding/json"
	"net/http"
	"path"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"phyless/backend/internal/docker"
	"phyless/backend/internal/docker/debugshell"
)

// volumeWithUsage adds which containers actually mount a volume — mirrors
// imageWithUsage's UsedBy field (see images.go), computed the same way: scan
// every container's Mounts for ones that reference this volume by name.
type volumeWithUsage struct {
	docker.Volume
	UsedBy []containerRef `json:"UsedBy"`
}

func (s *Server) handleListVolumes(w http.ResponseWriter, r *http.Request) {
	vols, err := s.docker.ListVolumes(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// VolumeList's own order isn't guaranteed stable between calls — same
	// instability class as Mounts/Ports/RepoTags/networks. Sort by creation
	// time (unparsable/empty timestamps sort first) so polling doesn't
	// reshuffle the list.
	sort.Slice(vols, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, vols[i].CreatedAt)
		tj, _ := time.Parse(time.RFC3339, vols[j].CreatedAt)
		return ti.Before(tj)
	})

	containers, err := s.docker.ListContainers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	vols = slices.DeleteFunc(vols, func(v docker.Volume) bool { return docker.IsHelper(v.Labels) })
	usedBy := make(map[string][]containerRef)
	for _, c := range containers {
		if docker.IsHelper(c.Labels) { // a browse container mounting it is not a user
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		for _, m := range c.Mounts {
			if m.Type == docker.MountTypeVolume && m.Name != "" {
				usedBy[m.Name] = append(usedBy[m.Name], containerRef{ID: c.ID, Name: name})
			}
		}
	}

	out := make([]volumeWithUsage, len(vols))
	for i, v := range vols {
		out[i] = volumeWithUsage{Volume: v, UsedBy: usedBy[v.Name]}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVolumeDownloadFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	rc, err := s.fs.OpenVolume(r.Context(), chi.URLParam(r, "id"), p)
	if docker.IsNotFound(err) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	serveArchive(w, rc, path.Clean("/"+p))
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
	vol, err := s.docker.CreateVolume(r.Context(), body.Name, body.Driver, body.Labels)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, vol)
}

func (s *Server) handleGetVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	vol, err := s.docker.InspectVolume(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vol)
}

func (s *Server) handleDeleteVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	if err := s.fs.ReleaseVolume(r.Context(), id); err != nil { // its browse helpers would keep it in use
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.docker.RemoveVolume(r.Context(), id, force); err != nil {
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
	ctx, helper := debugshell.Track(r.Context())
	entries, err := s.fs.ListVolume(ctx, chi.URLParam(r, "id"), r.URL.Query().Get("path"))
	setHelperHeader(w, helper())
	if docker.IsNotFound(err) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
