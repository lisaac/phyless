package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"phyless/backend/internal/docker"
)

// networkWithUsage adds which containers are attached to a network — mirrors
// imageWithUsage/volumeWithUsage (see images.go, volumes.go). NetworkList
// leaves Containers empty (only NetworkInspect fills it), so compute it here
// by scanning each container's own network endpoints.
type networkWithUsage struct {
	docker.NetworkSummary
	UsedBy []containerRef `json:"UsedBy"`
}

func (s *Server) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	nets, err := s.docker.ListNetworks(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// NetworkList's own order isn't guaranteed stable between calls — same
	// instability class as Mounts/Ports/RepoTags. Sort by creation time so
	// polling doesn't reshuffle the list.
	sort.Slice(nets, func(i, j int) bool { return nets[i].Created.Before(nets[j].Created) })

	containers, err := s.docker.ListContainers(r.Context())
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
		if c.NetworkSettings == nil {
			continue
		}
		for _, ep := range c.NetworkSettings.Networks {
			if ep == nil || ep.NetworkID == "" {
				continue
			}
			usedBy[ep.NetworkID] = append(usedBy[ep.NetworkID], containerRef{ID: c.ID, Name: name})
		}
	}

	out := make([]networkWithUsage, len(nets))
	for i, n := range nets {
		out[i] = networkWithUsage{NetworkSummary: n, UsedBy: usedBy[n.ID]}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateNetwork(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string              `json:"name"`
		Driver  string              `json:"driver"` // bridge, macvlan, ipvlan, overlay, etc.
		IPAM    *docker.NetworkIPAM `json:"ipam,omitempty"`
		Options map[string]string   `json:"options,omitempty"`
		Labels  map[string]string   `json:"labels,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Driver == "" {
		body.Driver = "bridge"
	}
	id, err := s.docker.CreateNetwork(r.Context(), body.Name, docker.NetworkSpec{
		Driver:  body.Driver,
		IPAM:    body.IPAM,
		Options: body.Options,
		Labels:  body.Labels,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "network.create", body.Name, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (s *Server) handleGetNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.docker.InspectNetwork(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.RemoveNetwork(r.Context(), id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "network.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleNetworkInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetNetwork(w, r)
}

func (s *Server) handleNetworkConnect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		ContainerID string `json:"container"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ContainerID) == "" {
		writeError(w, http.StatusBadRequest, "container required")
		return
	}
	body.ContainerID = strings.TrimSpace(body.ContainerID)
	if err := s.docker.ConnectNetwork(r.Context(), id, body.ContainerID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleNetworkDisconnect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		ContainerID string `json:"container"`
		Force       bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ContainerID) == "" {
		writeError(w, http.StatusBadRequest, "container required")
		return
	}
	body.ContainerID = strings.TrimSpace(body.ContainerID)
	if err := s.docker.DisconnectNetwork(r.Context(), id, body.ContainerID, body.Force); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
