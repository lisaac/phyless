package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	"github.com/distribution/reference"
	composeapi "github.com/docker/compose/v2/pkg/api"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"phyless/backend/internal/config"
	phyDocker "phyless/backend/internal/docker"
	dockercompose "phyless/backend/internal/docker/compose"
	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
	phyWS "phyless/backend/internal/ws"
)

// id is passed as ?id= (query string), not a path segment: discovered project
// ids look like "auto:myproject" — a colon in a path segment hits the same
// chi RawPath decoding bug that once broke image ids (see images.go).
func (s *Server) mountComposeRoutes(r chi.Router) {
	r.Post("/api/compose", s.handleCreateCompose)
	r.Delete("/api/compose", s.handleDeleteCompose)
	r.Post("/api/compose/up", s.handleComposeUp)
	r.Post("/api/compose/stop", s.handleComposeStop)
	r.Post("/api/compose/pause", s.handleComposePause)
	r.Post("/api/compose/down", s.handleComposeDown)
	r.Post("/api/compose/pull", s.handleComposePull)
	r.Post("/api/compose/build", s.handleComposeBuild)
	r.Post("/api/compose/restart", s.handleComposeRestart)
	r.Put("/api/compose/files/content", s.handleComposePutFileContent)
	r.Delete("/api/compose/files", s.handleComposeDeleteFile)
	r.Post("/api/compose/files/rename", s.handleComposeRenameFile)
}

const (
	labelProject         = composeapi.ProjectLabel
	labelConfigFiles     = composeapi.ConfigFilesLabel
	labelWorkingDir      = composeapi.WorkingDirLabel
	labelEnvironmentFile = composeapi.EnvironmentFileLabel
)

type composeLookupError struct {
	status  int
	message string
}

var errComposeNotFound = errors.New("compose project not found")

func (e *composeLookupError) Error() string { return e.message }

type composeResolution struct {
	display     models.ComposeProject
	effective   models.ComposeProject
	projectName string
	running     bool
}

// Compose lifecycle operations share a project-name lock. The lock is
// ponytail: process-local and reject-only; add distributed locking for multiple instances.
// Requests for different
// projects remain concurrent, while a second operation for the same actual
// Compose project receives 409 instead of interleaving Docker API calls.
var composeOperationState = struct {
	sync.Mutex
	active map[string]struct{}
}{active: make(map[string]struct{})}

// buildCapabilityCache memoizes per-project can_build results, keyed by the
// project's compose file mtimes, so the 5s list poll re-parses a project's YAML
// only when it actually changes. inflight single-flights each project: while one
// evaluation runs (or hangs on a slow directory), other polls reuse the last
// known value instead of stacking goroutines.
type buildCapabilityCache struct {
	mu       sync.Mutex
	entries  map[string]buildCacheEntry
	inflight map[string]struct{}
}

const buildCacheTTL = 30 * time.Second

type buildCacheEntry struct {
	checkedAt time.Time
	signature string
	canBuild  bool
}

func newBuildCapabilityCache() *buildCapabilityCache {
	return &buildCapabilityCache{
		entries:  make(map[string]buildCacheEntry),
		inflight: make(map[string]struct{}),
	}
}

func tryComposeOperation(projectName string) (func(), bool) {
	projectName = strings.TrimSpace(strings.ToLower(projectName))
	if projectName == "" {
		return nil, false
	}
	composeOperationState.Lock()
	defer composeOperationState.Unlock()
	if _, exists := composeOperationState.active[projectName]; exists {
		return nil, false
	}
	composeOperationState.active[projectName] = struct{}{}
	return func() {
		composeOperationState.Lock()
		delete(composeOperationState.active, projectName)
		composeOperationState.Unlock()
	}, true
}

// ComposeInfo is a project as shown in the list: registered ones (saved via
// handleCreateCompose) merged with ones discovered live from the compose
// labels Docker stamps on every container `docker compose up` creates — so
// the list reflects what's actually deployed, not just what a user typed in.
type ComposeInfo struct {
	models.ComposeProject
	ProjectName string `json:"project_name,omitempty"`
	Discovered  bool   `json:"discovered"`
	Running     int    `json:"running"`
	Total       int    `json:"total"`
	// CanBuild is true only when the project's compose file is readable and at
	// least one service declares a build. The list's Build button keys off it.
	CanBuild bool `json:"can_build"`
}

// discoverProjects groups all containers by their compose project label.
func (s *Server) discoverProjectsWithError(ctx context.Context) (map[string][]container.Summary, error) {
	if s.docker == nil {
		return nil, errors.New("docker client is not initialized")
	}
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	groups := make(map[string][]container.Summary)
	for _, c := range containers {
		if proj := c.Labels[labelProject]; proj != "" {
			groups[proj] = append(groups[proj], c)
		}
	}
	return groups, nil
}

func composeContainerLabel(cs []container.Summary, key string) string {
	for _, c := range cs {
		if value := c.Labels[key]; value != "" {
			return value
		}
	}
	return ""
}

func discoveredComposeProject(projectName string, cs []container.Summary) models.ComposeProject {
	return models.ComposeProject{
		ID:          "auto:" + projectName,
		Name:        projectName,
		BaseDir:     composeContainerLabel(cs, labelWorkingDir),
		ComposeFile: composeContainerLabel(cs, labelConfigFiles),
		EnvFile:     composeContainerLabel(cs, labelEnvironmentFile),
	}
}

func composeRunningCounts(cs []container.Summary) (running, total int) {
	for _, c := range cs {
		total++
		if c.State == "running" {
			running++
		}
	}
	return running, total
}

func (s *Server) handleListCompose(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read compose projects")
		return
	}
	groups, err := s.discoverProjectsWithError(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "cannot inspect Docker Compose labels")
		return
	}

	canBuild := s.computeCanBuild(r.Context(), cfg.ComposeProjects)
	var out []ComposeInfo
	for i, p := range cfg.ComposeProjects {
		out = append(out, ComposeInfo{ComposeProject: p, CanBuild: canBuild[i]})
	}

	// A single registered entry may match one running stack. If several
	// registered entries or several project names match the same file, keep
	// each discovered stack visible instead of assigning runtime state at
	// random to one display row.
	registeredMatches := make([][]string, len(cfg.ComposeProjects))
	owners := make(map[string][]int)
	for i, p := range cfg.ComposeProjects {
		for projectName, cs := range groups {
			discovered := discoveredComposeProject(projectName, cs)
			if composeProjectsMatch(p, discovered) {
				registeredMatches[i] = append(registeredMatches[i], projectName)
				owners[projectName] = append(owners[projectName], i)
			}
		}
	}
	for i, matches := range registeredMatches {
		if len(matches) != 1 || len(owners[matches[0]]) != 1 {
			continue
		}
		running, total := composeRunningCounts(groups[matches[0]])
		out[i].Running = running
		out[i].Total = total
		out[i].ProjectName = matches[0]
	}

	for projectName, cs := range groups {
		if owners[projectName] != nil && len(owners[projectName]) == 1 && len(registeredMatches[owners[projectName][0]]) == 1 {
			continue
		}
		discovered := discoveredComposeProject(projectName, cs)
		running, total := composeRunningCounts(cs)
		out = append(out, ComposeInfo{
			ComposeProject: discovered,
			ProjectName:    discovered.Name,
			Discovered:     true,
			Running:        running,
			Total:          total,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateCompose(w http.ResponseWriter, r *http.Request) {
	var p models.ComposeProject
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	err := s.store.Update(func(cfg *store.Config) error {
		id, err := store.NewID("c")
		if err != nil {
			return err
		}
		p.ID = id
		cfg.ComposeProjects = append(cfg.ComposeProjects, p)
		return nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save compose project")
		return
	}
	s.auditFromCtx(r, "compose.register", p.Name, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": p.ID})
}

func composeProjectOptions(p models.ComposeProject) dockercompose.ProjectOptions {
	options := dockercompose.ProjectOptions{
		WorkingDir:  p.BaseDir,
		ConfigPaths: splitComposePaths(p.ComposeFile),
		EnvFiles:    splitComposePaths(p.EnvFile),
		Environment: os.Environ(),
	}
	// Registered project names are display names. The old CLI invocation did
	// not pass --project-name for them, so let compose-go honor the YAML name or
	// working-directory fallback. Discovered projects come from Compose's
	// project label and must retain that exact name for lifecycle filtering.
	return options
}

func splitComposePaths(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	paths := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			paths = append(paths, part)
		}
	}
	return paths
}

func normalizeComposePaths(baseDir, value string) []string {
	paths := splitComposePaths(value)
	if len(paths) == 0 {
		return nil
	}
	if baseDir == "" {
		baseDir = "."
	}
	baseDir, err := filepath.Abs(baseDir)
	if err != nil {
		return paths
	}
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "-" {
			result = append(result, path)
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(baseDir, path)
		}
		result = append(result, filepath.Clean(path))
	}
	return result
}

func composePathListsMatch(registered, discovered []string) bool {
	if len(registered) == 0 || len(discovered) < len(registered) {
		return false
	}
	for i, path := range registered {
		if path != discovered[i] {
			return false
		}
	}
	return true
}

func composeProjectsMatch(registered, discovered models.ComposeProject) bool {
	registeredFiles := normalizeComposePaths(registered.BaseDir, registered.ComposeFile)
	discoveredFiles := normalizeComposePaths(discovered.BaseDir, discovered.ComposeFile)
	if !composePathListsMatch(registeredFiles, discoveredFiles) {
		return false
	}
	if registered.BaseDir != "" && discovered.BaseDir != "" {
		registeredDir, err1 := filepath.Abs(registered.BaseDir)
		discoveredDir, err2 := filepath.Abs(discovered.BaseDir)
		if err1 != nil || err2 != nil || filepath.Clean(registeredDir) != filepath.Clean(discoveredDir) {
			return false
		}
	}
	if registered.EnvFile != "" {
		registeredEnv := normalizeComposePaths(registered.BaseDir, registered.EnvFile)
		discoveredEnv := normalizeComposePaths(discovered.BaseDir, discovered.EnvFile)
		if len(registeredEnv) != len(discoveredEnv) {
			return false
		}
		for i := range registeredEnv {
			if registeredEnv[i] != discoveredEnv[i] {
				return false
			}
		}
	}
	return true
}

func mergeDiscoveredCompose(registered, discovered models.ComposeProject) models.ComposeProject {
	effective := registered
	effective.Name = discovered.Name
	if discovered.BaseDir != "" {
		effective.BaseDir = discovered.BaseDir
	}
	if discovered.ComposeFile != "" {
		effective.ComposeFile = discovered.ComposeFile
	}
	if discovered.EnvFile != "" {
		effective.EnvFile = discovered.EnvFile
	}
	return effective
}

func (s *Server) resolveCompose(ctx context.Context, id string) (composeResolution, error) {
	if name, ok := strings.CutPrefix(id, "auto:"); ok {
		groups, err := s.discoverProjectsWithError(ctx)
		if err != nil {
			return composeResolution{}, &composeLookupError{status: http.StatusServiceUnavailable, message: "cannot inspect Docker Compose labels"}
		}
		cs, found := groups[name]
		if !found || len(cs) == 0 {
			return composeResolution{}, &composeLookupError{status: http.StatusNotFound, message: "not found"}
		}
		discovered := discoveredComposeProject(name, cs)
		return composeResolution{display: discovered, effective: discovered, projectName: name, running: true}, nil
	}
	cfg, err := s.store.Read()
	if err != nil {
		return composeResolution{}, &composeLookupError{status: http.StatusInternalServerError, message: "failed to read compose projects"}
	}
	for _, registered := range cfg.ComposeProjects {
		if registered.ID != id {
			continue
		}
		groups, err := s.discoverProjectsWithError(ctx)
		if err != nil {
			return composeResolution{}, &composeLookupError{status: http.StatusServiceUnavailable, message: "cannot inspect Docker Compose labels"}
		}
		var matches []models.ComposeProject
		for projectName, cs := range groups {
			discovered := discoveredComposeProject(projectName, cs)
			if composeProjectsMatch(registered, discovered) {
				matches = append(matches, discovered)
			}
		}
		if len(matches) > 1 {
			var names []string
			for _, match := range matches {
				names = append(names, match.Name)
			}
			sort.Strings(names)
			return composeResolution{}, &composeLookupError{
				status:  http.StatusConflict,
				message: fmt.Sprintf("compose project %q matches multiple running projects: %s", registered.ID, strings.Join(names, ", ")),
			}
		}
		if len(matches) == 1 {
			return composeResolution{
				display:     registered,
				effective:   mergeDiscoveredCompose(registered, matches[0]),
				projectName: matches[0].Name,
				running:     true,
			}, nil
		}
		return composeResolution{display: registered, effective: registered}, nil
	}
	return composeResolution{}, &composeLookupError{status: http.StatusNotFound, message: "not found"}
}

func writeComposeLookupError(w http.ResponseWriter, err error) {
	var lookupErr *composeLookupError
	if errors.As(err, &lookupErr) {
		writeError(w, lookupErr.status, lookupErr.message)
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

func (s *Server) loadResolvedComposeProject(ctx context.Context, resolved composeResolution) (*composetypes.Project, error) {
	if s.composeRuntime == nil {
		return nil, fmt.Errorf("compose runtime is not initialized")
	}
	options := composeProjectOptions(resolved.effective)
	if resolved.projectName != "" {
		options.Name = resolved.projectName
	}
	return s.composeRuntime.LoadProject(ctx, options)
}

func (s *Server) handleGetCompose(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.resolveCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	type composeDetailResponse struct {
		models.ComposeProject
		ProjectName string                `json:"project_name,omitempty"`
		Services    composetypes.Services `json:"services"`
		LoadError   string                `json:"load_error,omitempty"`
	}
	project, err := s.loadResolvedComposeProject(r.Context(), resolved)
	if err != nil {
		// A discovered/running project may outlive the host path from which it
		// was created (or that path may simply not be mounted into this service
		// container). Keep the detail window usable from trusted Docker labels;
		// file editing and Up/Pull still report the original missing-file error.
		if resolved.running && errors.Is(err, os.ErrNotExist) {
			projectName := resolved.effective.Name
			if resolved.projectName != "" {
				projectName = resolved.projectName
			}
			writeJSON(w, http.StatusOK, composeDetailResponse{
				ComposeProject: resolved.display,
				ProjectName:    projectName,
				Services:       composetypes.Services{},
				LoadError:      "Compose 文件当前无法从服务容器访问；文件编辑和 Up/Pull 需要挂载源目录。",
			})
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	services := make(composetypes.Services, len(project.Services)+len(project.DisabledServices))
	for name, service := range project.Services {
		services[name] = service
	}
	for name, service := range project.DisabledServices {
		services[name] = service
	}
	writeJSON(w, http.StatusOK, composeDetailResponse{
		ComposeProject: resolved.display,
		ProjectName:    project.Name,
		Services:       services,
	})
}

// handleComposePullPlan lists the images a browser-download client must
// pre-pull before running Compose with pull_policy=never. The loader still owns
// "what to pull" (profiles, active services); the client only pulls each ref.
// Build services remain rejected in the ordinary images list, while their
// statically-resolved FROM bases are exposed separately for browser builds.
func (s *Server) handleComposePullPlan(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.resolveCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	project, err := s.loadResolvedComposeProject(r.Context(), resolved)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	type planImage struct {
		Service  string `json:"service"`
		Ref      string `json:"ref"`
		Platform string `json:"platform,omitempty"`
	}
	type planReject struct {
		Service string `json:"service"`
		Ref     string `json:"ref"`
		Reason  string `json:"reason"`
	}
	type planBase struct {
		Service  string `json:"service"`
		Ref      string `json:"ref"`
		Platform string `json:"platform,omitempty"`
	}
	images := make([]planImage, 0)
	buildBases := make([]planBase, 0)
	seenBases := make(map[string]struct{})
	rejected := make([]planReject, 0)
	names := make([]string, 0, len(project.Services))
	for name := range project.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		svc := project.Services[name]
		if svc.Build != nil {
			rejected = append(rejected, planReject{Service: name, Ref: svc.Image, Reason: "build"})
			bases, baseErr := dockercompose.BuildBaseImages(svc, project.WorkingDir)
			if baseErr != nil {
				// The build endpoint will report the parser/build error; don't turn a
				// best-effort plan failure into a false browser pull target.
				log.Printf("compose: cannot resolve base images for service %q: %v", name, baseErr)
				continue
			}
			for _, ref := range bases {
				key := ref + "\x00" + svc.Platform
				if _, seen := seenBases[key]; seen {
					continue
				}
				seenBases[key] = struct{}{}
				buildBases = append(buildBases, planBase{Service: name, Ref: ref, Platform: svc.Platform})
			}
			continue
		}
		if svc.Image == "" {
			continue
		}
		if strings.Contains(svc.Image, "@") {
			rejected = append(rejected, planReject{Service: name, Ref: svc.Image, Reason: "digest"})
			continue
		}
		images = append(images, planImage{Service: name, Ref: svc.Image, Platform: svc.Platform})
	}
	writeJSON(w, http.StatusOK, map[string]any{"images": images, "build_bases": buildBases, "rejected": rejected})
}

func (s *Server) handleDeleteCompose(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if strings.HasPrefix(id, "auto:") {
		writeError(w, http.StatusBadRequest, "自动发现的项目无法删除，使用「停止」将其下线")
		return
	}
	err := s.store.Update(func(cfg *store.Config) error {
		for i, p := range cfg.ComposeProjects {
			if p.ID == id {
				cfg.ComposeProjects = append(cfg.ComposeProjects[:i], cfg.ComposeProjects[i+1:]...)
				return nil
			}
		}
		return errComposeNotFound
	})
	if err != nil {
		if errors.Is(err, errComposeNotFound) {
			writeError(w, http.StatusNotFound, "not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to save compose project")
		}
		return
	}
	s.auditFromCtx(r, "compose.delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// computeCanBuild resolves can_build for the given registered projects. It runs
// the per-project checks concurrently and returns after a short deadline so one
// slow or hung project directory cannot stall the frequently polled list. A
// project whose check is still running (or hung) is single-flighted in the
// cache, so late results just fill in on a later poll rather than blocking.
func (s *Server) computeCanBuild(ctx context.Context, projects []models.ComposeProject) []bool {
	results := make([]bool, len(projects))
	if len(projects) == 0 {
		return results
	}
	type result struct {
		index    int
		canBuild bool
	}
	completed := make(chan result, len(projects))
	for i := range projects {
		go func(i int) {
			completed <- result{i, s.projectHasBuild(ctx, projects[i])}
		}(i)
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for range projects {
		select {
		case value := <-completed:
			results[value.index] = value.canBuild
		case <-ctx.Done():
			return results
		case <-timer.C:
			return results
		}
	}
	return results
}

// projectHasBuild reports whether a project's compose file loads and any
// (default-profile) service declares a build. Results are memoized by the
// compose files' mtimes so the 5s list poll re-parses only changed projects;
// a single-flight guard keeps a slow/hung directory from piling up goroutines.
// Best-effort: an unreadable file (missing, not mounted, invalid) yields false,
// matching "only when the yaml can be read".
func (s *Server) projectHasBuild(ctx context.Context, p models.ComposeProject) bool {
	if s.composeRuntime == nil {
		return false
	}
	c := s.buildCache
	if c == nil {
		return s.loadProjectHasBuild(ctx, p) // no cache (e.g. tests build Server directly)
	}

	c.mu.Lock()
	if _, busy := c.inflight[p.ID]; busy {
		// A prior evaluation is still running (typically a slow/hung dir).
		// Reuse the last known value instead of blocking or stacking goroutines.
		v := c.entries[p.ID].canBuild
		c.mu.Unlock()
		return v
	}
	c.inflight[p.ID] = struct{}{}
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.inflight, p.ID); c.mu.Unlock() }()

	// ponytail: mtime handles top-level edits immediately; a 30s TTL bounds
	// staleness for include/.env dependencies without maintaining a second parser.
	sig := composeFileSignature(p)
	c.mu.Lock()
	entry, ok := c.entries[p.ID]
	c.mu.Unlock()
	if ok && sig != "" && entry.signature == sig && time.Since(entry.checkedAt) < buildCacheTTL {
		return entry.canBuild
	}

	canBuild := s.loadProjectHasBuild(ctx, p)
	if ctx.Err() != nil {
		return canBuild // A cancelled load is not a cached negative result.
	}
	c.mu.Lock()
	c.entries[p.ID] = buildCacheEntry{signature: sig, canBuild: canBuild, checkedAt: time.Now()}
	c.mu.Unlock()
	return canBuild
}

func (s *Server) loadProjectHasBuild(ctx context.Context, p models.ComposeProject) bool {
	project, err := s.composeRuntime.LoadProject(ctx, composeProjectOptions(p))
	if err != nil {
		log.Printf("compose: can_build check for %q failed: %v", p.ID, err)
		return false
	}
	for _, service := range project.Services {
		if service.Build != nil {
			return true
		}
	}
	return false
}

// composeFileSignature fingerprints a project's compose files by path+mtime+size
// so an unchanged project can skip re-parsing. An unreadable file yields "",
// which forces a reload (that then also fails, yielding can_build=false).
func composeFileSignature(p models.ComposeProject) string {
	paths := normalizeComposePaths(p.BaseDir, p.ComposeFile)
	if len(paths) == 0 {
		return ""
	}
	var b strings.Builder
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return ""
		}
		fmt.Fprintf(&b, "%s:%d:%d;", path, info.ModTime().UnixNano(), info.Size())
	}
	return b.String()
}

func (s *Server) handleComposeUp(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "up")
}

func (s *Server) handleComposeBuild(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "build")
}

func (s *Server) handleComposeStop(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "stop")
}

func (s *Server) handleComposePause(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "pause")
}

func (s *Server) handleComposeDown(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "down")
}

func (s *Server) handleComposePull(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "pull")
}

func (s *Server) handleComposeRestart(w http.ResponseWriter, r *http.Request) {
	s.runComposeOperation(w, r, "restart")
}

// runComposeOperation invokes the official Compose service API and streams
// progress to w as the existing newline-delimited {stream}/{error} format.
func (s *Server) runComposeOperation(w http.ResponseWriter, r *http.Request, operation string) {
	resolved, err := s.resolveCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	output := dockercompose.NewNDJSONWriter(w, cancel)
	ctx, options, request, err := s.composeRequest(ctx, r, output)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		s.auditFromCtx(r, "compose."+operation, resolved.display.Name, "failed")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	if s.composeRuntime == nil {
		finalErr := finishComposeOperation(w, output, ctx, fmt.Errorf("compose runtime is not initialized"))
		s.auditFromCtx(r, "compose."+operation, resolved.display.Name, composeOperationResult(finalErr))
		return
	}
	{
		var project *composetypes.Project
		project, err = s.loadResolvedComposeProject(ctx, resolved)
		if err != nil && composeCanUseRunningFallback(operation, resolved, err) {
			// Stop/down/restart/logs can reconstruct the project from trusted
			// Compose labels. Keep Up/Pull strict: they need the file and must
			// never silently deploy a different configuration.
			err = nil
			project = nil
		}
		projectName := resolved.effective.Name
		if project != nil {
			projectName = project.Name
		}
		if resolved.running && resolved.effective.Name != "" {
			projectName = resolved.effective.Name
		}
		var release func()
		if err == nil {
			var acquired bool
			release, acquired = tryComposeOperation(projectName)
			if !acquired {
				writeError(w, http.StatusConflict, fmt.Sprintf("compose project %q already has an active operation", projectName))
				s.auditFromCtx(r, "compose."+operation, projectName, "failed")
				return
			}
			defer release()
		}
		if err == nil {
			err = validateComposeOperation(ctx, operation, project)
		}
		if err == nil {
			service, serviceErr := s.composeRuntime.NewService(ctx, request)
			err = serviceErr
			if err == nil {
				switch operation {
				case "up":
					if project == nil {
						err = fmt.Errorf("compose up requires a readable project file")
						break
					}
					if phyDocker.HasPullProxy(ctx) {
						if err = s.prePullBuildBases(ctx, project, request.AuthConfigs, options.Platform, output); err != nil {
							break
						}
					}
					applyComposePullPolicy(project, options.PullPolicy)
					err = service.Compose().Up(ctx, project, composeapi.UpOptions{
						Create: composeapi.CreateOptions{
							Build: &composeapi.BuildOptions{
								Deps:     true,
								Quiet:    true,
								Progress: "quiet",
								Out:      output,
							},
							Recreate:             composeapi.RecreateDiverged,
							RecreateDependencies: composeapi.RecreateDiverged,
							Inherit:              true,
						},
						Start: composeapi.StartOptions{Project: project},
					})
				case "stop":
					err = service.Compose().Stop(ctx, projectName, composeapi.StopOptions{Project: project})
				case "pause":
					err = service.Compose().Pause(ctx, projectName, composeapi.PauseOptions{Project: project})
				case "down":
					err = service.Compose().Down(ctx, projectName, composeapi.DownOptions{Project: project})
				case "build":
					if project == nil {
						err = fmt.Errorf("compose build requires a readable project file")
						break
					}
					if phyDocker.HasPullProxy(ctx) {
						if err = s.prePullBuildBases(ctx, project, request.AuthConfigs, options.Platform, output); err != nil {
							break
						}
					}
					err = service.Compose().Build(ctx, project, composeapi.BuildOptions{
						Progress: "plain",
						Out:      output,
					})
				case "pull":
					if project == nil {
						err = fmt.Errorf("compose pull requires a readable project file")
						break
					}
					// ponytail: Compose v2.40.3 appends build fallbacks from concurrent pull
					// goroutines without a lock. Keep this one operation serial until
					// an upstream release fixes that race; Up retains normal parallelism.
					service.MaxConcurrency(1)
					err = service.Compose().Pull(ctx, project, composeapi.PullOptions{})
				case "restart":
					err = service.Compose().Restart(ctx, projectName, composeapi.RestartOptions{Project: project})
				default:
					err = fmt.Errorf("unsupported compose operation %q", operation)
				}
			}
		}
	}
	finalErr := finishComposeOperation(w, output, ctx, err)
	auditTarget := resolved.display.Name
	if auditTarget == "" {
		auditTarget = resolved.effective.Name
	}
	s.auditFromCtx(r, "compose."+operation, auditTarget, composeOperationResult(finalErr))
}

func (s *Server) composeRequest(ctx context.Context, r *http.Request, output io.Writer) (context.Context, requestPullOptions, dockercompose.ServiceOptions, error) {
	var options requestPullOptions
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&options); err != nil && err != io.EOF {
			return ctx, options, dockercompose.ServiceOptions{}, fmt.Errorf("invalid JSON")
		}
	}
	if !options.validComposePullPolicy() {
		return ctx, options, dockercompose.ServiceOptions{}, fmt.Errorf("invalid pull_policy %q: use missing, always or never", options.PullPolicy)
	}
	ctx, err := s.pullContext(ctx, options.ProxyURL)
	if err != nil {
		return ctx, options, dockercompose.ServiceOptions{}, err
	}
	auths, err := s.composeRegistryAuth(options.RegistryIDs)
	if err != nil {
		return ctx, options, dockercompose.ServiceOptions{}, err
	}
	return ctx, options, dockercompose.ServiceOptions{Output: output, AuthConfigs: auths}, nil
}

func finishComposeOperation(w http.ResponseWriter, output *dockercompose.NDJSONWriter, ctx context.Context, err error) error {
	output.Flush()
	if outputErr := output.Err(); outputErr != nil {
		err = outputErr
	} else if ctxErr := ctx.Err(); ctxErr != nil {
		// A canceled request may close the HTTP writer first, causing Compose to
		// return io.ErrClosedPipe. Preserve the request outcome for audit/status
		// consumers when no more specific output failure occurred.
		err = ctxErr
	}
	if err == nil {
		_, _ = output.Write([]byte("✓ 完成\n"))
		output.Flush()
		err = output.Err()
	}
	if err != nil {
		dockercontainer.EmitError(w, err)
		return err
	}
	return nil
}

func composeOperationResult(err error) string {
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return "canceled"
		}
		return "failed"
	}
	return "ok"
}

func composeCanUseRunningFallback(operation string, resolved composeResolution, err error) bool {
	if !resolved.running || resolved.effective.Name == "" || !errors.Is(err, os.ErrNotExist) {
		return false
	}
	switch operation {
	case "stop", "pause", "down", "restart", "logs":
		return true
	default:
		return false
	}
}

// prePullBuildBases pulls every build service's FROM base images through the
// request proxy so a subsequent offline build (buildkit with Pull disabled)
// finds them in the local image store. buildkit runs its own FROM pulls inside
// the daemon, which never pass through phyless's userspace registry proxy, so
// without this a proxied build/up cannot reach a blocked registry.
func (s *Server) prePullBuildBases(ctx context.Context, project *composetypes.Project, auths map[string]registry.AuthConfig, platform string, output io.Writer) error {
	if project == nil {
		return nil
	}
	names := make([]string, 0, len(project.Services))
	for name := range project.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	pulled := make(map[string]struct{})
	for _, name := range names {
		service := project.Services[name]
		if service.Build == nil {
			continue
		}
		bases, err := dockercompose.BuildBaseImages(service, project.WorkingDir)
		if err != nil {
			// Unreadable/unparseable Dockerfile: let buildkit surface the real
			// error rather than blocking the build here.
			log.Printf("compose: cannot resolve base images for service %q: %v", name, err)
			continue
		}
		for _, base := range bases {
			if _, ok := pulled[base]; ok {
				continue
			}
			pulled[base] = struct{}{}
			if err := s.prePullBaseImage(ctx, base, auths, platform, output); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) prePullBaseImage(ctx context.Context, ref string, auths map[string]registry.AuthConfig, platform string, output io.Writer) error {
	encoded, err := encodeRegistryAuthForImage(ref, auths)
	if err != nil {
		return err
	}
	fmt.Fprintf(output, "通过代理预拉取基础镜像 %s\n", safePullTarget(ref))
	rc, err := s.docker.ImagePull(ctx, ref, image.PullOptions{RegistryAuth: encoded, Platform: platform})
	if err != nil {
		return fmt.Errorf("预拉取基础镜像 %s 失败: %w", safePullTarget(ref), err)
	}
	if err := phyDocker.ConsumeProgress(ctx, io.Discard, rc); err != nil {
		return fmt.Errorf("预拉取基础镜像 %s 失败: %w", safePullTarget(ref), err)
	}
	return nil
}

// encodeRegistryAuthForImage picks the configured credential whose host matches
// the base image's registry; unmatched hosts pull anonymously (public bases).
func encodeRegistryAuthForImage(ref string, auths map[string]registry.AuthConfig) (string, error) {
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return "", fmt.Errorf("invalid base image reference %q", ref)
	}
	host, err := phyDocker.RegistryHost(reference.Domain(named))
	if err != nil {
		return "", err
	}
	cfg, ok := auths[host]
	if !ok {
		return "", nil
	}
	return registry.EncodeAuthConfig(cfg)
}

func validateComposeOperation(ctx context.Context, operation string, project *composetypes.Project) error {
	if project == nil {
		return nil
	}
	for name, service := range project.Services {
		if (operation == "up" || operation == "down") && service.Provider != nil {
			provider := service.Provider.Type
			if provider == "" {
				provider = "unknown"
			}
			return fmt.Errorf("compose service %q uses external provider %q, which is not supported by the embedded API", name, provider)
		}
		if operation != "up" && operation != "pull" && operation != "build" || service.Build == nil {
			continue
		}
		// up/build pre-pull FROM base images through the proxy before an offline
		// build (see prePullBuildBases). pull has no build step to feed, so a
		// proxied pull of a build service stays unsupported.
		if operation == "pull" && phyDocker.HasPullProxy(ctx) {
			return fmt.Errorf("compose pull with a pull proxy is not supported for service %q because it has a build configuration", name)
		}
		if remote := unsupportedComposeReference(service.Build.Context); remote != "" {
			return fmt.Errorf("compose service %q uses unsupported remote build context %q", name, remote)
		}
		if remote := unsupportedComposeReference(service.Build.Dockerfile); remote != "" {
			return fmt.Errorf("compose service %q uses unsupported remote Dockerfile %q", name, remote)
		}
		for contextName, contextValue := range service.Build.AdditionalContexts {
			if remote := unsupportedComposeReference(contextValue); remote != "" {
				return fmt.Errorf("compose service %q uses unsupported remote additional context %q=%q", name, contextName, remote)
			}
		}
	}
	for name, service := range project.Services {
		if service.Extends != nil {
			if remote := unsupportedComposeReference(service.Extends.File); remote != "" {
				return fmt.Errorf("compose service %q uses unsupported remote extends file %q", name, remote)
			}
		}
	}
	return nil
}

func unsupportedComposeReference(value string) string {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	for _, prefix := range []string{
		"http://", "https://", "git://", "git+", "ssh://", "oci://", "docker-image://",
	} {
		if strings.HasPrefix(lower, prefix) {
			return value
		}
	}
	return ""
}

// handleComposeResolvedConfig returns compose-go's effective merged project,
// resolving overrides and environment interpolation without invoking a CLI.
func (s *Server) handleComposeResolvedConfig(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.resolveCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	project, err := s.loadResolvedComposeProject(r.Context(), resolved)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out, err := project.MarshalYAML()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out) //nolint:errcheck
}

// handleComposeListFiles/handleComposeGetFileContent/handleComposePutFileContent
// browse and edit arbitrary files under a project's BaseDir (not just the
// main compose file) — same root+subPath+isSubPath pattern as the /etc config
// file browser (config.go), just rooted at the project's directory instead.
func (s *Server) handleComposeListFiles(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	subPath := r.URL.Query().Get("path")
	if !isSubPath(p.BaseDir, filepath.Join(p.BaseDir, subPath)) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	entries, err := config.ListDir(p.BaseDir, subPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleComposeGetFileContent(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	fullPath := filepath.Join(p.BaseDir, r.URL.Query().Get("path"))
	if !isSubPath(p.BaseDir, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	serveFileContent(w, fullPath)
}

func (s *Server) handleComposePutFileContent(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(p.BaseDir, subPath)
	if !isSubPath(p.BaseDir, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	data, err := readBounded(r.Body, 10<<20)
	if err != nil {
		if errors.Is(err, errRequestBodyTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := atomicWriteFile(fullPath, data, 0644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "compose.file.write", p.Name+":"+subPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

// handleComposeDeleteFile/handleComposeRenameFile operate directly on the
// host filesystem (unlike containers.go's file delete/rename, which shells
// out via docker exec since a container's files aren't otherwise reachable)
// — a compose project's BaseDir already lives on the same filesystem the
// phyless process itself sees.
func (s *Server) handleComposeDeleteFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(p.BaseDir, subPath)
	if !isSubPath(p.BaseDir, fullPath) || filepath.Clean(fullPath) == filepath.Clean(p.BaseDir) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	if err := os.RemoveAll(fullPath); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "compose.file.delete", p.Name+":"+subPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleComposeDownloadFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	fullPath := filepath.Join(p.BaseDir, r.URL.Query().Get("path"))
	if !isSubPath(p.BaseDir, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	serveTar(w, fullPath)
}

func (s *Server) handleComposeRenameFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		writeComposeLookupError(w, err)
		return
	}
	var body struct {
		OldPath string `json:"old_path"`
		NewPath string `json:"new_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OldPath == "" || body.NewPath == "" {
		writeError(w, http.StatusBadRequest, "old_path and new_path required")
		return
	}
	oldFull := filepath.Join(p.BaseDir, body.OldPath)
	newFull := filepath.Join(p.BaseDir, body.NewPath)
	if !isSubPath(p.BaseDir, oldFull) || !isSubPath(p.BaseDir, newFull) ||
		filepath.Clean(oldFull) == filepath.Clean(p.BaseDir) || filepath.Clean(newFull) == filepath.Clean(p.BaseDir) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	if err := os.Rename(oldFull, newFull); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "compose.file.rename", p.Name+":"+body.OldPath+" -> "+body.NewPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleComposeLogsWS(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.resolveCompose(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		var lookupErr *composeLookupError
		if errors.As(err, &lookupErr) {
			http.Error(w, lookupErr.message, lookupErr.status)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	if s.composeRuntime == nil {
		http.Error(w, "compose runtime is not initialized", http.StatusInternalServerError)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ctx, cancel := phyWS.MonitorConnection(r.Context(), conn)
	defer cancel()

	service, err := s.composeRuntime.NewService(ctx, dockercompose.ServiceOptions{})
	if err != nil {
		_ = phyWS.WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}
	project, err := s.loadResolvedComposeProject(ctx, resolved)
	if err != nil && composeCanUseRunningFallback("logs", resolved, err) {
		project = nil
		err = nil
	}
	if err != nil {
		_ = phyWS.WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}
	projectName := resolved.effective.Name
	if project != nil {
		projectName = project.Name
	}
	if resolved.running && resolved.effective.Name != "" {
		projectName = resolved.effective.Name
	}

	consumer := &composeLogConsumer{conn: conn, cancel: cancel}
	err = service.Compose().Logs(ctx, projectName, consumer, composeapi.LogOptions{
		Project:    project,
		Follow:     true,
		Timestamps: true,
		Since:      r.URL.Query().Get("since"),
		Until:      r.URL.Query().Get("until"),
	})
	if err != nil && consumer.WriteErr() == nil && ctx.Err() == nil {
		consumer.send("error: " + err.Error() + "\n")
	}
}

type composeLogConsumer struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	mu     sync.Mutex
	err    error
}

func (c *composeLogConsumer) Log(containerName, message string) {
	c.send(containerName + " | " + message + "\n")
}

func (c *composeLogConsumer) Err(containerName, message string) {
	c.send(containerName + " | error: " + message + "\n")
}

func (c *composeLogConsumer) Status(container, message string) {
	c.send(container + " | " + message + "\n")
}

func (c *composeLogConsumer) send(message string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return
	}
	if err := phyWS.WriteMessage(c.conn, websocket.BinaryMessage, []byte(message)); err != nil {
		c.err = err
		c.cancel()
	}
}

func (c *composeLogConsumer) WriteErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// findCompose resolves the local project record used by file-management
// handlers. Store failures are returned separately from a missing project so
// callers do not turn unavailable state into a misleading 404. Registered
// projects can still be browsed or edited while the daemon is offline; only
// auto-discovered IDs need a live label lookup. Lifecycle/detail handlers call
// resolveCompose directly so they can return a useful 409 when labels identify
// more than one real project and a daemon discovery error when mutation would
// be unsafe.
func (s *Server) findCompose(ctx context.Context, id string) (models.ComposeProject, error) {
	if strings.HasPrefix(id, "auto:") {
		resolved, err := s.resolveCompose(ctx, id)
		if err != nil {
			return models.ComposeProject{}, err
		}
		return resolved.effective, nil
	}
	cfg, err := s.store.Read()
	if err != nil {
		return models.ComposeProject{}, &composeLookupError{status: http.StatusInternalServerError, message: "failed to read compose projects"}
	}
	for _, project := range cfg.ComposeProjects {
		if project.ID == id {
			return project, nil
		}
	}
	return models.ComposeProject{}, &composeLookupError{status: http.StatusNotFound, message: "not found"}
}
