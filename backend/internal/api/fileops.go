package api

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/go-chi/chi/v5"

	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/fsbrowse"
)

// File changes of the browse-container sources — "container" and "volume",
// the {id} route param naming which one — share these handlers; fsbrowse
// decides how each target is reached.

func fileTarget(kind string, r *http.Request) fsbrowse.Target {
	if kind == "volume" {
		return fsbrowse.Volume(chi.URLParam(r, "id"))
	}
	return fsbrowse.Container(chi.URLParam(r, "id"))
}

func (s *Server) handleDeleteFile(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		s.fileOp(w, r, kind+".file.delete", chi.URLParam(r, "id")+":"+p, s.fs.Remove(r.Context(), fileTarget(kind, r), p))
	}
}

func (s *Server) handleRenameFile(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			OldPath string `json:"old_path"`
			NewPath string `json:"new_path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "old_path and new_path required")
			return
		}
		s.fileOp(w, r, kind+".file.rename", chi.URLParam(r, "id")+":"+body.OldPath+" -> "+body.NewPath,
			s.fs.Rename(r.Context(), fileTarget(kind, r), body.OldPath, body.NewPath))
	}
}

func (s *Server) handleChmodFile(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := decodeChmod(w, r)
		if !ok {
			return
		}
		err := s.fs.SetPerm(r.Context(), fileTarget(kind, r), body.Path, body.Mode, body.Owner, body.Recursive)
		s.fileOp(w, r, kind+".file.chmod", chi.URLParam(r, "id")+":"+body.String(), err)
	}
}

func (s *Server) handleUploadFile(kind string) http.HandlerFunc {
	put := func(ctx context.Context, id, dir, name string, body io.Reader, meta *tar.Header) error {
		defer s.fs.Invalidate()
		return dockercontainer.UploadTarFile(ctx, s.docker, id, dir, name, body, maxUploadSize, meta)
	}
	if kind == "volume" {
		put = func(ctx context.Context, id, dir, name string, body io.Reader, meta *tar.Header) error {
			return s.fs.UploadVolume(ctx, id, dir, name, body, maxUploadSize, meta)
		}
	}
	return func(w http.ResponseWriter, r *http.Request) {
		dir, name := r.URL.Query().Get("path"), r.URL.Query().Get("name")
		if dir == "" {
			dir = "/"
		}
		if name == "" {
			writeError(w, http.StatusBadRequest, "missing name")
			return
		}
		if r.ContentLength > maxUploadSize {
			writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds size limit")
			return
		}
		meta, err := uploadMeta(r.URL.Query())
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		err = put(r.Context(), chi.URLParam(r, "id"), dir, name, r.Body, meta)
		if errors.Is(err, dockercontainer.ErrUploadTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		s.fileOp(w, r, kind+".file.upload", chi.URLParam(r, "id")+":"+dir+"/"+name, err)
	}
}

// uploadMeta reads the optional mode (octal) / uid / gid an editor save sends
// to keep the overwritten file's permissions and owner; all three or none.
func uploadMeta(q url.Values) (*tar.Header, error) {
	if q.Get("mode") == "" {
		return nil, nil
	}
	mode, err1 := strconv.ParseInt(q.Get("mode"), 8, 64)
	uid, err2 := strconv.Atoi(q.Get("uid"))
	gid, err3 := strconv.Atoi(q.Get("gid"))
	if err1 != nil || err2 != nil || err3 != nil || mode < 0 || mode > 0o7777 || uid < 0 || gid < 0 {
		return nil, errors.New("invalid mode/uid/gid")
	}
	return &tar.Header{Mode: mode, Uid: uid, Gid: gid}, nil
}

// fileOp answers and audits one change.
func (s *Server) fileOp(w http.ResponseWriter, r *http.Request, action, target string, err error) {
	if err != nil {
		s.auditFromCtx(r, action, target, "failed")
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, action, target, "ok")
	w.WriteHeader(http.StatusNoContent)
}
