package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	volumetypes "github.com/docker/docker/api/types/volume"
	"github.com/go-chi/chi/v5"
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
	usedBy := make(map[string][]containerRef)
	for _, c := range containers {
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
