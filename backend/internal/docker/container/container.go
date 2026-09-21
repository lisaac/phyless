package container

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"
)

// ErrUploadTooLarge is returned before any Docker API call when an upload
// exceeds its caller-provided limit.
var ErrUploadTooLarge = errors.New("upload exceeds size limit")

const upgradeImageRefLabel = "io.phyless.upgrade-image-ref"
const maxInt64 = int64(^uint64(0) >> 1)

var upgradeOperationState = struct {
	sync.Mutex
	active map[string]struct{}
}{active: make(map[string]struct{})}

// ponytail: process-local reject-only locking; use distributed locking if
// multiple server instances share one Docker daemon.

func tryUpgradeOperation(containerID string) (func(), bool) {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return nil, false
	}
	upgradeOperationState.Lock()
	defer upgradeOperationState.Unlock()
	if _, ok := upgradeOperationState.active[containerID]; ok {
		return nil, false
	}
	upgradeOperationState.active[containerID] = struct{}{}
	return func() {
		upgradeOperationState.Lock()
		delete(upgradeOperationState.active, containerID)
		upgradeOperationState.Unlock()
	}, true
}

// streamEvent is one line of a newline-delimited JSON progress stream — the
// same {stream}/{error} shape docker load already uses, so a single frontend
// widget can render pull, load, create, and upgrade progress uniformly.
type streamEvent struct {
	Stream      string `json:"stream,omitempty"`
	Error       string `json:"error,omitempty"`
	ContainerID string `json:"container_id,omitempty"`
}

// EmitStream writes one formatted status line to a progress stream.
func EmitStream(w io.Writer, format string, a ...any) {
	json.NewEncoder(w).Encode(streamEvent{Stream: fmt.Sprintf(format, a...)}) //nolint:errcheck
}

// EmitDone writes the terminal success line, tagged with the resulting
// container's ID so the frontend can link straight to its detail page.
func EmitDone(w io.Writer, containerID, format string, a ...any) {
	json.NewEncoder(w).Encode(streamEvent{Stream: fmt.Sprintf(format, a...), ContainerID: containerID}) //nolint:errcheck
}

// EmitError writes a terminal error line to a progress stream.
func EmitError(w io.Writer, err error) {
	json.NewEncoder(w).Encode(streamEvent{Error: err.Error()}) //nolint:errcheck
}

// FileEntry is a directory listing entry returned by ExecListDir.
type FileEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	IsDir   bool   `json:"is_dir"`
	ModTime int64  `json:"mod_time"`
	Uname   string `json:"uname"`
	Uid     int    `json:"uid"`
	Gid     int    `json:"gid"`
}

// ExecListDir lists direct children of path by running ls inside the container.
// Only works for running containers; returns an error for stopped/distroless containers.
func ExecListDir(ctx context.Context, cli client.APIClient, containerID, path string) ([]FileEntry, error) {
	return execLs(ctx, cli, containerID, path)
}

func execLs(ctx context.Context, cli client.APIClient, containerID, path string) ([]FileEntry, error) {
	exec, err := cli.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		Cmd:          []string{"ls", "-la", "--", path},
		AttachStdout: true,
		AttachStderr: true,
		Env:          []string{"LANG=C", "LC_ALL=C"},
	})
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(exec.ID) == "" {
		return nil, fmt.Errorf("Docker returned an empty exec ID")
	}
	resp, err := cli.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
	if err != nil {
		return nil, err
	}
	defer resp.Close()
	stopClose := context.AfterFunc(ctx, resp.Close)
	defer stopClose()

	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, resp.Reader); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, fmt.Errorf("读取 ls 输出失败: %w", err)
	}
	if err := waitExec(ctx, cli, exec.ID); err != nil {
		return nil, err
	}

	if stdout.Len() == 0 {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = "ls 无输出"
		}
		return nil, fmt.Errorf("%s", msg)
	}

	var out []FileEntry
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		if e, ok := parseLsLine(scanner.Text()); ok {
			out = append(out, e)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("解析 ls 输出失败: %w", err)
	}
	return out, nil
}

// lsMonths maps 3-letter English month abbreviations to month numbers.
var lsMonths = map[string]int{
	"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
	"Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

// parseLsDate converts the three date fields from standard ls -la output to a Unix timestamp.
// month is a 3-letter abbreviation, day is a decimal string, yearOrTime is either "2024" or "10:30".
func parseLsDate(month, day, yearOrTime string) int64 {
	m := lsMonths[month]
	if m == 0 {
		return 0
	}
	d, _ := strconv.Atoi(strings.TrimSpace(day))
	now := time.Now()
	if strings.Contains(yearOrTime, ":") {
		// Recent file — time given but no year; assume current year.
		parts := strings.SplitN(yearOrTime, ":", 2)
		h, _ := strconv.Atoi(parts[0])
		min, _ := strconv.Atoi(parts[1])
		t := time.Date(now.Year(), time.Month(m), d, h, min, 0, 0, now.Location())
		if t.After(now.Add(24 * time.Hour)) {
			t = t.AddDate(-1, 0, 0) // future date means last year
		}
		return t.Unix()
	}
	year, _ := strconv.Atoi(strings.TrimSpace(yearOrTime))
	if year == 0 {
		return 0
	}
	return time.Date(year, time.Month(m), d, 0, 0, 0, 0, time.UTC).Unix()
}

// parseLsLine parses one line of `ls -la` (standard) output.
// Fields: perms nlinks owner group size month day year/time name…
func parseLsLine(line string) (FileEntry, bool) {
	fields := strings.Fields(line)
	// Need at least: perms nlinks owner group size month day year/time name
	if len(fields) < 9 {
		return FileEntry{}, false
	}
	perms := fields[0]
	if perms == "total" || perms[0] == 't' {
		return FileEntry{}, false // "total N" line
	}

	// Reconstruct filename: scan past 8 whitespace-separated tokens.
	name := filenameAfterFields(line, 8)
	if name == "" || name == "." || name == ".." {
		return FileEntry{}, false
	}
	// Strip symlink target: "linkname -> /target"
	if idx := strings.Index(name, " -> "); idx >= 0 {
		name = name[:idx]
	}

	size, _ := strconv.ParseInt(fields[4], 10, 64)
	modTime := parseLsDate(fields[5], fields[6], fields[7])

	return FileEntry{
		Name:    name,
		Size:    size,
		Mode:    perms,
		IsDir:   perms[0] == 'd',
		ModTime: modTime,
		Uname:   fields[2],
	}, true
}

// filenameAfterFields returns the substring of line after the first n whitespace-separated fields.
func filenameAfterFields(line string, n int) string {
	i := 0
	for f := 0; f < n; f++ {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		for i < len(line) && line[i] != ' ' && line[i] != '\t' {
			i++
		}
	}
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	return strings.TrimRight(line[i:], "\r\n")
}

// DownloadFile streams a single file from a container. Caller must close the returned ReadCloser.
func DownloadFile(ctx context.Context, cli client.APIClient, containerID, path string) (io.ReadCloser, error) {
	rc, _, err := cli.CopyFromContainer(ctx, containerID, path)
	return rc, err
}

// UploadFile uploads content (as a tar stream) to destPath in the container.
func UploadFile(ctx context.Context, cli client.APIClient, containerID, destPath string, content io.Reader) error {
	return cli.CopyToContainer(ctx, containerID, destPath, content, container.CopyToContainerOptions{})
}

// UploadTarFile bounds the raw upload before making a Docker API call, then
// streams a single-file tar from disk. The temporary file keeps request and
// tar data from becoming two in-memory copies of the same upload.
func UploadTarFile(ctx context.Context, cli client.APIClient, containerID, destPath, filename string, src io.Reader, maxBytes int64) error {
	if err := validateTarFilename(filename); err != nil {
		return err
	}
	if maxBytes < 0 {
		return fmt.Errorf("invalid upload limit")
	}
	tmp, err := os.CreateTemp("", "phyless-upload-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) //nolint:errcheck // best-effort cleanup after the request
	defer tmp.Close()        //nolint:errcheck

	if err := ctx.Err(); err != nil {
		return err
	}
	readLimit := maxBytes
	if maxBytes < maxInt64 {
		readLimit++
	}
	n, err := io.Copy(tmp, io.LimitReader(contextReader{ctx: ctx, reader: src}, readLimit))
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if n > maxBytes {
		return ErrUploadTooLarge
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		tw := tar.NewWriter(pw)
		streamErr := tw.WriteHeader(&tar.Header{Name: filename, Size: n, Mode: 0644})
		if streamErr == nil {
			_, streamErr = io.Copy(tw, tmp)
		}
		if closeErr := tw.Close(); streamErr == nil {
			streamErr = closeErr
		}
		_ = pw.CloseWithError(streamErr)
		done <- streamErr
	}()

	uploadErr := UploadFile(ctx, cli, containerID, destPath, pr)
	if uploadErr != nil {
		_ = pr.CloseWithError(uploadErr)
	} else {
		_ = pr.Close()
	}
	streamErr := <-done
	if uploadErr != nil {
		return uploadErr
	}
	return streamErr
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func validateTarFilename(filename string) error {
	if filename == "" || filename == "." || filename == ".." ||
		filepath.Base(filename) != filename || strings.ContainsAny(filename, `/\\`) || strings.ContainsRune(filename, 0) {
		return fmt.Errorf("invalid file name")
	}
	return nil
}

// ExecChecked runs an argv-only command and waits for Docker's exec process
// to exit. Callers still validate their own arguments; argv avoids shell
// injection and the command itself uses -- where supported.
func ExecChecked(ctx context.Context, cli client.APIClient, containerID string, cmd []string) error {
	if len(cmd) == 0 || strings.TrimSpace(cmd[0]) == "" {
		return fmt.Errorf("empty exec command")
	}
	execResp, err := cli.ContainerExecCreate(ctx, containerID, container.ExecOptions{Cmd: cmd})
	if err != nil {
		return err
	}
	if execResp.ID == "" {
		return fmt.Errorf("Docker returned an empty exec ID")
	}
	if err := cli.ContainerExecStart(ctx, execResp.ID, container.ExecStartOptions{}); err != nil {
		return err
	}
	return waitExec(ctx, cli, execResp.ID)
}

func waitExec(ctx context.Context, cli client.APIClient, execID string) error {
	if strings.TrimSpace(execID) == "" {
		return fmt.Errorf("Docker returned an empty exec ID")
	}
	for {
		inspect, err := cli.ContainerExecInspect(ctx, execID)
		if err != nil {
			return err
		}
		if !inspect.Running {
			if inspect.ExitCode != 0 {
				return fmt.Errorf("exec exited with status %d", inspect.ExitCode)
			}
			return nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// CopyBetweenContainers streams srcPath from one container straight into
// dstPath on another — the same two calls `docker cp` itself makes when both
// sides are containers (there's no single daemon endpoint for container-to-
// container copy); CopyFromContainer's tar output is piped directly into
// CopyToContainer without buffering the whole thing in memory.
func CopyBetweenContainers(ctx context.Context, cli client.APIClient, srcContainer, srcPath, dstContainer, dstPath string) error {
	rc, err := DownloadFile(ctx, cli, srcContainer, srcPath)
	if err != nil {
		return err
	}
	defer rc.Close()
	return UploadFile(ctx, cli, dstContainer, dstPath, rc)
}

// Duplicate creates a new container using another as a config template.
func Duplicate(ctx context.Context, cli client.APIClient, sourceID, newName string) (string, error) {
	info, err := cli.ContainerInspect(ctx, sourceID)
	if err != nil {
		return "", err
	}
	if info.Config == nil {
		return "", fmt.Errorf("container has no config")
	}
	if hasStaticNetworkAddress(info) {
		return "", fmt.Errorf("cannot safely duplicate a container with a static network address")
	}
	cfg := restoreConfig(info, image.InspectResponse{}) // same image: only drop the source's default hostname
	hostCfg := cloneHostConfig(info)
	sanitizeContainerNetworkMode(&cfg, hostCfg)
	resp, err := cli.ContainerCreate(ctx, &cfg, hostCfg, networkingConfig(info), nil, newName)
	if err != nil {
		return "", err
	}
	if resp.ID == "" {
		return "", fmt.Errorf("Docker returned an empty container ID")
	}
	return resp.ID, nil
}

// UpgradeImageRef returns the stable registry reference for a container. An
// upgraded container stores its pinned ID in Config.Image and this label keeps
// later upgrades pulling the original tag.
func UpgradeImageRef(info container.InspectResponse) string {
	if info.Config == nil {
		return ""
	}
	if ref := info.Config.Labels[upgradeImageRefLabel]; ref != "" {
		return ref
	}
	return info.Config.Image
}

func shortID(s string) string {
	if len(s) > 19 {
		return s[:19]
	}
	return s
}

// Upgrade pulls the latest image, compares it with the running container's image,
// and recreates the container only when a newer image is available.
// Returns the new container ID, or "" if already up to date.
func Upgrade(ctx context.Context, cli client.APIClient, containerID string, w io.Writer, opts image.PullOptions) (string, error) {
	return upgrade(ctx, cli, containerID, w, opts, false)
}

// UpgradeWithoutPull performs the same guarded upgrade using an image that a
// caller has already loaded into the daemon (for example browser-pull).
func UpgradeWithoutPull(ctx context.Context, cli client.APIClient, containerID string, w io.Writer) (string, error) {
	return upgrade(ctx, cli, containerID, w, image.PullOptions{}, true)
}

func cloneHostConfig(info container.InspectResponse) *container.HostConfig {
	var hostCfg container.HostConfig
	if info.HostConfig != nil {
		hostCfg = *info.HostConfig
		hostCfg.Mounts = append([]mount.Mount(nil), info.HostConfig.Mounts...)
		hostCfg.Binds = append([]string(nil), info.HostConfig.Binds...)
	} else {
		hasVolume := false
		for _, point := range info.Mounts {
			if point.Type == mount.TypeVolume && point.Name != "" {
				hasVolume = true
				break
			}
		}
		if !hasVolume {
			return nil
		}
	}
	if len(hostCfg.Binds) > 0 {
		binds := hostCfg.Binds[:0]
		for _, bind := range hostCfg.Binds {
			target := bindTarget(bind)
			if strings.TrimSpace(bind) == target {
				if point := mountPointAt(info.Mounts, target); point != nil && point.Type == mount.TypeVolume && point.Name != "" {
					continue // the Mounts entry below reuses the existing anonymous volume
				}
			}
			binds = append(binds, bind)
		}
		hostCfg.Binds = binds
	}
	knownTargets := make(map[string]struct{}, len(hostCfg.Mounts)+len(hostCfg.Binds))
	for i := range hostCfg.Mounts {
		knownTargets[hostCfg.Mounts[i].Target] = struct{}{}
		if hostCfg.Mounts[i].Type == mount.TypeVolume && hostCfg.Mounts[i].Source == "" {
			if point := mountPointAt(info.Mounts, hostCfg.Mounts[i].Target); point != nil {
				hostCfg.Mounts[i].Source = point.Name
			}
		}
	}
	for _, bind := range hostCfg.Binds {
		if target := bindTarget(bind); target != "" {
			knownTargets[target] = struct{}{}
		}
	}
	for _, point := range info.Mounts {
		if point.Type != mount.TypeVolume || point.Name == "" {
			continue
		}
		if _, exists := knownTargets[point.Destination]; exists {
			continue
		}
		hostCfg.Mounts = append(hostCfg.Mounts, mount.Mount{
			Type:     mount.TypeVolume,
			Source:   point.Name,
			Target:   point.Destination,
			ReadOnly: !point.RW,
		})
		knownTargets[point.Destination] = struct{}{}
	}
	if info.HostConfig == nil && len(hostCfg.Mounts) == 0 {
		return nil
	}
	return &hostCfg
}

func mountPointAt(points []container.MountPoint, target string) *container.MountPoint {
	for i := range points {
		if points[i].Destination == target {
			return &points[i]
		}
	}
	return nil
}

func bindTarget(bind string) string {
	parts := strings.Split(bind, ":")
	if len(parts) == 1 {
		return strings.TrimSpace(parts[0])
	}
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

func networkingConfig(info container.InspectResponse) *network.NetworkingConfig {
	if info.HostConfig != nil && info.HostConfig.NetworkMode.IsContainer() {
		return nil
	}
	return buildNetworkingConfig(info, nil)
}

func upgradeNetworkingConfig(ctx context.Context, cli client.APIClient, info container.InspectResponse) (*network.NetworkingConfig, error) {
	if info.HostConfig != nil && info.HostConfig.NetworkMode.IsContainer() {
		return nil, nil
	}
	drivers := make(map[string]string)
	if info.NetworkSettings != nil {
		for name, endpoint := range info.NetworkSettings.Networks {
			if endpoint == nil || !container.NetworkMode(name).IsUserDefined() {
				continue
			}
			networkInfo, err := cli.NetworkInspect(ctx, name, network.InspectOptions{})
			if err != nil {
				return nil, fmt.Errorf("无法检查网络 %s: %w", name, err)
			}
			drivers[name] = networkInfo.Driver
		}
	}
	return buildNetworkingConfig(info, drivers), nil
}

// drivers maps user-defined network names to their driver; macvlan/ipvlan
// endpoints keep their dynamic address (LAN-visible), macvlan also its MAC.
func buildNetworkingConfig(info container.InspectResponse, drivers map[string]string) *network.NetworkingConfig {
	if info.NetworkSettings == nil || len(info.NetworkSettings.Networks) == 0 {
		return nil
	}
	endpoints := make(map[string]*network.EndpointSettings, len(info.NetworkSettings.Networks))
	for name, endpoint := range info.NetworkSettings.Networks {
		if endpoint == nil {
			endpoints[name] = &network.EndpointSettings{}
			continue
		}
		ep := endpoint.Copy()
		ep.NetworkID = ""
		ep.EndpointID = ""
		ep.Gateway = ""
		ep.IPAddress = ""
		ep.IPPrefixLen = 0
		ep.IPv6Gateway = ""
		ep.GlobalIPv6Address = ""
		ep.GlobalIPv6PrefixLen = 0
		ep.MacAddress = ""
		ep.DNSNames = nil
		if drivers[name] == "macvlan" {
			ep.MacAddress = endpoint.MacAddress // DHCP reservations / ARP caches on the LAN key on it
		}
		if drivers[name] == "macvlan" || drivers[name] == "ipvlan" {
			ipam := ep.IPAMConfig
			if ipam == nil {
				ipam = &network.EndpointIPAMConfig{}
			} else {
				ipam = ipam.Copy()
			}
			if ipam.IPv4Address == "" {
				ipam.IPv4Address = endpoint.IPAddress
			}
			if ipam.IPv6Address == "" {
				ipam.IPv6Address = endpoint.GlobalIPv6Address
			}
			if ipam.IPv4Address != "" || ipam.IPv6Address != "" || len(ipam.LinkLocalIPs) > 0 {
				ep.IPAMConfig = ipam
			}
		}
		if !container.NetworkMode(name).IsUserDefined() {
			ep.Aliases = nil
		} else if len(info.ID) >= 12 {
			// Older daemons list the short container ID as an alias; it belongs to the old container.
			ep.Aliases = slices.DeleteFunc(slices.Clone(ep.Aliases), func(a string) bool { return a == info.ID[:12] })
		}
		endpoints[name] = ep
	}
	return &network.NetworkingConfig{EndpointsConfig: endpoints}
}

func endpointHasConfiguredAddress(endpoint *network.EndpointSettings) bool {
	return endpoint != nil && endpoint.IPAMConfig != nil && (endpoint.IPAMConfig.IPv4Address != "" || endpoint.IPAMConfig.IPv6Address != "" || len(endpoint.IPAMConfig.LinkLocalIPs) > 0)
}

func hasStaticNetworkAddress(info container.InspectResponse) bool {
	if info.NetworkSettings == nil {
		return false
	}
	for _, endpoint := range info.NetworkSettings.Networks {
		if endpoint == nil || endpoint.IPAMConfig == nil {
			continue
		}
		if endpoint.IPAMConfig.IPv4Address != "" || endpoint.IPAMConfig.IPv6Address != "" || len(endpoint.IPAMConfig.LinkLocalIPs) > 0 {
			return true
		}
	}
	return false
}

func hasUnsupportedStaticNetworkAddress(info container.InspectResponse) bool {
	if info.NetworkSettings == nil {
		return false
	}
	for name, endpoint := range info.NetworkSettings.Networks {
		if container.NetworkMode(name).IsUserDefined() || endpoint == nil || endpoint.IPAMConfig == nil {
			continue
		}
		if endpoint.IPAMConfig.IPv4Address != "" || endpoint.IPAMConfig.IPv6Address != "" || len(endpoint.IPAMConfig.LinkLocalIPs) > 0 {
			return true
		}
	}
	return false
}

func sanitizeContainerNetworkMode(cfg *container.Config, hostCfg *container.HostConfig) {
	if cfg == nil || hostCfg == nil || !hostCfg.NetworkMode.IsContainer() {
		return
	}
	cfg.Hostname = ""
	cfg.ExposedPorts = nil
	cfg.MacAddress = ""
	hostCfg.DNS = nil
	hostCfg.DNSSearch = nil
	hostCfg.DNSOptions = nil
	hostCfg.Links = nil
	hostCfg.ExtraHosts = nil
	hostCfg.PortBindings = nil
	hostCfg.PublishAllPorts = false
}

func validateUpgradeState(info container.InspectResponse) error {
	if info.State == nil {
		return fmt.Errorf("cannot safely upgrade a container with unknown state")
	}
	if info.State.Paused {
		return fmt.Errorf("cannot safely upgrade a paused container")
	}
	if info.State.Restarting {
		return fmt.Errorf("cannot safely upgrade a restarting container")
	}
	if info.State.Dead {
		return fmt.Errorf("cannot safely upgrade a dead container")
	}
	return nil
}

func upgradeCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
}

func rollbackUpgrade(ctx context.Context, cli client.APIClient, oldID, replacementID string, restoreRunning bool, restoreNetworking *network.NetworkingConfig, cause error) error {
	cleanupCtx, cancel := upgradeCleanupContext(ctx)
	defer cancel()
	var rollbackErrs []error
	if replacementID != "" {
		if err := cli.ContainerRemove(cleanupCtx, replacementID, container.RemoveOptions{Force: true}); err != nil && !errdefs.IsNotFound(err) {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("清理替代容器失败: %w", err))
		}
	}
	if restoreRunning {
		if err := restoreUpgradeNetworking(cleanupCtx, cli, oldID, restoreNetworking); err != nil {
			rollbackErrs = append(rollbackErrs, err)
		}
		if err := cli.ContainerStart(cleanupCtx, oldID, container.StartOptions{}); err != nil && !errdefs.IsNotModified(err) {
			rollbackErrs = append(rollbackErrs, fmt.Errorf("恢复原容器运行状态失败: %w", err))
		}
	}
	return errors.Join(append([]error{cause}, rollbackErrs...)...)
}

func restoreUpgradeNetworking(ctx context.Context, cli client.APIClient, containerID string, config *network.NetworkingConfig) error {
	if config == nil {
		return nil
	}
	var restoreErrs []error
	for name, endpoint := range config.EndpointsConfig {
		if endpoint == nil || !endpointHasConfiguredAddress(endpoint) {
			continue
		}
		if err := cli.NetworkDisconnect(ctx, name, containerID, true); err != nil && !errdefs.IsNotFound(err) {
			restoreErrs = append(restoreErrs, fmt.Errorf("恢复网络 %s 前断开旧端点失败: %w", name, err))
			continue
		}
		if err := cli.NetworkConnect(ctx, name, containerID, endpoint); err != nil {
			restoreErrs = append(restoreErrs, fmt.Errorf("恢复网络 %s 端点失败: %w", name, err))
		}
	}
	return errors.Join(restoreErrs...)
}

func restoreUpgradeName(ctx context.Context, cli client.APIClient, oldID, originalName string) error {
	cleanupCtx, cancel := upgradeCleanupContext(ctx)
	defer cancel()
	return cli.ContainerRename(cleanupCtx, oldID, originalName)
}

// GetByFilters returns containers matching given label/name filters.
func GetByFilters(ctx context.Context, cli client.APIClient, args filters.Args) ([]container.Summary, error) {
	return cli.ContainerList(ctx, container.ListOptions{All: true, Filters: args})
}
