package api

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"phyless/internal/docker"
	dockercontainer "phyless/internal/docker/container"
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
	containers, _ := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	usedBy := make(map[string][]containerRef)
	for _, c := range containers {
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
	_, err := s.docker.ImageRemove(r.Context(), id, image.RemoveOptions{Force: force})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "image.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
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
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
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
