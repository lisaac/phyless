package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"phyless/backend/internal/config"
)

// configRoot is the filesystem root exposed for config file management.
// ponytail: hardcoded to /etc for now; make configurable via env var if needed.
const configRoot = "/etc"

func (s *Server) mountConfigRoutes(r chi.Router) {
	r.Put("/api/config/files/content", s.handleConfigPutFile)
	r.Delete("/api/config/files", s.handleConfigDeleteFile)
	r.Post("/api/config/files/rename", s.handleConfigRenameFile)
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
	if !isSubPath(configRoot, fullPath) || filepath.Clean(fullPath) == filepath.Clean(configRoot) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	serveFileContent(w, fullPath)
}

func (s *Server) handleConfigPutFile(w http.ResponseWriter, r *http.Request) {
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(configRoot, subPath)
	if !isSubPath(configRoot, fullPath) || filepath.Clean(fullPath) == filepath.Clean(configRoot) {
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
	if err := atomicWriteFile(fullPath, data, 0644); err != nil {
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
	serveTar(w, fullPath)
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
	if !isSubPath(configRoot, oldFull) || !isSubPath(configRoot, newFull) ||
		filepath.Clean(oldFull) == filepath.Clean(configRoot) || filepath.Clean(newFull) == filepath.Clean(configRoot) {
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
	root, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return false
	}
	target, err = filepath.Abs(filepath.Clean(target))
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	// /api/fs deliberately exposes the whole filesystem root for the read-only
	// Viewer routes and the write routes; a symlink cannot leave that boundary,
	// so allow normal system links at the declared root.
	if root == string(filepath.Separator) {
		return true
	}
	return !containsSymlink(root, rel)
}

// containsSymlink deliberately rejects symlink components in rooted file
// operations. Directory tar entries may still be symlinks; they are archived
// as links and never followed. This is a static check for the trusted
// Operator file boundary; it is not a defense against a concurrent rename.
// ponytail: use os.Root if this endpoint ever accepts concurrent untrusted
// filesystem mutations.
func containsSymlink(root, rel string) bool {
	current := root
	if info, err := os.Lstat(current); err == nil {
		// macOS exposes /etc as a fixed OS symlink to /private/etc. It is the
		// configured boundary itself, so keep that endpoint usable while still
		// rejecting symlink roots supplied by compose projects.
		if info.Mode()&os.ModeSymlink != 0 && filepath.Clean(root) != filepath.Clean(configRoot) {
			return true
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return true
	}
	if rel == "." {
		info, err := os.Lstat(current)
		return err != nil || (info.Mode()&os.ModeSymlink != 0 && filepath.Clean(root) != filepath.Clean(configRoot))
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return false
		}
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return true
		}
	}
	return false
}
