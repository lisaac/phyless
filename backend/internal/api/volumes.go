package api

import (
	"encoding/json"
	"net/http"
	"path"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/go-chi/chi/v5"

	"github.com/docker/docker/errdefs"

	"phyless/backend/internal/docker"
	"phyless/backend/internal/docker/debugshell"
)

// volumeWithUsage adds which containers actually mount a volume — mirrors
// imageWithUsage's UsedBy field (see images.go), computed the same way: scan
// every container's Mounts for ones that reference this volume by name.
type volumeWithUsage struct {
	volumetypes.Volume
	UsedBy []containerRef `json:"UsedBy"`
}

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

	containers, err := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp.Volumes = slices.DeleteFunc(resp.Volumes, func(v *volumetypes.Volume) bool { return docker.IsHelper(v.Labels) })
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
			if m.Type == mount.TypeVolume && m.Name != "" {
				usedBy[m.Name] = append(usedBy[m.Name], containerRef{ID: c.ID, Name: name})
			}
		}
	}

	out := make([]volumeWithUsage, len(resp.Volumes))
	for i, v := range resp.Volumes {
		out[i] = volumeWithUsage{Volume: *v, UsedBy: usedBy[v.Name]}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVolumeDownloadFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	rc, err := s.fs.OpenVolume(r.Context(), chi.URLParam(r, "id"), p)
	if errdefs.IsNotFound(err) {
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
	if err := s.fs.ReleaseVolume(r.Context(), id); err != nil { // its browse helpers would keep it in use
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
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
	ctx, helper := debugshell.Track(r.Context())
	entries, err := s.fs.ListVolume(ctx, chi.URLParam(r, "id"), r.URL.Query().Get("path"))
	setHelperHeader(w, helper())
	if errdefs.IsNotFound(err) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
