package api

import (
	"archive/tar"
	"encoding/json"
	"io"
	"net/http"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
	"github.com/go-chi/chi/v5"
	dockercontainer "phyless/internal/docker/container"
)

func (s *Server) handleListContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, containers)
}

func (s *Server) handleCreateContainer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name           string            `json:"name"`
		Image          string            `json:"image"`
		Cmd            []string          `json:"cmd,omitempty"`
		Env            []string          `json:"env,omitempty"`
		TemplateID     string            `json:"template_id,omitempty"`
		RestartPolicy  string            `json:"restart_policy,omitempty"`
		NetworkMode    string            `json:"network_mode,omitempty"`
		Binds          []string          `json:"binds,omitempty"`
		CapAdd         []string          `json:"cap_add,omitempty"`
		CapDrop        []string          `json:"cap_drop,omitempty"`
		Privileged     bool              `json:"privileged,omitempty"`
		ReadonlyRootfs bool              `json:"readonly_rootfs,omitempty"`
		Memory         int64             `json:"memory,omitempty"`
		CPUQuota       int64             `json:"cpu_quota,omitempty"`
		CPUPeriod      int64             `json:"cpu_period,omitempty"`
		PidsLimit      *int64            `json:"pids_limit,omitempty"`
		Sysctls        map[string]string `json:"sysctls,omitempty"`
		Labels         map[string]string `json:"labels,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	var baseCfg *container.Config
	var baseHostCfg *container.HostConfig
	if body.TemplateID != "" {
		info, err := s.docker.ContainerInspect(r.Context(), body.TemplateID)
		if err == nil {
			baseCfg = info.Config
			baseHostCfg = info.HostConfig
		}
	}

	cfg := &container.Config{Image: body.Image}
	if baseCfg != nil {
		cfg = baseCfg
		cfg.Image = body.Image
	}
	if len(body.Cmd) > 0 {
		cfg.Cmd = strslice.StrSlice(body.Cmd)
	}
	if len(body.Env) > 0 {
		cfg.Env = body.Env
	}
	if body.Labels != nil {
		cfg.Labels = body.Labels
	}

	hostCfg := &container.HostConfig{}
	if baseHostCfg != nil {
		hostCfg = baseHostCfg
	}
	if body.RestartPolicy != "" {
		hostCfg.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(body.RestartPolicy)}
	}
	if body.NetworkMode != "" {
		hostCfg.NetworkMode = container.NetworkMode(body.NetworkMode)
	}
	if body.Memory > 0 {
		hostCfg.Memory = body.Memory
	}
	if body.CPUQuota > 0 {
		hostCfg.CPUQuota = body.CPUQuota
	}
	if body.CPUPeriod > 0 {
		hostCfg.CPUPeriod = body.CPUPeriod
	}
	if body.PidsLimit != nil {
		hostCfg.PidsLimit = body.PidsLimit
	}
	if len(body.Binds) > 0 {
		hostCfg.Binds = body.Binds
	}
	if len(body.CapAdd) > 0 {
		hostCfg.CapAdd = body.CapAdd
	}
	if len(body.CapDrop) > 0 {
		hostCfg.CapDrop = body.CapDrop
	}
	hostCfg.Privileged = body.Privileged
	hostCfg.ReadonlyRootfs = body.ReadonlyRootfs
	if body.Sysctls != nil {
		hostCfg.Sysctls = body.Sysctls
	}

	resp, err := s.docker.ContainerCreate(r.Context(), cfg, hostCfg, &network.NetworkingConfig{}, nil, body.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.create", body.Name, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": resp.ID})
}

func (s *Server) handleGetContainer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.docker.ContainerInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteContainer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	err := s.docker.ContainerRemove(r.Context(), id, container.RemoveOptions{Force: force})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerStart(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerStart(r.Context(), id, container.StartOptions{}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.start", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerStop(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerStop(r.Context(), id, container.StopOptions{}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.stop", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerRestart(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerRestart(r.Context(), id, container.StopOptions{}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.restart", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerPause(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerPause(r.Context(), id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerUnpause(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerUnpause(r.Context(), id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerKill(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.docker.ContainerKill(r.Context(), id, "SIGKILL"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.kill", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerRename(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
	s.docker.ContainerRename(r.Context(), id, body.Name) //nolint:errcheck
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerInspect(w http.ResponseWriter, r *http.Request) {
	s.handleGetContainer(w, r)
}

func (s *Server) handleContainerDuplicate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
	newID, err := dockercontainer.Duplicate(r.Context(), s.docker, id, body.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.duplicate", id, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": newID})
}

func (s *Server) handleContainerUpgrade(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	newID, err := dockercontainer.Upgrade(r.Context(), s.docker, id, w)
	if err != nil {
		w.Write([]byte("\nERROR: " + err.Error())) //nolint:errcheck
		return
	}
	s.auditFromCtx(r, "container.upgrade", id, "ok")
	w.Write([]byte("\nDone. New ID: " + newID)) //nolint:errcheck
}

func (s *Server) handleContainerUpdateResources(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body container.Resources
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	_, err := s.docker.ContainerUpdate(r.Context(), id, container.UpdateConfig{Resources: body})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleContainerExport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rc, err := s.docker.ContainerExport(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+id+`.tar"`)
	io.Copy(w, rc) //nolint:errcheck // ponytail: pure pipe, no buffer
}

func (s *Server) handleContainerImport(w http.ResponseWriter, r *http.Request) {
	ref := r.URL.Query().Get("ref")
	resp, err := s.docker.ImageImport(r.Context(),
		image.ImportSource{Source: r.Body, SourceName: "-"},
		ref, image.ImportOptions{})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer resp.Close()
	w.Header().Set("Content-Type", "text/plain")
	io.Copy(w, resp) //nolint:errcheck
}

func (s *Server) handleContainerListFiles(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	headers, err := dockercontainer.ListFiles(r.Context(), s.docker, id, path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	type fileEntry struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		Mode  string `json:"mode"`
		IsDir bool   `json:"is_dir"`
	}
	out := make([]fileEntry, len(headers))
	for i, h := range headers {
		out[i] = fileEntry{
			Name:  h.Name,
			Size:  h.Size,
			Mode:  h.FileInfo().Mode().String(),
			IsDir: h.Typeflag == tar.TypeDir,
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleContainerDownloadFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	rc, err := dockercontainer.DownloadFile(r.Context(), s.docker, id, path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="download.tar"`)
	io.Copy(w, rc) //nolint:errcheck // ponytail: pipe the tar stream directly
}

func (s *Server) handleContainerUploadFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	err := s.docker.CopyToContainer(r.Context(), id, path, r.Body, container.CopyToContainerOptions{})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
