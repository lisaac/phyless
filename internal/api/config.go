package api

import (
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
	data, err := os.ReadFile(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data)
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

// isSubPath returns true if target is at or below root (no path traversal).
func isSubPath(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, "..")
}
