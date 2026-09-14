package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"phyless/internal/docker"
	"phyless/internal/store"
)

func (s *Server) mountDockerSettingsRoutes(r chi.Router) {
	r.Get("/api/settings/docker", s.handleGetDockerSettings)
	r.Put("/api/settings/docker", s.handlePutDockerSettings)
}

func (s *Server) handleGetDockerSettings(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read Docker settings")
		return
	}
	writeJSON(w, http.StatusOK, dockerSettingsView{
		Host:       cfg.Docker.Host,
		TLS:        cfg.Docker.TLS,
		HasCAPEM:   strings.TrimSpace(cfg.Docker.CAPEM) != "",
		HasCertPEM: strings.TrimSpace(cfg.Docker.CertPEM) != "",
		HasKeyPEM:  strings.TrimSpace(cfg.Docker.KeyPEM) != "",
	})
}

func (s *Server) handlePutDockerSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host    string  `json:"host"`
		TLS     *bool   `json:"tls"`
		CAPEM   *string `json:"ca_pem"`
		CertPEM *string `json:"cert_pem"`
		KeyPEM  *string `json:"key_pem"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.TLS == nil {
		writeError(w, http.StatusBadRequest, "tls is required")
		return
	}

	var invalid error
	var host string
	err := s.store.Update(func(cfg *store.Config) error {
		next := cfg.Docker
		next.Host, next.TLS = body.Host, *body.TLS
		if body.CAPEM != nil {
			next.CAPEM = *body.CAPEM
		}
		if body.CertPEM != nil {
			next.CertPEM = *body.CertPEM
		}
		if body.KeyPEM != nil {
			next.KeyPEM = *body.KeyPEM
		}
		var err error
		next, err = docker.NormalizeEndpoint(next)
		if err != nil {
			invalid = err
			return err
		}
		cfg.Docker, host = next, next.Host
		return nil
	})
	if err != nil {
		if invalid != nil {
			writeError(w, http.StatusBadRequest, invalid.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "failed to save Docker settings")
		}
		return
	}
	if host == "" {
		host = "local"
	}
	s.auditFromCtx(r, "docker.settings.update", host, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// dockerSettingsView deliberately reports only presence of PEM values. An
// admin can replace them, but a private key never travels back to the browser.
type dockerSettingsView struct {
	Host       string `json:"host"`
	TLS        bool   `json:"tls"`
	HasCAPEM   bool   `json:"has_ca_pem"`
	HasCertPEM bool   `json:"has_cert_pem"`
	HasKeyPEM  bool   `json:"has_key_pem"`
}
