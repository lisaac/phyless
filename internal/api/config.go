package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"phyless/internal/config"
)

// configRoot is the filesystem root exposed for config file management.
// ponytail: hardcoded to /etc for now; make configurable via env var if needed.
const configRoot = "/etc"

func (s *Server) mountConfigRoutes(r chi.Router) {
	r.Get("/api/config/files", s.handleConfigListFiles)
	r.Get("/api/config/files/content", s.handleConfigGetFile)
	r.Put("/api/config/files/content", s.handleConfigPutFile)
	r.Delete("/api/config/files", s.handleConfigDeleteFile)
	r.Post("/api/config/files/rename", s.handleConfigRenameFile)
	r.Get("/api/config/files/download", s.handleConfigDownloadFile)
}

func (s *Server) handleConfigListFiles(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	if !isSubPath(configRoot, filepath.Join(configRoot, subPath)) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	entries, err := config.ListDir(configRoot, subPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleConfigGetFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(configRoot, subPath)
	if !isSubPath(configRoot, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	serveFileContent(w, fullPath)
}

func (s *Server) handleConfigPutFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(configRoot, subPath)
	if !isSubPath(configRoot, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 50<<20)) // 50MB limit
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "config.file.write", subPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleConfigDeleteFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(configRoot, subPath)
	if !isSubPath(configRoot, fullPath) || fullPath == configRoot {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	if err := os.RemoveAll(fullPath); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "config.file.delete", subPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleConfigDownloadFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(configRoot, subPath)
	if !isSubPath(configRoot, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	streamTar(w, fullPath)
}

func (s *Server) handleConfigRenameFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OldPath == "" || body.NewPath == "" {
		writeError(w, http.StatusBadRequest, "old_path and new_path required")
		return
	}
	oldFull := filepath.Join(configRoot, body.OldPath)
	newFull := filepath.Join(configRoot, body.NewPath)
	if !isSubPath(configRoot, oldFull) || !isSubPath(configRoot, newFull) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	if err := os.Rename(oldFull, newFull); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "config.file.rename", body.OldPath+" -> "+body.NewPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// isSubPath returns true if target is at or below root (no path traversal).
func isSubPath(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, "..")
}
