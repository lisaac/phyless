package api

import (
	"net/http"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"

	"phyless/backend/internal/docker/imagefs"
)

// dockerInfoResponse deliberately exposes only operational metadata. In
// particular, Docker's Info also contains proxy and registry configuration,
// which does not belong in a browser response.
type dockerInfoResponse struct {
	HostName         string `json:"host_name"`
	ServerVersion    string `json:"server_version"`
	APIVersion       string `json:"api_version"`
	MinAPIVersion    string `json:"min_api_version"`
	OperatingSystem  string `json:"operating_system"`
	OSType           string `json:"os_type"`
	Architecture     string `json:"architecture"`
	KernelVersion    string `json:"kernel_version"`
	NCPU             int    `json:"n_cpu"`
	MemTotal         int64  `json:"mem_total"`
	NGoroutines      int    `json:"n_goroutines"`
	NFd              int    `json:"n_fds"`
	DockerRootDir    string `json:"docker_root_dir"`
	StorageDriver    string `json:"storage_driver"`
	StorageAvailable string `json:"storage_available,omitempty"`
	CgroupDriver     string `json:"cgroup_driver"`
	CgroupVersion    string `json:"cgroup_version"`
	LoggingDriver    string `json:"logging_driver"`
	DefaultRuntime   string `json:"default_runtime"`
	LiveRestore      bool   `json:"live_restore"`
}

// handleSystemInfo returns the small, non-secret part of Docker's daemon
// metadata that is useful on the overview. Keep this separate from /platform:
// that endpoint is deliberately minimal because it is also used by image pull.
func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	version, err := s.docker.ServerVersion(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "无法获取 Docker 版本信息")
		return
	}
	info, err := s.docker.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "无法获取 Docker 信息")
		return
	}
	serverVersion := version.Version
	if serverVersion == "" {
		serverVersion = info.ServerVersion
	}
	writeJSON(w, http.StatusOK, dockerInfoResponse{
		HostName:         info.Name,
		ServerVersion:    serverVersion,
		APIVersion:       version.APIVersion,
		MinAPIVersion:    version.MinAPIVersion,
		OperatingSystem:  info.OperatingSystem,
		OSType:           strings.ToLower(info.OSType),
		Architecture:     normalizeArch(info.Architecture),
		KernelVersion:    info.KernelVersion,
		NCPU:             info.NCPU,
		MemTotal:         info.MemTotal,
		NGoroutines:      info.NGoroutines,
		NFd:              info.NFd,
		DockerRootDir:    info.DockerRootDir,
		StorageDriver:    info.Driver,
		StorageAvailable: driverStatusValue(info.DriverStatus, "Data Space Available"),
		CgroupDriver:     info.CgroupDriver,
		CgroupVersion:    info.CgroupVersion,
		LoggingDriver:    info.LoggingDriver,
		DefaultRuntime:   info.DefaultRuntime,
		LiveRestore:      info.LiveRestoreEnabled,
	})
}

func driverStatusValue(status [][2]string, label string) string {
	for _, item := range status {
		if strings.EqualFold(strings.TrimSpace(item[0]), label) {
			return strings.TrimSpace(item[1])
		}
	}
	return ""
}

// handleSystemPlatform reports the Docker daemon's OS/architecture so the
// browser-download flow can pick the right image platform. The browser cannot
// otherwise learn the daemon arch (the server-side proxy reads it from Info),
// so without this it would fall back to linux/amd64 and load the wrong image on
// an arm64 daemon.
func (s *Server) handleSystemPlatform(w http.ResponseWriter, r *http.Request) {
	info, err := s.docker.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "无法获取 Docker 平台信息")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"os":           strings.ToLower(info.OSType),
		"architecture": normalizeArch(info.Architecture),
	})
}

// normalizeArch maps the aliases Docker commonly reports to the values used in
// OCI platform selection (matching containerd/platforms normalization).
func normalizeArch(raw string) string {
	arch := strings.ToLower(strings.TrimSpace(raw))
	switch arch {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	case "armv7l", "armhf":
		return "arm"
	default:
		return arch
	}
}

// Summary skips usage joins, sorting and Compose YAML loads required by list views.
func (s *Server) handleSystemSummary(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, 500, "failed to read projects")
		return
	}
	ctx := r.Context()
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		writeError(w, 503, "cannot list containers")
		return
	}
	images, err := s.docker.ImageList(ctx, image.ListOptions{All: true})
	if err != nil {
		writeError(w, 503, "cannot list images")
		return
	}
	volumes, err := s.docker.VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		writeError(w, 503, "cannot list volumes")
		return
	}
	networks, err := s.docker.NetworkList(ctx, network.ListOptions{})
	if err != nil {
		writeError(w, 503, "cannot list networks")
		return
	}
	total, running := 0, 0
	for _, c := range containers {
		if imagefs.IsHelper(c.Labels) {
			continue
		}
		total++
		if c.State == "running" {
			running++
		}
	}
	writeJSON(w, 200, map[string]int{
		"containers": total, "running": running, "images": len(images),
		"compose": len(mergeFilesystemCompose(mergeComposeProjects(cfg.ComposeProjects, groupComposeContainers(containers)), cfg)),
		"volumes": len(volumes.Volumes), "networks": len(networks),
	})
}
