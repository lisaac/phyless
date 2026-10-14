// Package self lets phyless recognise its own container and hand operations
// that would stop it (upgrade, compose up/restart) to a one-shot helper
// container, which outlives the phyless process it replaces.
package self

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"

	"phyless/backend/internal/docker"
)

const (
	markerPrefix = ".phyless-self-"
	HelperName   = "phyless-helper"
	HelperRole   = "helper"
)

// marker is the absolute marker path; empty when Init was not called (the
// helper process, tests), which disables detection.
var marker string

// Init writes a fresh hidden marker into the working directory (falling back
// to dataDir when that is read-only) after removing markers left by earlier
// runs. Inside a container the marker sits in that container's filesystem, so
// ContainerStatPath finds it only there; run bare, it sits on the host and no
// container ever matches.
func Init(dataDir string) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		log.Printf("self: no marker: %v", err)
		return
	}
	for _, dir := range []string{".", dataDir} {
		abs, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		stale, _ := filepath.Glob(filepath.Join(abs, markerPrefix+"*"))
		for _, path := range stale {
			_ = os.Remove(path)
		}
		path := filepath.Join(abs, markerPrefix+hex.EncodeToString(nonce))
		if err := os.WriteFile(path, nil, 0o600); err == nil {
			marker = path
			return
		}
	}
	log.Printf("self: cannot write marker; own-container detection disabled")
}

// ID scans the daemon's running containers for the one holding this
// process's marker: "" when phyless runs bare or the daemon is on another
// host. phyless's own container is running before the process starts, so one
// successful scan is final; callers cache it per Docker runtime. The container
// whose short ID is the hostname (Docker's default) is tried first, so the
// usual case costs one stat. Errors other than "not found" are returned so a
// transient failure is never cached as "not ours".
func ID(ctx context.Context, cli client.APIClient) (string, error) {
	if marker == "" {
		return "", nil
	}
	list, err := cli.ContainerList(ctx, container.ListOptions{})
	if err != nil {
		return "", err
	}
	host, _ := os.Hostname()
	slices.SortStableFunc(list, func(a, b container.Summary) int {
		return rank(a.ID, host) - rank(b.ID, host)
	})
	for _, c := range list {
		_, err := cli.ContainerStatPath(ctx, c.ID, marker)
		if err == nil {
			return c.ID, nil
		}
		if !errdefs.IsNotFound(err) {
			return "", err
		}
	}
	return "", nil
}

func rank(id, host string) int {
	if host != "" && strings.HasPrefix(id, host) {
		return 0
	}
	return 1
}

// handoffEvent marks the point after which the stream may end because the
// helper stopped phyless; the client then polls /api/system/helper. stops
// tells it phyless will not come back (compose stop/down), so losing the
// backend is the outcome rather than a restart to wait for.
func handoffEvent(w io.Writer, stops bool) {
	msg := "phyless 将由 helper 容器完成此操作并重启，页面会在重启后自动重连…"
	if stops {
		msg = "phyless 将由 helper 容器完成此操作，之后 phyless 停止运行，需在主机上手动启动"
	}
	json.NewEncoder(w).Encode(map[string]any{"stream": msg, "helper": true, "stops": stops}) //nolint:errcheck
	flush(w)
}

// Launch starts the helper with `phyless -C <dataDir> helper <args...>` and
// relays its NDJSON output to w until the helper exits — or until this process
// is stopped by it, which is the expected end of a successful self-upgrade.
func Launch(ctx context.Context, cli client.APIClient, selfID, dataDir string, w io.Writer, stops bool, args ...string) error {
	me, err := cli.ContainerInspect(ctx, selfID)
	if err != nil {
		return err
	}
	if me.Config == nil || me.HostConfig == nil {
		return fmt.Errorf("cannot inspect own container")
	}
	if old, err := cli.ContainerInspect(ctx, HelperName); err == nil {
		if old.State != nil && old.State.Running {
			return fmt.Errorf("已有 phyless 自身操作正在进行，请稍后再试")
		}
		if err := cli.ContainerRemove(ctx, old.ID, container.RemoveOptions{Force: true}); err != nil && !errdefs.IsNotFound(err) {
			return fmt.Errorf("清理旧 helper 失败: %w", err)
		}
	} else if !errdefs.IsNotFound(err) {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	// Same image, user, groups, env and network as this process, and every
	// mount via VolumesFrom: the helper sees the Docker socket, data dir and
	// compose files exactly where phyless does. Never share our network
	// namespace (container:<self>) — it dies with us.
	netMode := me.HostConfig.NetworkMode
	if netMode.IsContainer() && netMode.ConnectedContainer() == me.ID {
		netMode = "bridge"
	}
	var netCfg *network.NetworkingConfig
	if me.NetworkSettings != nil && netMode.IsUserDefined() {
		if ep, ok := me.NetworkSettings.Networks[string(netMode)]; ok {
			netCfg = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
				string(netMode): {NetworkID: ep.NetworkID},
			}}
		}
	}
	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image:      me.Image,
		Entrypoint: []string{exe},
		Cmd:        append([]string{"-C", absData, "helper"}, args...),
		Env:        me.Config.Env,
		User:       me.Config.User,
		WorkingDir: me.Config.WorkingDir,
		Labels:     map[string]string{docker.RoleLabel: HelperRole},
	}, &container.HostConfig{
		VolumesFrom:   []string{me.ID},
		NetworkMode:   netMode,
		GroupAdd:      me.HostConfig.GroupAdd,
		SecurityOpt:   me.HostConfig.SecurityOpt,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
	}, netCfg, nil, HelperName)
	if err != nil {
		return fmt.Errorf("创建 helper 失败: %w", err)
	}
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = cli.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true})
		return fmt.Errorf("启动 helper 失败: %w", err)
	}
	handoffEvent(w, stops)
	logs, err := cli.ContainerLogs(ctx, resp.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true, Follow: true})
	if err != nil {
		return err
	}
	defer logs.Close()
	pr, pw := io.Pipe()
	defer pr.Close() // unblocks the copier if scanning stops early (oversized line)
	go func() { _, err := stdcopy.StdCopy(pw, pw, logs); pw.CloseWithError(err) }()
	sc := bufio.NewScanner(pr)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !json.Valid(line) {
			line, _ = json.Marshal(map[string]string{"stream": string(line)})
		}
		_, _ = w.Write(append(line, '\n'))
		flush(w)
	}
	_ = sc.Err() // a broken log stream only ends the relay; the helper's outcome is read below
	// Still alive: the helper finished without stopping us (failed early, or
	// nothing needed recreating).
	st, err := cli.ContainerInspect(context.WithoutCancel(ctx), resp.ID)
	if err == nil && st.State != nil && !st.State.Running && st.State.ExitCode != 0 {
		return fmt.Errorf("helper 退出码 %d", st.State.ExitCode)
	}
	return nil
}

// Result is the outcome of the most recent helper run.
type Result struct {
	State    string `json:"state"` // none | running | ok | failed
	Error    string `json:"error,omitempty"`
	Message  string `json:"message,omitempty"`
	Finished string `json:"finished_at,omitempty"`
}

// LastResult reads the kept helper container. The helper is left in place
// after it exits so this survives the restart it caused.
func LastResult(ctx context.Context, cli client.APIClient) (Result, error) {
	info, err := cli.ContainerInspect(ctx, HelperName)
	if errdefs.IsNotFound(err) {
		return Result{State: "none"}, nil
	}
	if err != nil {
		return Result{}, err
	}
	if info.State != nil && info.State.Running {
		return Result{State: "running"}, nil
	}
	res := Result{State: "ok"}
	if info.State != nil {
		res.Finished = info.State.FinishedAt
		if info.State.ExitCode != 0 {
			res.State = "failed"
			res.Error = fmt.Sprintf("helper 退出码 %d", info.State.ExitCode)
		}
	}
	rc, err := cli.ContainerLogs(ctx, info.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true, Tail: "50"})
	if err != nil {
		return res, nil
	}
	defer rc.Close()
	var out strings.Builder
	_, _ = stdcopy.StdCopy(&out, &out, io.LimitReader(rc, 1<<20))
	for line := range strings.SplitSeq(out.String(), "\n") {
		var evt struct{ Stream, Error string }
		if json.Unmarshal([]byte(line), &evt) != nil {
			continue
		}
		if evt.Error != "" {
			res.State, res.Error = "failed", evt.Error
		} else if s := strings.TrimSpace(evt.Stream); s != "" {
			res.Message = s
		}
	}
	return res, nil
}

func flush(w io.Writer) {
	if f, ok := w.(interface{ Flush() }); ok {
		f.Flush()
	}
}
