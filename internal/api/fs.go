package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"phyless/internal/config"
)

// mountFsRoutes exposes browse/read/write access to the whole filesystem the
// phyless process itself sees (unlike /api/config/* which is rooted at
// /etc) — used by the compose-project registration form's path picker,
// which needs to suggest directories and auto-detect an existing
// compose.yaml/docker-compose.yaml/.env anywhere a project might live, and
// to write a fresh compose.yaml when registering a project that doesn't
// have one on disk yet. Already gated to Operator+ via the route group in
// server.go, same trust level as /etc file editing and container exec.
func (s *Server) mountFsRoutes(r chi.Router) {
	r.Get("/api/fs/list", s.handleFsList)
	r.Get("/api/fs/file", s.handleFsGetFile)
	r.Put("/api/fs/file", s.handleFsPutFile)
}

func (s *Server) handleFsList(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("path")
	if dir == "" {
		dir = "/"
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
	serveFileContent(w, fullPath)
}

func (s *Server) handleFsPutFile(w http.ResponseWriter, r *http.Request) {
	fullPath := filepath.Clean(r.URL.Query().Get("path"))
	if fullPath == "" || fullPath == "." {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 50<<20)) // 50MB limit
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "fs.file.write", fullPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}
