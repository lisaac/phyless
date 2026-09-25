package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"phyless/backend/internal/config"
)

// mountFsRoutes exposes the write portion of filesystem access. The matching
// read routes are mounted in the Viewer group; this group only handles writes
// used by the compose-project registration form to create a fresh compose
// file. The filesystem boundary is the process's root (unlike /api/config/*,
// which is rooted at /etc).
func (s *Server) mountFsRoutes(r chi.Router) {
	r.Put("/api/fs/file", s.handleFsPutFile)
}

func (s *Server) handleFsList(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = "/"
	}
	dir = filepath.Clean(dir)
	if !filepath.IsAbs(dir) || !isSubPath("/", dir) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	entries, err := config.ListDir("/", dir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleFsGetFile(w http.ResponseWriter, r *http.Request) {
	fullPath := filepath.Clean(r.URL.Query().Get("path"))
	if fullPath == "" || fullPath == "." {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	if !filepath.IsAbs(fullPath) || !isSubPath("/", fullPath) || fullPath == "/" {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	serveFileContent(w, fullPath)
}

func (s *Server) handleFsPutFile(w http.ResponseWriter, r *http.Request) {
	fullPath := filepath.Clean(r.URL.Query().Get("path"))
	if fullPath == "" || fullPath == "." {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	if !filepath.IsAbs(fullPath) || !isSubPath("/", fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	data, err := readBounded(r.Body, maxUploadSize)
	if err != nil {
		if errors.Is(err, errRequestBodyTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	mode := os.FileMode(0644)
	if filepath.Base(fullPath) == ".env" {
		mode = 0600
	}
	if err := atomicWriteFile(fullPath, data, mode); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "fs.file.write", fullPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}
