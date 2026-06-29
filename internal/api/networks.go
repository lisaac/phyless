package api

import (
	"encoding/json"
	"net/http"

	"github.com/docker/docker/api/types/network"
	"github.com/go-chi/chi/v5"
)

func (s *Server) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	nets, err := s.docker.NetworkList(r.Context(), network.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, nets)
}

func (s *Server) handleCreateNetwork(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string            `json:"name"`
		Driver string            `json:"driver"`
		Labels map[string]string `json:"labels,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Driver == "" {
		body.Driver = "bridge"
	}
	resp, err := s.docker.NetworkCreate(r.Context(), body.Name, network.CreateOptions{
		Driver: body.Driver,
		Labels: body.Labels,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": resp.ID})
}

func (s *Server) handleGetNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.docker.NetworkInspect(r.Context(), id, network.InspectOptions{})
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.NetworkRemove(r.Context(), id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
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
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
	if err := s.docker.NetworkConnect(r.Context(), id, body.ContainerID, nil); err != nil {
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
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
	if err := s.docker.NetworkDisconnect(r.Context(), id, body.ContainerID, body.Force); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

