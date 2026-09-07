package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"phyless/internal/docker"
	dockercontainer "phyless/internal/docker/container"
	"phyless/internal/docker/imagefs"
)

type containerRef struct {
	ID   string `json:"Id"`
	Name string `json:"Name"`
}

type imageWithUsage struct {
	image.Summary
	UsedBy []containerRef `json:"UsedBy"`
}

func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	imgs, err := s.docker.ImageList(r.Context(), image.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	containers, err := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	usedBy := make(map[string][]containerRef)
	for _, c := range containers {
		if imagefs.IsHelper(c.Labels) {
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		usedBy[c.ImageID] = append(usedBy[c.ImageID], containerRef{ID: c.ID, Name: name})
	}
	out := make([]imageWithUsage, len(imgs))
	for i, img := range imgs {
		// RepoTags/RepoDigests come from the daemon's internal reference
		// store (map-backed) and aren't guaranteed to keep the same order
		// call to call — same instability class as Mounts/Ports.
		sort.Strings(img.RepoTags)
		sort.Strings(img.RepoDigests)
		out[i] = imageWithUsage{Summary: img, UsedBy: usedBy[img.ID]}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGetImage(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	info, _, err := s.docker.ImageInspectWithRaw(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	sort.Strings(info.RepoTags)
	sort.Strings(info.RepoDigests)
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteImage(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	force := r.URL.Query().Get("force") == "true"
	if err := s.removeImage(r.Context(), id, force); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "image.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// removeImage drops the image's imagefs helper container (if any) before
// removing the image itself — Docker refuses to remove an image that a
// container, including our own browsing helper, still references.
func (s *Server) removeImage(ctx context.Context, id string, force bool) error {
	if err := s.imagefs.Release(ctx, id); err != nil {
		return fmt.Errorf("释放镜像文件浏览容器失败: %w", err)
	}
	_, err := s.docker.ImageRemove(ctx, id, image.RemoveOptions{Force: force})
	return err
}

func flushImageProgress(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) handleImageDeleteProgress(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs   []string `json:"ids"`
		Force bool     `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "ids must not be empty")
		return
	}
	for i, id := range body.IDs {
		body.IDs[i] = strings.TrimSpace(id)
		if body.IDs[i] == "" {
			writeError(w, http.StatusBadRequest, "ids must not contain empty values")
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	dockercontainer.EmitStream(w, "开始删除 %d 个镜像", len(body.IDs))
	flushImageProgress(w)
	for _, id := range body.IDs {
		if err := s.removeImage(r.Context(), id, body.Force); err != nil {
			s.auditFromCtx(r, "image.delete", id, "failed")
			dockercontainer.EmitError(w, fmt.Errorf("镜像 %s：%w", id, err))
		} else {
			s.auditFromCtx(r, "image.delete", id, "ok")
			dockercontainer.EmitStream(w, "已删除镜像 %s", id)
		}
		flushImageProgress(w)
	}
}

func (s *Server) handleImageListFiles(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		dirPath = "/"
	}
	entries, err := s.imagefs.List(r.Context(), id, dirPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleImageDownloadFile(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	rc, err := s.imagefs.Open(r.Context(), id, path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	serveArchive(w, rc, path)
}

func (s *Server) handleImageInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetImage(w, r)
}

func (s *Server) handleImageHistory(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	hist, err := s.docker.ImageHistory(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, hist)
}

func (s *Server) handleImagePull(w http.ResponseWriter, r *http.Request) {
	var body struct {
		requestPullOptions
		Image string `json:"image"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	result := "failed"
	defer func() {
		if result != "ok" && r.Context().Err() != nil {
			result = "canceled"
		}
		s.auditFromCtx(r, "image.pull", safePullTarget(body.Image), result)
	}()
	ctx, err := s.pullContext(r.Context(), body.ProxyURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	encoded, err := s.registryAuthForImage(body.Image, body.RegistryID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	opts := image.PullOptions{RegistryAuth: encoded, Platform: body.Platform}
	rc, err := s.docker.ImagePull(ctx, body.Image, opts)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	if err := docker.ConsumeProgress(ctx, w, rc); err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	result = "ok"
}

func (s *Server) handleImageTag(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	var body struct {
		Tag string `json:"tag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Tag) == "" {
		writeError(w, http.StatusBadRequest, "tag required")
		return
	}
	body.Tag = strings.TrimSpace(body.Tag)
	if err := s.docker.ImageTag(r.Context(), id, body.Tag); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleImageDeleteTag removes a single repo:tag reference (untag). The ref
// itself (e.g. "nginx:latest") is the complete reference Docker needs — it is
// unrelated to the image's content digest/ID.
func (s *Server) handleImageDeleteTag(w http.ResponseWriter, r *http.Request) {
	ref := r.URL.Query().Get("ref")
	_, err := s.docker.ImageRemove(r.Context(), ref, image.RemoveOptions{})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleImageSave(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	rc, err := s.docker.ImageSave(r.Context(), []string{id})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	filename := strings.NewReplacer(":", "_", "/", "_").Replace(id)
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`.tar"`)
	io.Copy(w, rc) //nolint:errcheck
}

func (s *Server) handleImageLoad(w http.ResponseWriter, r *http.Request) {
	resp, err := s.docker.ImageLoad(r.Context(), r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "text/plain")
	io.Copy(w, resp.Body) //nolint:errcheck
}

func (s *Server) handleImageImport(w http.ResponseWriter, r *http.Request) {
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))
	source := image.ImportSource{}
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if !strings.HasPrefix(contentType, "application/x-tar") && !strings.HasPrefix(contentType, "application/octet-stream") {
		var body struct {
			Source string `json:"source"`
			Ref    string `json:"ref,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		remote := strings.TrimSpace(body.Source)
		u, err := url.ParseRequestURI(remote)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			writeError(w, http.StatusBadRequest, "source must be an http(s) URL")
			return
		}
		ref = strings.TrimSpace(body.Ref)
		source = image.ImportSource{SourceName: remote}
	} else {
		// A raw tar body is a container-exported rootfs, not an image archive.
		source = image.ImportSource{Source: r.Body, SourceName: "-"}
	}
	resp, err := s.docker.ImageImport(r.Context(), source, ref, image.ImportOptions{})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer resp.Close()
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	io.Copy(w, resp) //nolint:errcheck
}

func (s *Server) handleImagePrune(w http.ResponseWriter, r *http.Request) {
	// dangling=false matches `docker image prune -a`: remove every image that
	// is not referenced by a container, including tagged images.
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	dockercontainer.EmitStream(w, "开始清理未使用镜像")
	flushImageProgress(w)
	report, err := s.docker.ImagesPrune(r.Context(), filters.NewArgs(filters.Arg("dangling", "false")))
	if err != nil {
		dockercontainer.EmitError(w, err)
		flushImageProgress(w)
		return
	}
	dockercontainer.EmitStream(w, "已清理 %d 个未使用镜像", len(report.ImagesDeleted))
	flushImageProgress(w)
}
