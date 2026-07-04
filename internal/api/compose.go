package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/compose-spec/compose-go/v2/loader"
	composetypes "github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/docker/api/types/container"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"phyless/internal/config"
	dockercontainer "phyless/internal/docker/container"
	"phyless/internal/models"
)

// id is passed as ?id= (query string), not a path segment: discovered project
// ids look like "auto:myproject" — a colon in a path segment hits the same
// chi RawPath decoding bug that once broke image ids (see images.go).
func (s *Server) mountComposeRoutes(r chi.Router) {
	r.Get("/api/compose", s.handleListCompose)
	r.Post("/api/compose", s.handleCreateCompose)
	r.Get("/api/compose/detail", s.handleGetCompose)
	r.Delete("/api/compose", s.handleDeleteCompose)
	r.Post("/api/compose/up", s.handleComposeUp)
	r.Post("/api/compose/stop", s.handleComposeStop)
	r.Post("/api/compose/down", s.handleComposeDown)
	r.Post("/api/compose/pull", s.handleComposePull)
	r.Post("/api/compose/restart", s.handleComposeRestart)
	r.Get("/api/compose/config", s.handleComposeResolvedConfig)
	r.Get("/api/compose/files", s.handleComposeListFiles)
	r.Get("/api/compose/files/content", s.handleComposeGetFileContent)
	r.Put("/api/compose/files/content", s.handleComposePutFileContent)
}

const (
	labelProject     = "com.docker.compose.project"
	labelConfigFiles = "com.docker.compose.project.config_files"
	labelWorkingDir  = "com.docker.compose.project.working_dir"
)

// ComposeInfo is a project as shown in the list: registered ones (saved via
// handleCreateCompose) merged with ones discovered live from the compose
// labels Docker stamps on every container `docker compose up` creates — so
// the list reflects what's actually deployed, not just what a user typed in.
type ComposeInfo struct {
	models.ComposeProject
	Discovered bool `json:"discovered"`
	Running    int  `json:"running"`
	Total      int  `json:"total"`
}

// discoverProjects groups all containers by their compose project label.
func (s *Server) discoverProjects(ctx context.Context) map[string][]container.Summary {
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil
	}
	groups := make(map[string][]container.Summary)
	for _, c := range containers {
		if proj := c.Labels[labelProject]; proj != "" {
			groups[proj] = append(groups[proj], c)
		}
	}
	return groups
}

func (s *Server) handleListCompose(w http.ResponseWriter, r *http.Request) {
	cfg, _ := s.store.Read()
	groups := s.discoverProjects(r.Context())

	byFile := make(map[string]int) // compose_file -> index in out
	var out []ComposeInfo
	for _, p := range cfg.ComposeProjects {
		byFile[p.ComposeFile] = len(out)
		out = append(out, ComposeInfo{ComposeProject: p})
	}

	for proj, cs := range groups {
		configFiles := cs[0].Labels[labelConfigFiles]
		composeFile := strings.Split(configFiles, ",")[0]
		running := 0
		for _, c := range cs {
			if c.State == "running" {
				running++
			}
		}
		if idx, ok := byFile[composeFile]; ok {
			out[idx].Running = running
			out[idx].Total = len(cs)
			continue
		}
		out = append(out, ComposeInfo{
			ComposeProject: models.ComposeProject{
				ID:          "auto:" + proj,
				Name:        proj,
				BaseDir:     cs[0].Labels[labelWorkingDir],
				ComposeFile: composeFile,
			},
			Discovered: true,
			Running:    running,
			Total:      len(cs),
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
	cfg, _ := s.store.Read()
	p.ID = fmt.Sprintf("%d", len(cfg.ComposeProjects)+1)
	cfg.ComposeProjects = append(cfg.ComposeProjects, p)
	if err := s.store.Write(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save")
		return
	}
	s.auditFromCtx(r, "compose.register", p.Name, "ok")
	writeJSON(w, http.StatusCreated, map[string]string{"id": p.ID})
}

// composeServices parses the project's compose file (if present on disk) via
// compose-go — the spec-parsing library — into the services it defines. This
// covers services that aren't currently running, unlike inspecting containers.
func composeServices(p models.ComposeProject) composetypes.Services {
	data, err := os.ReadFile(p.ComposeFile)
	if err != nil {
		return nil
	}
	proj, err := loader.LoadWithContext(context.Background(), composetypes.ConfigDetails{
		WorkingDir: p.BaseDir,
		ConfigFiles: []composetypes.ConfigFile{
			{Filename: p.ComposeFile, Content: data},
		},
	}, func(o *loader.Options) { o.SkipValidation = true; o.SkipInterpolation = true; o.SkipResolveEnvironment = true })
	if err != nil {
		return nil
	}
	return proj.Services
}

func (s *Server) handleGetCompose(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		models.ComposeProject
		Services composetypes.Services `json:"services"`
	}{p, composeServices(p)})
}

func (s *Server) handleDeleteCompose(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if strings.HasPrefix(id, "auto:") {
		writeError(w, http.StatusBadRequest, "自动发现的项目无法删除，使用「停止」将其下线")
		return
	}
	cfg, _ := s.store.Read()
	for i, p := range cfg.ComposeProjects {
		if p.ID == id {
			cfg.ComposeProjects = append(cfg.ComposeProjects[:i], cfg.ComposeProjects[i+1:]...)
			if err := s.store.Write(cfg); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to save")
				return
			}
			s.auditFromCtx(r, "compose.delete", id, "ok")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleComposeUp(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "up", "--detach")
}

func (s *Server) handleComposeStop(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "stop")
}

func (s *Server) handleComposeDown(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "down")
}

func (s *Server) handleComposePull(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "pull")
}

func (s *Server) handleComposeRestart(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "restart")
}

// runComposeCmd executes `docker compose -f <file> <args>` and streams
// stdout+stderr to w as newline-delimited {stream}/{error} JSON — the same
// shape docker pull/load/copy progress already uses, so PullStatusWidget
// can render it without any format-specific handling.
//
// ponytail: docker/compose/v2 exists as an embeddable Go library, but it's
// built for the CLI (cobra commands, global service wiring) and is painful
// to embed directly — shelling out to the same `docker compose` binary every
// other tool (Portainer included) uses is simpler and just as reliable.
func (s *Server) runComposeCmd(w http.ResponseWriter, r *http.Request, args ...string) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	cmdArgs := append([]string{"compose", "-f", p.ComposeFile}, args...)
	cmd := exec.CommandContext(r.Context(), "docker", cmdArgs...)
	cmd.Dir = p.BaseDir
	if p.EnvFile != "" {
		cmd.Env = append(os.Environ(), "COMPOSE_ENV_FILES="+p.EnvFile)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")

	rc, err := cmd.StdoutPipe()
	if err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	cmd.Stderr = cmd.Stdout // merge stderr into the same pipe
	if err := cmd.Start(); err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	scanner := bufio.NewScanner(rc)
	for scanner.Scan() {
		dockercontainer.EmitStream(w, "%s", scanner.Text())
	}
	if err := cmd.Wait(); err != nil {
		dockercontainer.EmitError(w, err)
		return
	}
	dockercontainer.EmitStream(w, "✓ 完成")
}

// handleComposeResolvedConfig runs `docker compose config`, which merges every
// -f/override file, resolves `extends`, and substitutes environment variables
// into a single flat YAML — the same effective config `up` would actually
// deploy. Exposed mainly for reference/debugging; the Run/Compose feature
// uses handleComposeRunCommands below, not this raw text.
func (s *Server) handleComposeResolvedConfig(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	cmd := exec.CommandContext(r.Context(), "docker", "compose", "-f", p.ComposeFile, "config")
	cmd.Dir = p.BaseDir
	if p.EnvFile != "" {
		cmd.Env = append(os.Environ(), "COMPOSE_ENV_FILES="+p.EnvFile)
	}
	out, err := cmd.Output()
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
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
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

// maxComposeFileContent caps how much of a file the editor ever loads —
// without it, opening something huge (a log file dropped in the project
// directory, say) would try to pull the whole thing into the browser. The
// frontend refuses to save back when X-Truncated is set, since writing a
// truncated buffer over the real file would destroy the rest of it.
const maxComposeFileContent = 2 << 20 // 2MB

func (s *Server) handleComposeGetFileContent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	fullPath := filepath.Join(p.BaseDir, r.URL.Query().Get("path"))
	if !isSubPath(p.BaseDir, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	f, err := os.Open(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, maxComposeFileContent))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if info.Size() > maxComposeFileContent {
		w.Header().Set("X-Truncated", "true")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data) //nolint:errcheck
}

func (s *Server) handleComposePutFileContent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	subPath := r.URL.Query().Get("path")
	fullPath := filepath.Join(p.BaseDir, subPath)
	if !isSubPath(p.BaseDir, fullPath) {
		writeError(w, http.StatusForbidden, "invalid path")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10MB limit
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "compose.file.write", p.Name+":"+subPath, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleComposeLogsWS(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(r.Context(), r.URL.Query().Get("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	cmd := exec.CommandContext(r.Context(), "docker", "compose", "-f", p.ComposeFile, "logs", "-f")
	cmd.Dir = p.BaseDir
	rc, err := cmd.StdoutPipe()
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error())) //nolint:errcheck
		return
	}
	cmd.Stderr = cmd.Stdout // merge stderr into same pipe
	if err := cmd.Start(); err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error starting logs: "+err.Error())) //nolint:errcheck
		return
	}
	defer cmd.Process.Kill() //nolint:errcheck

	buf := make([]byte, 4096)
	for {
		n, err := rc.Read(buf)
		if n > 0 {
			conn.WriteMessage(websocket.BinaryMessage, buf[:n]) //nolint:errcheck
		}
		if err != nil {
			return
		}
	}
}

// findCompose resolves both manually-registered projects (from the store)
// and live-discovered ones ("auto:<project>" — reconstructed from the compose
// labels on that project's containers, not persisted anywhere).
func (s *Server) findCompose(ctx context.Context, id string) (models.ComposeProject, bool) {
	if name, ok := strings.CutPrefix(id, "auto:"); ok {
		cs, ok := s.discoverProjects(ctx)[name]
		if !ok || len(cs) == 0 {
			return models.ComposeProject{}, false
		}
		configFiles := cs[0].Labels[labelConfigFiles]
		return models.ComposeProject{
			ID:          id,
			Name:        name,
			BaseDir:     cs[0].Labels[labelWorkingDir],
			ComposeFile: strings.Split(configFiles, ",")[0],
		}, true
	}
	cfg, _ := s.store.Read()
	for _, p := range cfg.ComposeProjects {
		if p.ID == id {
			return p, true
		}
	}
	return models.ComposeProject{}, false
}
