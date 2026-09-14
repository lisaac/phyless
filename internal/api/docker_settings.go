package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"phyless/internal/docker"
	"phyless/internal/models"
	"phyless/internal/store"
)

var (
	errDockerServerNotFound = errors.New("Docker server not found")
	errActiveDockerServer   = errors.New("cannot delete the active Docker server")
)

func (s *Server) mountDockerSettingsRoutes(r chi.Router) {
	r.Get("/api/settings/docker", s.handleGetDockerSettings)
	// Keep the original endpoint usable: it edits the currently selected server.
	r.Put("/api/settings/docker", s.handlePutActiveDockerSettings)
	r.Post("/api/settings/docker/servers", s.handleCreateDockerServer)
	r.Put("/api/settings/docker/servers/{id}", s.handlePutDockerServer)
	r.Delete("/api/settings/docker/servers/{id}", s.handleDeleteDockerServer)
	r.Post("/api/settings/docker/servers/{id}/select", s.handleSelectDockerServer)
}

func (s *Server) handleGetDockerSettings(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read Docker settings")
		return
	}
	servers := make([]dockerServerView, len(cfg.DockerServers))
	for i, server := range cfg.DockerServers {
		servers[i] = dockerServerView{
			ID: server.ID, Name: server.Name, Host: server.Host, TLS: server.TLS,
			HasCAPEM: strings.TrimSpace(server.CAPEM) != "", HasCertPEM: strings.TrimSpace(server.CertPEM) != "", HasKeyPEM: strings.TrimSpace(server.KeyPEM) != "",
		}
	}
	writeJSON(w, http.StatusOK, dockerSettingsView{Servers: servers, ActiveID: cfg.ActiveDockerServerID})
}

func (s *Server) handleCreateDockerServer(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeDockerServerInput(w, r)
	if !ok {
		return
	}
	var created models.DockerServer
	var invalid error
	err := s.store.Update(func(cfg *store.Config) error {
		id, err := store.NewID("d")
		if err != nil {
			return err
		}
		created, err = applyDockerServerInput(models.DockerServer{ID: id}, input, true)
		if err != nil {
			invalid = err
		}
		if err == nil {
			cfg.DockerServers = append(cfg.DockerServers, created)
		}
		return err
	})
	if err != nil {
		writeDockerServerError(w, err, invalid)
		return
	}
	s.auditFromCtx(r, "docker.server.create", created.Name, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": created.ID})
}

func (s *Server) handlePutActiveDockerSettings(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read Docker settings")
		return
	}
	s.putDockerServer(w, r, cfg.ActiveDockerServerID)
}

func (s *Server) handlePutDockerServer(w http.ResponseWriter, r *http.Request) {
	s.putDockerServer(w, r, chi.URLParam(r, "id"))
}

func (s *Server) putDockerServer(w http.ResponseWriter, r *http.Request, id string) {
	input, ok := decodeDockerServerInput(w, r)
	if !ok {
		return
	}
	var previous, updated models.DockerServer
	var active bool
	var invalid error
	err := s.store.Update(func(cfg *store.Config) error {
		index := dockerServerIndex(cfg.DockerServers, id)
		if index < 0 {
			return errDockerServerNotFound
		}
		previous = cfg.DockerServers[index]
		var err error
		updated, err = applyDockerServerInput(previous, input, false)
		if err != nil {
			invalid = err
			return err
		}
		cfg.DockerServers[index] = updated
		active = id == cfg.ActiveDockerServerID
		return nil
	})
	if err != nil {
		writeDockerServerError(w, err, invalid)
		return
	}
	if active {
		if err := s.reloadDockerRuntime(); err != nil {
			_ = s.restoreDockerServer(previous, updated)
			writeError(w, http.StatusServiceUnavailable, "failed to switch Docker server: "+err.Error())
			return
		}
	}
	s.auditFromCtx(r, "docker.server.update", updated.Name, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteDockerServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var deleted models.DockerServer
	err := s.store.Update(func(cfg *store.Config) error {
		index := dockerServerIndex(cfg.DockerServers, id)
		if index < 0 {
			return errDockerServerNotFound
		}
		if id == cfg.ActiveDockerServerID || len(cfg.DockerServers) == 1 {
			return errActiveDockerServer
		}
		deleted = cfg.DockerServers[index]
		cfg.DockerServers = append(cfg.DockerServers[:index], cfg.DockerServers[index+1:]...)
		return nil
	})
	if err != nil {
		writeDockerServerError(w, err, nil)
		return
	}
	s.auditFromCtx(r, "docker.server.delete", deleted.Name, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSelectDockerServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var previous string
	var selected models.DockerServer
	err := s.store.Update(func(cfg *store.Config) error {
		index := dockerServerIndex(cfg.DockerServers, id)
		if index < 0 {
			return errDockerServerNotFound
		}
		previous, selected = cfg.ActiveDockerServerID, cfg.DockerServers[index]
		cfg.ActiveDockerServerID = id
		return nil
	})
	if err != nil {
		writeDockerServerError(w, err, nil)
		return
	}
	if previous != id {
		if err := s.reloadDockerRuntime(); err != nil {
			_ = s.store.Update(func(cfg *store.Config) error {
				if cfg.ActiveDockerServerID == id {
					cfg.ActiveDockerServerID = previous
				}
				return nil
			})
			writeError(w, http.StatusServiceUnavailable, "failed to switch Docker server: "+err.Error())
			return
		}
	}
	s.auditFromCtx(r, "docker.server.select", selected.Name, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) restoreDockerServer(previous, expected models.DockerServer) error {
	return s.store.Update(func(cfg *store.Config) error {
		index := dockerServerIndex(cfg.DockerServers, previous.ID)
		if index < 0 {
			return errDockerServerNotFound
		}
		if cfg.DockerServers[index] != expected {
			return nil
		}
		cfg.DockerServers[index] = previous
		return nil
	})
}

func (s *Server) reloadDockerRuntime() error {
	if s.reloadDocker == nil {
		return nil // route tests construct a Server with a fake API client.
	}
	return s.reloadDocker()
}

type dockerServerInput struct {
	Name    *string `json:"name"`
	Host    string  `json:"host"`
	TLS     *bool   `json:"tls"`
	CAPEM   *string `json:"ca_pem"`
	CertPEM *string `json:"cert_pem"`
	KeyPEM  *string `json:"key_pem"`
}

func decodeDockerServerInput(w http.ResponseWriter, r *http.Request) (dockerServerInput, bool) {
	var input dockerServerInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return input, false
	}
	if input.TLS == nil {
		writeError(w, http.StatusBadRequest, "tls is required")
		return input, false
	}
	return input, true
}

func applyDockerServerInput(server models.DockerServer, input dockerServerInput, creating bool) (models.DockerServer, error) {
	if creating && input.Name == nil {
		return server, fmt.Errorf("name is required")
	}
	if input.Name != nil {
		server.Name = strings.TrimSpace(*input.Name)
	}
	if server.Name == "" {
		return server, fmt.Errorf("name is required")
	}
	endpoint := server.DockerEndpoint
	endpoint.Host, endpoint.TLS = input.Host, *input.TLS
	if input.CAPEM != nil {
		endpoint.CAPEM = *input.CAPEM
	}
	if input.CertPEM != nil {
		endpoint.CertPEM = *input.CertPEM
	}
	if input.KeyPEM != nil {
		endpoint.KeyPEM = *input.KeyPEM
	}
	normalized, err := docker.NormalizeEndpoint(endpoint)
	if err != nil {
		return server, err
	}
	server.DockerEndpoint = normalized
	return server, nil
}

func dockerServerIndex(servers []models.DockerServer, id string) int {
	for i, server := range servers {
		if server.ID == id {
			return i
		}
	}
	return -1
}

func writeDockerServerError(w http.ResponseWriter, err, invalid error) {
	switch {
	case errors.Is(err, errDockerServerNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, errActiveDockerServer):
		writeError(w, http.StatusConflict, err.Error())
	case invalid != nil:
		writeError(w, http.StatusBadRequest, invalid.Error())
	default:
		writeError(w, http.StatusInternalServerError, "failed to save Docker settings")
	}
}

// dockerSettingsView deliberately reports only presence of PEM values. An
// admin can replace them, but a private key never travels back to the browser.
type dockerSettingsView struct {
	Servers  []dockerServerView `json:"servers"`
	ActiveID string             `json:"active_id"`
}

type dockerServerView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	TLS        bool   `json:"tls"`
	HasCAPEM   bool   `json:"has_ca_pem"`
	HasCertPEM bool   `json:"has_cert_pem"`
	HasKeyPEM  bool   `json:"has_key_pem"`
}
