package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	pathpkg "path"
	"slices"
	"sort"
	"strings"

	"github.com/containerd/platforms"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/strslice"
	"github.com/docker/docker/errdefs"
	"github.com/docker/go-connections/nat"
	"github.com/go-chi/chi/v5"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"phyless/backend/internal/docker"
	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/imagefs"
)

// sortMounts gives Mounts a deterministic order. The daemon builds this slice
// fresh on every call (it isn't stored in the order shown), so without this
// the same container's mounts visibly reshuffle in the frontend on every
// poll even though nothing about the container changed.
func sortMounts(mounts []container.MountPoint) {
	sort.Slice(mounts, func(a, b int) bool { return mounts[a].Destination < mounts[b].Destination })
}

// sortPorts is the same fix for Ports, which has the same instability.
func sortPorts(ports []container.Port) {
	sort.Slice(ports, func(a, b int) bool {
		if ports[a].PrivatePort != ports[b].PrivatePort {
			return ports[a].PrivatePort < ports[b].PrivatePort
		}
		return ports[a].PublicPort < ports[b].PublicPort
	})
}

func (s *Server) handleListContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := s.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	containers = slices.DeleteFunc(containers, func(c container.Summary) bool { return imagefs.IsHelper(c.Labels) })
	for i := range containers {
		sortMounts(containers[i].Mounts)
		sortPorts(containers[i].Ports)
	}
	writeJSON(w, http.StatusOK, containers)
}

func (s *Server) handleCreateContainer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		requestPullOptions
		Name           string            `json:"name"`
		Image          string            `json:"image"`
		Entrypoint     []string          `json:"entrypoint,omitempty"`
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
		Interactive    bool              `json:"interactive,omitempty"`
		TTY            bool              `json:"tty,omitempty"`
		AutoRemove     bool              `json:"auto_remove,omitempty"`
		Init           bool              `json:"init,omitempty"`
		NoHealthcheck  bool              `json:"no_healthcheck,omitempty"`
		Memory         int64             `json:"memory,omitempty"`
		MemorySwap     int64             `json:"memory_swap,omitempty"`
		CPUQuota       int64             `json:"cpu_quota,omitempty"`
		CPUPeriod      int64             `json:"cpu_period,omitempty"`
		CPUShares      int64             `json:"cpu_shares,omitempty"`
		PidsLimit      *int64            `json:"pids_limit,omitempty"`
		Sysctls        map[string]string `json:"sysctls,omitempty"`
		Labels         map[string]string `json:"labels,omitempty"`
		Ports          []string          `json:"ports,omitempty"`
		Hostname       string            `json:"hostname,omitempty"`
		WorkingDir     string            `json:"working_dir,omitempty"`
		DNS            []string          `json:"dns,omitempty"`
		User           string            `json:"user,omitempty"`
		PublishAll     bool              `json:"publish_all,omitempty"`
		Devices        []string          `json:"devices,omitempty"` // "host:container[:mode]"
		Tmpfs          []string          `json:"tmpfs,omitempty"`   // "/path:opts"
		LogDriver      string            `json:"log_driver,omitempty"`
		LogOpts        map[string]string `json:"log_opts,omitempty"`
		PullPolicy     string            `json:"pull_policy,omitempty"` // "always"|"missing"|"never"
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
		s.auditFromCtx(r, "container.create", body.Name, result)
	}()
	body.Image = strings.TrimSpace(body.Image)
	if strings.TrimSpace(body.Image) == "" {
		writeError(w, http.StatusBadRequest, "image required")
		return
	}
	var baseCfg *container.Config
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
	var platform *ocispec.Platform
	if body.Platform != "" {
		if !strings.Contains(body.Platform, "/") {
			writeError(w, http.StatusBadRequest, "platform must include OS and architecture")
			return
		}
		p, err := platforms.Parse(body.Platform)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid platform")
			return
		}
		platform = &p
	}
	switch body.PullPolicy {
	case "", "always", "missing", "never":
	default:
		writeError(w, http.StatusBadRequest, "invalid pull policy")
		return
	}
	var baseHostCfg *container.HostConfig
	if body.TemplateID != "" {
		info, err := s.docker.ContainerInspect(r.Context(), body.TemplateID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "template inspect failed: "+err.Error())
			return
		}
		if info.Config == nil {
			writeError(w, http.StatusBadRequest, "template has no config")
			return
		}
		baseCfg = info.Config
		baseHostCfg = info.HostConfig
	}

	cfg := &container.Config{Image: body.Image}
	if baseCfg != nil {
		cfg = baseCfg
		cfg.Image = body.Image
	}
	if len(body.Cmd) > 0 {
		cfg.Cmd = strslice.StrSlice(body.Cmd)
	}
	if body.Entrypoint != nil {
		cfg.Entrypoint = strslice.StrSlice(body.Entrypoint)
	}
	if len(body.Env) > 0 {
		cfg.Env = body.Env
	}
	if body.Labels != nil {
		cfg.Labels = body.Labels
	}
	if body.Hostname != "" {
		cfg.Hostname = body.Hostname
	}
	if body.WorkingDir != "" {
		cfg.WorkingDir = body.WorkingDir
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
	if body.MemorySwap != 0 {
		hostCfg.MemorySwap = body.MemorySwap
	}
	if body.CPUShares > 0 {
		hostCfg.CPUShares = body.CPUShares
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
	hostCfg.AutoRemove = body.AutoRemove
	if body.Init {
		t := true
		hostCfg.Init = &t
	}
	if body.Interactive {
		cfg.OpenStdin = true
		cfg.AttachStdin = true
	}
	if body.TTY {
		cfg.Tty = true
	}
	if body.NoHealthcheck {
		cfg.Healthcheck = &container.HealthConfig{Test: []string{"NONE"}}
	}
	if body.Sysctls != nil {
		hostCfg.Sysctls = body.Sysctls
	}
	if len(body.Ports) > 0 {
		_, portBindings, err := nat.ParsePortSpecs(body.Ports)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid port spec: "+err.Error())
			return
		}
		hostCfg.PortBindings = portBindings
		exposed := nat.PortSet{}
		for p := range portBindings {
			exposed[p] = struct{}{}
		}
		cfg.ExposedPorts = exposed
	}
	if len(body.DNS) > 0 {
		hostCfg.DNS = body.DNS
	}
	if body.User != "" {
		cfg.User = body.User
	}
	if body.PublishAll {
		hostCfg.PublishAllPorts = true
	}
	if len(body.Devices) > 0 {
		for _, d := range body.Devices {
			parts := strings.SplitN(d, ":", 3)
			dm := container.DeviceMapping{PathOnHost: parts[0], CgroupPermissions: "rwm"}
			if len(parts) >= 2 {
				dm.PathInContainer = parts[1]
			} else {
				dm.PathInContainer = parts[0]
			}
			if len(parts) == 3 {
				dm.CgroupPermissions = parts[2]
			}
			hostCfg.Devices = append(hostCfg.Devices, dm)
		}
	}
	if len(body.Tmpfs) > 0 {
		hostCfg.Tmpfs = make(map[string]string)
		for _, t := range body.Tmpfs {
			parts := strings.SplitN(t, ":", 2)
			opts := ""
			if len(parts) == 2 {
				opts = parts[1]
			}
			hostCfg.Tmpfs[parts[0]] = opts
		}
	}
	if body.LogDriver != "" {
		hostCfg.LogConfig = container.LogConfig{
			Type:   body.LogDriver,
			Config: body.LogOpts,
		}
	}

	// From here on, stream progress as NDJSON lines (same shape as image
	// pull/load) so the frontend can show it in the same progress widget.
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")

	pull := body.PullPolicy == "always"
	if body.PullPolicy == "missing" {
		local, err := s.docker.ImageInspect(ctx, body.Image)
		if err != nil && !errdefs.IsNotFound(err) {
			dockercontainer.EmitError(w, err)
			return
		}
		pull = errdefs.IsNotFound(err)
		if err == nil && platform != nil {
			pull = !platforms.OnlyStrict(*platform).Match(ocispec.Platform{OS: local.Os, Architecture: local.Architecture, Variant: local.Variant})
		}
	}
	if pull {
		dockercontainer.EmitStream(w, "正在拉取镜像 %s …", body.Image)
		rc, err := s.docker.ImagePull(ctx, body.Image, image.PullOptions{RegistryAuth: encoded, Platform: body.Platform})
		if err != nil {
			dockercontainer.EmitError(w, fmt.Errorf("pull failed: %w", err))
			return
		}
		if err := docker.ConsumeProgress(ctx, w, rc); err != nil {
			dockercontainer.EmitError(w, err)
			return
		}
	}

	if err := ctx.Err(); err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	resp, err := s.docker.ContainerCreate(ctx, cfg, hostCfg, &network.NetworkingConfig{}, platform, body.Name)
	if err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	if strings.TrimSpace(resp.ID) == "" {
		dockercontainer.EmitError(w, fmt.Errorf("Docker returned an empty container ID"))
		return
	}
	result = "ok"
	dockercontainer.EmitDone(w, resp.ID, "✓ 创建完成，容器 ID: %s", resp.ID)
}

func (s *Server) handleGetContainer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.docker.ContainerInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	sortMounts(info.Mounts)
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
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	if err := s.docker.ContainerRename(r.Context(), id, body.Name); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.auditFromCtx(r, "container.rename", id, "ok")
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
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
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
	result := "failed"
	defer func() {
		if result != "ok" && r.Context().Err() != nil {
			result = "canceled"
		}
		s.auditFromCtx(r, "container.upgrade", id, result)
	}()
	var body struct {
		requestPullOptions
		EnvFromImage []string `json:"env_from_image,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	uopts := dockercontainer.UpgradeOptions{EnvFromImage: body.EnvFromImage}
	if body.PullPolicy != "" && body.PullPolicy != "never" {
		writeError(w, http.StatusBadRequest, "invalid pull_policy: upgrade only accepts never")
		return
	}
	ctx, err := s.pullContext(r.Context(), body.ProxyURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := s.docker.ContainerInspect(ctx, id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	imageRef := dockercontainer.UpgradeImageRef(info)
	if imageRef == "" {
		writeError(w, http.StatusBadRequest, "container has no image reference")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	var newID string
	if body.PullPolicy == "never" {
		newID, err = dockercontainer.UpgradeWithoutPull(ctx, s.docker, id, w, uopts)
	} else {
		encoded, authErr := s.registryAuthForImage(imageRef, body.RegistryID)
		if len(body.RegistryIDs) > 0 {
			encoded, authErr = s.registryAuthFromIDs(imageRef, body.RegistryIDs)
		}
		if authErr != nil {
			writeError(w, http.StatusBadRequest, authErr.Error())
			return
		}
		newID, err = dockercontainer.Upgrade(ctx, s.docker, id, w, image.PullOptions{RegistryAuth: encoded}, uopts)
	}
	if err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	result = "ok"
	_ = newID // output already written inside Upgrade
}

func (s *Server) handleContainerUpdateResources(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body container.UpdateConfig
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	clearMemory := body.Resources.Memory == -1
	clearSwap := body.Resources.MemorySwap == -1
	if clearMemory || clearSwap {
		writeError(w, http.StatusBadRequest, "online memory limit clearing is unsupported; recreate the container")
		return
	}
	if _, err := s.docker.ContainerUpdate(r.Context(), id, body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleContainerTop(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	result, err := s.docker.ContainerTop(r.Context(), id, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleContainerDeleteFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if !validContainerMutationPath(path) {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	if err := dockercontainer.ExecChecked(r.Context(), s.docker, id, []string{"rm", "-rf", "--", path}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerRenameFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OldPath == "" || body.NewPath == "" {
		writeError(w, http.StatusBadRequest, "old_path and new_path required")
		return
	}
	if !validContainerMutationPath(body.OldPath) || !validContainerMutationPath(body.NewPath) {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}
	if err := dockercontainer.ExecChecked(r.Context(), s.docker, id, []string{"mv", "--", body.OldPath, body.NewPath}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validContainerMutationPath(raw string) bool {
	if raw == "" || strings.ContainsRune(raw, 0) || !pathpkg.IsAbs(raw) {
		return false
	}
	clean := pathpkg.Clean(raw)
	return clean != "/" && clean != "." && clean != ".."
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
	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		dirPath = "/"
	}
	inspect, err := s.docker.ContainerInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var entries []dockercontainer.FileEntry
	if s.imagefs == nil || (inspect.ContainerJSONBase != nil && inspect.State != nil && inspect.State.Running && !inspect.State.Paused) {
		entries, err = dockercontainer.ExecListDir(r.Context(), s.docker, id, dirPath)
	} else {
		entries, err = s.imagefs.ListContainer(r.Context(), id, dirPath)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
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
	serveArchive(w, rc, path)
}

// serveArchive writes rc as a downloadable tar named after the last segment
// of path (or "root" for "/"). Shared by container and image file downloads.
func serveArchive(w http.ResponseWriter, rc io.Reader, path string) {
	base := path[strings.LastIndex(path, "/")+1:]
	if base == "" {
		base = "root"
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+base+`.tar"`)
	io.Copy(w, rc) //nolint:errcheck // ponytail: pipe the tar stream directly
}

func (s *Server) handleContainerUploadFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing name")
		return
	}
	if r.ContentLength > maxUploadSize {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds size limit")
		return
	}
	if err := dockercontainer.UploadTarFile(r.Context(), s.docker, id, path, name, r.Body, maxUploadSize); err != nil {
		if errors.Is(err, dockercontainer.ErrUploadTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContainerCopyToContainer(w http.ResponseWriter, r *http.Request) {
	srcID := chi.URLParam(r, "id")
	srcPath := r.URL.Query().Get("path")
	if srcPath == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	var body struct {
		TargetID   string `json:"target_id"`
		TargetPath string `json:"target_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TargetID == "" || body.TargetPath == "" {
		writeError(w, http.StatusBadRequest, "target_id and target_path required")
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	dockercontainer.EmitStream(w, "正在复制 %s → %s:%s …", srcPath, body.TargetID[:min(12, len(body.TargetID))], body.TargetPath)
	if err := dockercontainer.CopyBetweenContainers(r.Context(), s.docker, srcID, srcPath, body.TargetID, body.TargetPath); err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	s.auditFromCtx(r, "container.file.copy", srcID+" -> "+body.TargetID, "ok")
	dockercontainer.EmitStream(w, "✓ 复制完成")
}
