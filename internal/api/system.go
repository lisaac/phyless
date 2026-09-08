package api

import (
	"net/http"
	"strings"
)

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
