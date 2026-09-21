package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/containerd/platforms"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/versions"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"phyless/backend/internal/docker"
)

// upgradeSettleTime is how long a started replacement must stay up before the
// original is discarded. A var so tests can shorten it.
var upgradeSettleTime = 5 * time.Second

// UpgradeOptions carries user decisions the config diff cannot make itself.
type UpgradeOptions struct {
	// EnvFromImage names variables whose current value should be dropped so the
	// new image supplies it (or it disappears if the image no longer sets it).
	// Used for values an older phyless froze from a previous image, which are
	// indistinguishable from deliberate overrides.
	EnvFromImage []string
}

func upgrade(ctx context.Context, cli client.APIClient, containerID string, w io.Writer, opts image.PullOptions, skipPull bool, uopts UpgradeOptions) (string, error) {
	info, err := cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return "", err
	}
	actualID := info.ID
	if actualID == "" {
		actualID = containerID
	}
	release, ok := tryUpgradeOperation(actualID)
	if !ok {
		return "", fmt.Errorf("container upgrade already in progress")
	}
	defer release()

	if info.Config == nil {
		return "", fmt.Errorf("container has no config")
	}
	if info.HostConfig != nil && info.HostConfig.AutoRemove {
		return "", fmt.Errorf("cannot safely upgrade an AutoRemove container")
	}
	if err := validateUpgradeState(info); err != nil {
		return "", err
	}
	if hasUnsupportedStaticNetworkAddress(info) {
		return "", fmt.Errorf("cannot safely upgrade a container with a static address on a predefined network")
	}
	originalName := strings.TrimPrefix(info.Name, "/")
	if originalName == "" {
		return "", fmt.Errorf("container has no name")
	}
	imageRef := UpgradeImageRef(info)
	if imageRef == "" {
		return "", fmt.Errorf("container has no image reference")
	}
	info.ID = actualID
	dependents, err := networkDependents(ctx, cli, info)
	if err != nil {
		return "", err
	}
	// Hold every dependent's lock for the whole upgrade so a parallel batch
	// task cannot replace one underneath us (or we under it).
	for _, dep := range dependents {
		depRelease, ok := tryUpgradeOperation(dep.ID)
		if !ok {
			return "", fmt.Errorf("共享本容器网络的 %s 正在升级，请稍后再试", strings.TrimPrefix(dep.Name, "/"))
		}
		defer depRelease()
	}

	oldImage, err := cli.ImageInspect(ctx, info.Image)
	if err != nil {
		return "", fmt.Errorf("无法检查原镜像平台: %w", err)
	}
	if oldImage.Os == "" || oldImage.Architecture == "" {
		return "", fmt.Errorf("原镜像平台信息缺失")
	}
	platform := ociPlatform(oldImage)
	if skipPull {
		EmitStream(w, "使用已下载镜像 %s …", imageRef)
	} else {
		opts.Platform = ImagePlatform(oldImage)
		EmitStream(w, "正在拉取镜像 %s …", imageRef)
		rc, err := cli.ImagePull(ctx, imageRef, opts)
		if err != nil {
			return "", fmt.Errorf("pull 失败: %w", err)
		}
		if rc == nil {
			return "", fmt.Errorf("pull 失败: Docker returned an empty progress stream")
		}
		if err := docker.ConsumeProgress(ctx, w, rc); err != nil {
			return "", fmt.Errorf("pull 失败: %w", err)
		}
	}

	newImg, _, err := cli.ImageInspectWithRaw(ctx, imageRef)
	if err != nil {
		return "", fmt.Errorf("无法检查新镜像: %w", err)
	}
	if newImg.ID == "" || !platforms.OnlyStrict(platform).Match(ociPlatform(newImg)) {
		return "", fmt.Errorf("新镜像 ID 或平台信息不匹配，保留原容器")
	}

	EmitStream(w, "当前镜像 ID: %s ｜ 新镜像 ID: %s", shortID(info.Image), shortID(newImg.ID))

	if newImg.ID == info.Image {
		if !slices.ContainsFunc(info.Config.Env, func(e string) bool {
			key, _, _ := strings.Cut(e, "=")
			return slices.Contains(uopts.EnvFromImage, key)
		}) {
			EmitStream(w, "✓ 已是最新版本，无需升级。")
			return "", nil
		}
		// Same image, but the user asked to drop stale variables: that still
		// needs a recreate.
		EmitStream(w, "镜像已是最新，按所选环境变量重建容器…")
	} else {
		EmitStream(w, "检测到新版本，开始重建容器…")
	}
	newID, stopped, err := replaceContainer(ctx, cli, w, replacement{
		info: info, name: originalName, imageRef: imageRef, imageID: newImg.ID, oldImage: oldImage, platform: platform,
		envFromImage: uopts.EnvFromImage,
	})
	if err != nil {
		if stopped {
			// The original is back under its old ID, but dependents still sit in
			// the namespace that died with its stop; a restart rejoins them.
			restartDependents(ctx, cli, w, dependents)
		}
		return "", err
	}
	mainRunning := info.State != nil && info.State.Running
	for _, dep := range dependents {
		depName := strings.TrimPrefix(dep.Name, "/")
		EmitStream(w, "重建共享本容器网络的 %s …", depName)
		if err := recreateDependent(ctx, cli, w, dep.ID, originalName, newID, mainRunning); err != nil {
			EmitStream(w, "⚠ %s 重建失败，请手动重建：%v", depName, err)
		}
	}
	EmitDone(w, newID, "✓ 升级完成，新容器 ID: %s", shortID(newID))
	return newID, nil
}

type replacement struct {
	info     container.InspectResponse // the container being replaced (ID resolved)
	name     string
	imageRef string // how Config.Image should read afterwards, e.g. nginx:latest
	imageID  string // the verified image the replacement must run
	oldImage image.InspectResponse
	platform ocispec.Platform
	// networkMode overrides HostConfig.NetworkMode; used to re-point containers
	// that shared the upgraded container's network namespace.
	networkMode  container.NetworkMode
	envFromImage []string
}

// replaceContainer swaps a container for one built from the same settings on
// imageID: create under a temporary name → stop the original → start and
// watch the replacement → take over the name → remove the original. Any
// failure before the name switch restores the original.
// stopped reports whether the original was stopped, i.e. whether containers
// sharing its network namespace lost their network even if it was restored.
func replaceContainer(ctx context.Context, cli client.APIClient, w io.Writer, r replacement) (newID string, stopped bool, err error) {
	if err := ctx.Err(); err != nil {
		return "", stopped, err
	}
	oldID := r.info.ID
	networking, err := upgradeNetworkingConfig(ctx, cli, r.info)
	if err != nil {
		return "", stopped, err
	}
	cfg := restoreConfig(r.info, r.oldImage)
	cfg.Env = slices.DeleteFunc(cfg.Env, func(e string) bool {
		key, _, _ := strings.Cut(e, "=")
		return slices.Contains(r.envFromImage, key)
	})
	// Keep Config.Image as the user wrote it while that tag still resolves to
	// the verified image; otherwise pin the ID and remember the tag in a label.
	delete(cfg.Labels, upgradeImageRefLabel)
	cfg.Image = r.imageRef
	if tagged, err := cli.ImageInspect(ctx, r.imageRef); err != nil || tagged.ID != r.imageID {
		cfg.Image = r.imageID
		if cfg.Labels == nil {
			cfg.Labels = make(map[string]string)
		}
		cfg.Labels[upgradeImageRefLabel] = r.imageRef
	}
	hostCfg := cloneHostConfig(r.info)
	if r.networkMode != "" {
		if hostCfg == nil {
			hostCfg = &container.HostConfig{}
		}
		hostCfg.NetworkMode = r.networkMode
	}
	sanitizeContainerNetworkMode(&cfg, hostCfg)
	createNet, extraNets := splitNetworking(cli, hostCfg, networking)

	newName := "phyless-upgrade-" + shortID(oldID)
	oldRunning := r.info.State != nil && r.info.State.Running
	resp, err := cli.ContainerCreate(ctx, &cfg, hostCfg, createNet, &r.platform, newName)
	if err != nil {
		if resp.ID != "" {
			return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, nil, fmt.Errorf("创建容器失败: %w", err))
		}
		return "", stopped, fmt.Errorf("创建容器失败: %w", err)
	}
	if resp.ID == "" {
		return "", stopped, fmt.Errorf("创建容器失败: Docker returned an empty container ID")
	}
	for _, name := range slices.Sorted(maps.Keys(extraNets)) {
		if err := cli.NetworkConnect(ctx, name, resp.ID, extraNets[name]); err != nil {
			return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, nil, fmt.Errorf("接入网络 %s 失败: %w", name, err))
		}
	}
	var restoreNetworking *network.NetworkingConfig
	if err := ctx.Err(); err != nil {
		return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, nil, err)
	}
	if oldRunning {
		if err := cli.ContainerStop(ctx, oldID, container.StopOptions{}); err != nil && !errdefs.IsNotModified(err) {
			return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, nil, fmt.Errorf("停止容器失败: %w", err))
		}
		stopped = true
		restoreNetworking = networking
		if err := ctx.Err(); err != nil {
			return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, err)
		}
		if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
			return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, fmt.Errorf("启动容器失败: %w", err))
		}
	}
	if err := settleReplacement(ctx, cli, w, resp.ID, r.imageID, oldRunning); err != nil {
		return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, err)
	}
	backupName := newName + "-old"
	if err := cli.ContainerRename(ctx, oldID, backupName); err != nil {
		return "", stopped, rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, fmt.Errorf("暂存原容器名称失败: %w", err))
	}
	if err := ctx.Err(); err != nil {
		nameErr := restoreUpgradeName(ctx, cli, oldID, r.name)
		cleanupErr := rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, err)
		return "", stopped, errors.Join(cleanupErr, nameErr)
	}
	if err := cli.ContainerRename(ctx, resp.ID, r.name); err != nil {
		rollbackErr := restoreUpgradeName(ctx, cli, oldID, r.name)
		cleanupErr := rollbackUpgrade(ctx, cli, oldID, resp.ID, oldRunning, restoreNetworking, fmt.Errorf("切换新容器名称失败: %w", err))
		return "", stopped, errors.Join(cleanupErr, rollbackErr)
	}
	cleanupCtx, cancel := upgradeCleanupContext(ctx)
	removeErr := cli.ContainerRemove(cleanupCtx, oldID, container.RemoveOptions{Force: true})
	cancel()
	if removeErr != nil && !errdefs.IsNotFound(removeErr) {
		EmitStream(w, "⚠ 升级已切换成功，但旧容器清理失败（备份名称: %s）：%v", backupName, removeErr)
	}
	return resp.ID, stopped, nil
}

// restoreConfig rebuilds what the user actually configured. The inspected
// Config already has the old image's defaults (ENV, CMD, labels, …) merged
// in; copying them verbatim would freeze the old image's values over the new
// image's. Like watchtower's GetCreateConfig, values equal to the old image's
// defaults are dropped so the new image supplies its own.
func restoreConfig(info container.InspectResponse, oldImage image.InspectResponse) container.Config {
	cfg := *info.Config
	cfg.Labels = maps.Clone(cfg.Labels)
	cfg.Env = slices.Clone(cfg.Env)
	cfg.ExposedPorts = maps.Clone(cfg.ExposedPorts)
	cfg.Volumes = maps.Clone(cfg.Volumes)
	// Docker's default hostname is the short container ID; keeping it would
	// name the replacement after the container it replaced.
	if len(info.ID) >= 12 && cfg.Hostname == info.ID[:12] {
		cfg.Hostname = ""
	}
	// Containers replaced by earlier phyless versions carry their predecessor's
	// short ID as hostname; the pin label marks them.
	if _, legacy := cfg.Labels[upgradeImageRefLabel]; legacy && shortHexID(cfg.Hostname) {
		cfg.Hostname = ""
	}
	if img := oldImage.Config; img != nil {
		if cfg.WorkingDir == img.WorkingDir {
			cfg.WorkingDir = ""
		}
		if cfg.User == img.User {
			cfg.User = ""
		}
		if cfg.StopSignal == img.StopSignal {
			cfg.StopSignal = ""
		}
		// `--entrypoint X` with X equal to the image's still drops the image CMD;
		// clearing Entrypoint there would bring that CMD back.
		cmdDroppedByEntrypoint := len(cfg.Cmd) == 0 && len(img.Cmd) > 0
		if slices.Equal([]string(cfg.Entrypoint), img.Entrypoint) && !cmdDroppedByEntrypoint {
			cfg.Entrypoint = nil
			// With a custom entrypoint Docker drops the image CMD, so CMD is only
			// a default when the entrypoint is one too.
			if slices.Equal([]string(cfg.Cmd), img.Cmd) {
				cfg.Cmd = nil
			}
		}
		if slices.Equal([]string(cfg.Shell), img.Shell) {
			cfg.Shell = nil
		}
		if slices.Equal(cfg.OnBuild, img.OnBuild) {
			cfg.OnBuild = nil
		}
		if h, ih := cfg.Healthcheck, img.Healthcheck; h != nil && ih != nil && slices.Equal(h.Test, ih.Test) &&
			h.Interval == ih.Interval && h.Timeout == ih.Timeout && h.StartPeriod == ih.StartPeriod &&
			h.StartInterval == ih.StartInterval && h.Retries == ih.Retries {
			cfg.Healthcheck = nil
		}
		cfg.Env = slices.DeleteFunc(cfg.Env, func(e string) bool { return slices.Contains(img.Env, e) })
		maps.DeleteFunc(cfg.Labels, func(k, v string) bool { iv, ok := img.Labels[k]; return ok && iv == v })
		maps.DeleteFunc(cfg.Volumes, func(k string, _ struct{}) bool { _, ok := img.Volumes[k]; return ok })
		maps.DeleteFunc(map[nat.Port]struct{}(cfg.ExposedPorts), func(p nat.Port, _ struct{}) bool { _, ok := img.ExposedPorts[string(p)]; return ok })
	}
	// Published ports must stay exposed even if the new image stops declaring them.
	if info.HostConfig != nil {
		for p := range info.HostConfig.PortBindings {
			if cfg.ExposedPorts == nil {
				cfg.ExposedPorts = nat.PortSet{}
			}
			cfg.ExposedPorts[p] = struct{}{}
		}
	}
	return cfg
}

// splitNetworking: daemons before API 1.44 (Docker < 25) accept a single
// endpoint at create; the rest are connected before the replacement starts.
func splitNetworking(cli client.APIClient, hostCfg *container.HostConfig, n *network.NetworkingConfig) (*network.NetworkingConfig, map[string]*network.EndpointSettings) {
	if n == nil || len(n.EndpointsConfig) <= 1 || !versions.LessThan(cli.ClientVersion(), "1.44") {
		return n, nil
	}
	primary := ""
	if hostCfg != nil {
		if _, ok := n.EndpointsConfig[string(hostCfg.NetworkMode)]; ok {
			primary = string(hostCfg.NetworkMode)
		}
	}
	if primary == "" {
		primary = slices.Sorted(maps.Keys(n.EndpointsConfig))[0]
	}
	extra := maps.Clone(n.EndpointsConfig)
	delete(extra, primary)
	return &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{primary: n.EndpointsConfig[primary]}}, extra
}

// settleReplacement confirms the replacement runs the verified image and, when
// started, stays up for upgradeSettleTime instead of crashing or crash-looping
// — checked while the original still exists to roll back to.
func settleReplacement(ctx context.Context, cli client.APIClient, w io.Writer, id, imageID string, started bool) error {
	deadline := time.Now().Add(upgradeSettleTime)
	for {
		st, err := cli.ContainerInspect(ctx, id)
		if err != nil {
			return fmt.Errorf("无法检查新容器: %w", err)
		}
		if st.ContainerJSONBase != nil && st.Image != "" && st.Image != imageID {
			return fmt.Errorf("新容器镜像 %s 与预期 %s 不符", shortID(st.Image), shortID(imageID))
		}
		if !started {
			return nil
		}
		if s := st.State; st.ContainerJSONBase != nil && s != nil && (s.Restarting || s.OOMKilled || (!s.Running && s.ExitCode != 0)) {
			emitTailLogs(ctx, cli, w, id)
			return fmt.Errorf("新容器启动后异常退出（exit %d），已恢复原容器", s.ExitCode)
		}
		if !time.Now().Before(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func emitTailLogs(ctx context.Context, cli client.APIClient, w io.Writer, id string) {
	rc, err := cli.ContainerLogs(ctx, id, container.LogsOptions{ShowStdout: true, ShowStderr: true, Tail: "20"})
	if err != nil {
		return
	}
	defer rc.Close()
	var out bytes.Buffer
	// ponytail: assumes a non-TTY container (multiplexed stream); TTY logs are skipped.
	if _, err := stdcopy.StdCopy(&out, &out, io.LimitReader(rc, 64<<10)); err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimRight(out.String(), "\n"), "\n") {
		if line != "" {
			EmitStream(w, "  | %s", line)
		}
	}
}

// networkDependents lists containers sharing this container's network
// namespace (network_mode: container:<it>). Replacing the container leaves
// them in a dead namespace, so they are recreated right after the switch —
// watchtower restarts linked containers for the same reason.
func networkDependents(ctx context.Context, cli client.APIClient, info container.InspectResponse) ([]container.InspectResponse, error) {
	list, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("无法列出容器: %w", err)
	}
	name := strings.TrimPrefix(info.Name, "/")
	var deps []container.InspectResponse
	for _, c := range list {
		target, ok := strings.CutPrefix(c.HostConfig.NetworkMode, "container:")
		if !ok || target == "" || c.ID == info.ID || (target != name && !strings.HasPrefix(info.ID, target)) {
			continue
		}
		dep, err := cli.ContainerInspect(ctx, c.ID)
		if err != nil {
			return nil, fmt.Errorf("无法检查共享网络的容器: %w", err)
		}
		depName := strings.TrimPrefix(dep.Name, "/")
		if dep.Config == nil || dep.HostConfig == nil || depName == "" || validateUpgradeState(dep) != nil || dep.HostConfig.AutoRemove {
			return nil, fmt.Errorf("容器 %s 共享本容器的网络，但当前状态无法安全重建，请先处理它", depName)
		}
		deps = append(deps, dep)
	}
	return deps, nil
}

func restartDependents(ctx context.Context, cli client.APIClient, w io.Writer, deps []container.InspectResponse) {
	cleanupCtx, cancel := upgradeCleanupContext(ctx)
	defer cancel()
	for _, dep := range deps {
		if dep.State == nil || !dep.State.Running {
			continue
		}
		if err := cli.ContainerRestart(cleanupCtx, dep.ID, container.StopOptions{}); err != nil {
			EmitStream(w, "⚠ 恢复 %s 的网络失败，请手动重启：%v", strings.TrimPrefix(dep.Name, "/"), err)
		}
	}
}

// recreateDependent re-points a dependent at the replacement. It re-inspects
// first: the list taken before the pull may be stale. The caller holds its lock.
func recreateDependent(ctx context.Context, cli client.APIClient, w io.Writer, depID, mainName, newMainID string, mainRunning bool) error {
	dep, err := cli.ContainerInspect(ctx, depID)
	if err != nil {
		return err
	}
	if dep.Config == nil || dep.HostConfig == nil || dep.State == nil {
		return errors.New("容器信息不完整")
	}
	img, err := cli.ImageInspect(ctx, dep.Image)
	if err != nil {
		return fmt.Errorf("无法检查镜像: %w", err)
	}
	mode := dep.HostConfig.NetworkMode
	if strings.TrimPrefix(string(mode), "container:") != mainName {
		mode = container.NetworkMode("container:" + newMainID) // referenced by ID: point at the replacement
	}
	if !mainRunning && dep.State.Running {
		// It cannot join a stopped container's namespace; recreate it stopped
		// (it was already cut off) instead of failing and rolling back.
		state := *dep.State
		state.Running = false
		dep.State = &state
		if err := cli.ContainerStop(ctx, dep.ID, container.StopOptions{}); err != nil && !errdefs.IsNotModified(err) {
			return fmt.Errorf("停止容器失败: %w", err)
		}
		EmitStream(w, "主容器未运行，%s 将重建为停止状态", strings.TrimPrefix(dep.Name, "/"))
	}
	_, _, err = replaceContainer(ctx, cli, w, replacement{
		info:        dep,
		name:        strings.TrimPrefix(dep.Name, "/"),
		imageRef:    UpgradeImageRef(dep),
		imageID:     dep.Image,
		oldImage:    img,
		platform:    ociPlatform(img),
		networkMode: mode,
	})
	return err
}

func ociPlatform(img image.InspectResponse) ocispec.Platform {
	return platforms.Normalize(ocispec.Platform{OS: img.Os, Architecture: img.Architecture, Variant: img.Variant})
}

func shortHexID(s string) bool {
	if len(s) != 12 {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}
