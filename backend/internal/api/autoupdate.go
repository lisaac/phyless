package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/go-chi/chi/v5"
	"phyless/backend/internal/autoupdate"
	dockercompose "phyless/backend/internal/docker/compose"
	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

// Outcomes recorded in AutoUpdatePolicy.LastStatus.
const (
	autoRunning   = "running"
	autoLatest    = "latest"
	autoAvailable = "available" // check mode: an update exists, nothing changed
	autoUpdated   = "updated"
	autoHandedOff = "handed-off" // phyless itself: the helper finishes and audits it
	autoSkipped   = "skipped"    // needs a person; LastError says why
	autoError     = "error"

	autoUpdateUser    = "auto-update"
	autoUpdateTimeout = time.Hour
	autoLogLines      = 30
	autoLogLineMax    = 300
)

func (s *Server) mountAutoUpdateRoutes(r chi.Router) {
	r.Get("/api/auto-updates", s.handleListAutoUpdates)
	r.Put("/api/auto-updates", s.handlePutAutoUpdate)
	r.Delete("/api/auto-updates/{id}", s.handleDeleteAutoUpdate)
	r.Post("/api/auto-updates/{id}/run", s.handleRunAutoUpdate)
}

// newAutoUpdater runs this Docker server's policies; one per runtime, so a
// server switch stops it with the runtime context.
func (s *Server) newAutoUpdater() *autoupdate.Runner {
	return autoupdate.New(s.autoUpdatePolicies, func(ctx context.Context, p models.AutoUpdatePolicy) {
		s.runAutoUpdate(ctx, p, io.Discard)
	})
}

func (s *Server) autoUpdatePolicies() ([]models.AutoUpdatePolicy, error) {
	cfg, err := s.store.Read()
	if err != nil {
		return nil, err
	}
	out := []models.AutoUpdatePolicy{}
	for _, p := range cfg.AutoUpdates {
		if p.ServerID == s.serverID {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *Server) wakeAutoUpdater() {
	if s.autoUpdater != nil {
		s.autoUpdater.Wake()
	}
}

func (s *Server) handleListAutoUpdates(w http.ResponseWriter, r *http.Request) {
	ps, err := s.autoUpdatePolicies()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

// handlePutAutoUpdate creates or replaces the one policy of a target. Run
// results are kept; saving restarts the schedule from now.
func (s *Server) handlePutAutoUpdate(w http.ResponseWriter, r *http.Request) {
	var in models.AutoUpdatePolicy
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := s.validateAutoUpdate(r.Context(), in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var saved models.AutoUpdatePolicy
	err := s.store.Update(func(cfg *store.Config) error {
		i := slices.IndexFunc(cfg.AutoUpdates, func(p models.AutoUpdatePolicy) bool {
			return p.ServerID == s.serverID && ((in.ID != "" && p.ID == in.ID) || (p.Kind == in.Kind && p.Target == in.Target))
		})
		next := models.AutoUpdatePolicy{
			Kind: in.Kind, Target: in.Target, ServerID: s.serverID, Enabled: in.Enabled, Mode: in.Mode, Schedule: in.Schedule,
			ProxyURL: in.ProxyURL, RegistryIDs: in.RegistryIDs, RemoveOldImage: in.RemoveOldImage, UpdatedAt: time.Now(),
		}
		if i < 0 {
			next.ID = newPolicyID()
			cfg.AutoUpdates = append(cfg.AutoUpdates, next)
		} else {
			old := cfg.AutoUpdates[i]
			next.ID, next.LastRunAt, next.LastStatus, next.LastError, next.LastLog = old.ID, old.LastRunAt, old.LastStatus, old.LastError, old.LastLog
			cfg.AutoUpdates[i] = next
		}
		saved = next
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.wakeAutoUpdater()
	s.auditFromCtx(r, "autoupdate.save", in.Kind+":"+in.Target, "ok")
	writeJSON(w, http.StatusOK, saved)
}

func (s *Server) validateAutoUpdate(ctx context.Context, p models.AutoUpdatePolicy) error {
	switch {
	case p.Kind != "container" && p.Kind != "compose":
		return errors.New("kind must be container or compose")
	case p.Target == "":
		return errors.New("target required")
	case p.Mode != "check" && p.Mode != "update":
		return errors.New("mode must be check or update")
	}
	if err := autoupdate.Validate(p.Schedule); err != nil {
		return err
	}
	if _, err := s.pullContext(ctx, p.ProxyURL); err != nil {
		return err
	}
	_, err := s.composeRegistryAuth(p.RegistryIDs)
	return err
}

func newPolicyID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) handleDeleteAutoUpdate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.Update(func(cfg *store.Config) error {
		cfg.AutoUpdates = slices.DeleteFunc(cfg.AutoUpdates, func(p models.AutoUpdatePolicy) bool { return p.ID == id })
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.wakeAutoUpdater()
	s.auditFromCtx(r, "autoupdate.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// handleRunAutoUpdate runs a policy now, streaming progress like an upgrade.
func (s *Server) handleRunAutoUpdate(w http.ResponseWriter, r *http.Request) {
	ps, err := s.autoUpdatePolicies()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	i := slices.IndexFunc(ps, func(p models.AutoUpdatePolicy) bool { return p.ID == chi.URLParam(r, "id") })
	if i < 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	s.runAutoUpdate(r.Context(), ps[i], w)
}

// runAutoUpdate runs one policy and records the outcome on it.
func (s *Server) runAutoUpdate(ctx context.Context, p models.AutoUpdatePolicy, w io.Writer) {
	out := &autoUpdateLog{dst: w}
	start := time.Now()
	s.recordAutoUpdate(p.ID, func(q *models.AutoUpdatePolicy) {
		q.LastRunAt, q.LastStatus, q.LastError, q.LastLog = &start, autoRunning, "", nil
	})
	ctx, cancel := context.WithTimeout(ctx, autoUpdateTimeout)
	defer cancel()
	var status string
	var err error
	if p.Kind == "compose" {
		status, err = s.autoUpdateCompose(ctx, p, out, cancel)
	} else {
		status, err = s.autoUpdateContainer(ctx, p, out)
	}
	if status == "" {
		status = autoError
	}
	msg := ""
	if err != nil {
		msg = err.Error()
		dockercontainer.EmitError(out, err)
	}
	if err := s.audit.Log(autoUpdateUser, "autoupdate."+p.Kind, p.Target, status); err != nil {
		log.Printf("audit: write failed: %v", err)
	}
	s.recordAutoUpdate(p.ID, func(q *models.AutoUpdatePolicy) {
		q.LastStatus, q.LastError, q.LastLog = status, msg, out.lines
	})
}

func (s *Server) recordAutoUpdate(id string, fn func(*models.AutoUpdatePolicy)) {
	err := s.store.Update(func(cfg *store.Config) error {
		if i := slices.IndexFunc(cfg.AutoUpdates, func(p models.AutoUpdatePolicy) bool { return p.ID == id }); i >= 0 {
			fn(&cfg.AutoUpdates[i])
		}
		return nil
	})
	if err != nil {
		log.Printf("autoupdate: record %s: %v", id, err)
	}
}

// autoUpdateContainer returns the outcome; for skipped, err says why.
func (s *Server) autoUpdateContainer(ctx context.Context, p models.AutoUpdatePolicy, w io.Writer) (string, error) {
	info, err := s.docker.ContainerInspect(ctx, p.Target)
	if err != nil {
		return "", fmt.Errorf("目标容器 %s 不可用：%w", p.Target, err)
	}
	if info.Config != nil && info.Config.Labels[labelProject] != "" {
		return autoSkipped, fmt.Errorf("容器由 Compose 项目 %s 管理，请对项目设置自动更新", info.Config.Labels[labelProject])
	}
	ctx, err = s.pullContext(ctx, p.ProxyURL)
	if err != nil {
		return "", err
	}
	results, err := s.checkUpdates(ctx, []string{info.ID}, p.RegistryIDs)
	if err != nil {
		return "", err
	}
	res := results[0]
	switch res.Status {
	case updateLatest:
		dockercontainer.EmitStream(w, "✓ %s 已是最新", res.Ref)
		return autoLatest, nil
	case updateUnsupported, updateError:
		return "", errors.New(res.Error)
	}
	dockercontainer.EmitStream(w, "%s 有新版本", res.Ref)
	if p.Mode != "update" {
		return autoAvailable, nil
	}
	if img, err := s.docker.ImageInspect(ctx, info.Image); err == nil && dockercontainer.NeedsEnvReview(info, img) {
		return autoSkipped, errors.New("容器带有旧版升级残留的环境变量，需手动升级一次以确认")
	}
	skipPull := res.Status == updateLocalNewer
	opts := requestPullOptions{ProxyURL: p.ProxyURL, RegistryIDs: p.RegistryIDs}
	auth, err := s.upgradeAuth(info, skipPull, opts)
	if err != nil {
		return "", err
	}
	handedOff, err := s.upgradeContainer(ctx, info, containerUpgrade{
		user: autoUpdateUser, auth: auth, skipPull: skipPull, removeOldImage: p.RemoveOldImage,
	}, w)
	switch {
	case err != nil:
		return "", err
	case handedOff:
		return autoHandedOff, nil
	}
	return autoUpdated, nil
}

// autoUpdateCompose checks the project's running containers and, when any
// service is behind, pulls only those services and runs `up`, which
// recreates just the services whose image changed. Build services are not
// rebuilt.
func (s *Server) autoUpdateCompose(ctx context.Context, p models.AutoUpdatePolicy, w io.Writer, cancel context.CancelFunc) (string, error) {
	resolved, err := s.resolveCompose(ctx, p.Target)
	if err != nil {
		return "", err
	}
	notRunning := errors.New("项目未运行，没有可检查的容器")
	if !resolved.running {
		return autoSkipped, notRunning
	}
	// Running containers only: `up` on a behind service would also start one
	// that was stopped on purpose.
	list, err := s.docker.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", labelProject+"="+resolved.projectName)),
	})
	if err != nil {
		return "", err
	}
	if len(list) == 0 {
		return autoSkipped, notRunning
	}
	ids := make([]string, 0, len(list))
	service := map[string]string{}
	for _, c := range list {
		ids = append(ids, c.ID)
		service[c.ID] = c.Labels[labelService]
	}
	ctx, err = s.pullContext(ctx, p.ProxyURL)
	if err != nil {
		return "", err
	}
	results, err := s.checkUpdates(ctx, ids, p.RegistryIDs)
	if err != nil {
		return "", err
	}
	var pull, behind, oldImages []string
	failed := 0
	for _, r := range results {
		svc := service[r.ID]
		switch r.Status {
		case updateAvailable:
			if !slices.Contains(pull, svc) {
				pull = append(pull, svc)
			}
			fallthrough
		case updateLocalNewer:
			if !slices.Contains(behind, svc) {
				behind = append(behind, svc)
			}
			oldImages = append(oldImages, r.LocalID)
			dockercontainer.EmitStream(w, "服务 %s（%s）有新版本", svc, r.Ref)
		case updateUnsupported, updateError:
			failed++
			dockercontainer.EmitStream(w, "服务 %s 未检查：%s", svc, r.Error)
		}
	}
	if len(behind) == 0 {
		if failed > 0 && failed == len(results) {
			return "", errors.New("所有服务都无法检查")
		}
		dockercontainer.EmitStream(w, "✓ 所有服务已是最新")
		return autoLatest, nil
	}
	if p.Mode != "update" {
		return autoAvailable, nil
	}
	auths, err := s.composeRegistryAuth(p.RegistryIDs)
	if err != nil {
		return "", err
	}
	output := dockercompose.NewNDJSONWriter(w, cancel)
	defer output.Flush()
	task := composeTask{
		id: p.Target, user: autoUpdateUser,
		options: requestPullOptions{ProxyURL: p.ProxyURL, RegistryIDs: p.RegistryIDs},
		request: dockercompose.ServiceOptions{Output: output, AuthConfigs: auths},
	}
	if len(pull) > 0 {
		task.operation, task.services = "pull", pull
		if _, err := s.composeRun(ctx, resolved, task, w, output); err != nil {
			return "", err
		}
	}
	// Images are local now; `up` must not pull again, and only touches the
	// services that are behind (plus their dependencies).
	task.operation, task.services, task.options.PullPolicy = "up", behind, "never"
	handedOff, err := s.composeRun(ctx, resolved, task, w, output)
	output.Flush()
	switch {
	case err != nil:
		return "", err
	case handedOff:
		return autoHandedOff, nil
	}
	if p.RemoveOldImage {
		s.removeUnusedImages(ctx, oldImages, w)
	}
	return autoUpdated, nil
}

// autoUpdateLog forwards progress to dst (flushing like an HTTP stream) and
// keeps the last lines as text for the policy's LastLog.
type autoUpdateLog struct {
	dst     io.Writer
	partial []byte
	lines   []string
}

func (l *autoUpdateLog) Write(p []byte) (int, error) {
	n, err := l.dst.Write(p)
	l.partial = append(l.partial, p[:n]...)
	for {
		i := bytes.IndexByte(l.partial, '\n')
		if i < 0 {
			break
		}
		l.add(l.partial[:i])
		l.partial = l.partial[i+1:]
	}
	if len(l.partial) > 64<<10 {
		l.partial = nil // not NDJSON; don't buffer without bound
	}
	return n, err
}

func (l *autoUpdateLog) Flush() {
	if f, ok := l.dst.(http.Flusher); ok {
		f.Flush()
	}
}

func (l *autoUpdateLog) add(line []byte) {
	var m struct {
		Stream, Error, Status, Progress string
		ID                              string `json:"id"`
	}
	if json.Unmarshal(line, &m) != nil {
		return
	}
	text := m.Error
	if text == "" {
		text = m.Stream
	}
	if text == "" && m.ID == "" && m.Progress == "" { // skip per-layer lines ("Pull complete", progress bars)
		text = m.Status
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if r := []rune(text); len(r) > autoLogLineMax {
		text = string(r[:autoLogLineMax]) + "…"
	}
	if len(l.lines) == autoLogLines {
		l.lines = append(l.lines[:0], l.lines[1:]...)
	}
	l.lines = append(l.lines, text)
}
