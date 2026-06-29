package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"phyless/internal/models"
)

func (s *Server) mountComposeRoutes(r chi.Router) {
	r.Get("/api/compose", s.handleListCompose)
	r.Post("/api/compose", s.handleCreateCompose)
	r.Get("/api/compose/{id}", s.handleGetCompose)
	r.Delete("/api/compose/{id}", s.handleDeleteCompose)
	r.Post("/api/compose/{id}/up", s.handleComposeUp)
	r.Post("/api/compose/{id}/down", s.handleComposeDown)
	r.Post("/api/compose/{id}/pull", s.handleComposePull)
	r.Post("/api/compose/{id}/restart", s.handleComposeRestart)
	r.Get("/api/compose/{id}/file", s.handleGetComposeFile)
	r.Put("/api/compose/{id}/file", s.handlePutComposeFile)
}

func (s *Server) handleListCompose(w http.ResponseWriter, r *http.Request) {
	cfg, _ := s.store.Read()
	writeJSON(w, http.StatusOK, cfg.ComposeProjects)
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

func (s *Server) handleGetCompose(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(chi.URLParam(r, "id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleDeleteCompose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
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

func (s *Server) handleComposeDown(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "down")
}

func (s *Server) handleComposePull(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "pull")
}

func (s *Server) handleComposeRestart(w http.ResponseWriter, r *http.Request) {
	s.runComposeCmd(w, r, "restart")
}

// runComposeCmd executes `docker compose -f <file> <args>` and streams stdout+stderr to w.
func (s *Server) runComposeCmd(w http.ResponseWriter, r *http.Request, args ...string) {
	p, ok := s.findCompose(chi.URLParam(r, "id"))
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
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Run(); err != nil {
		w.Write([]byte("\nERROR: " + err.Error())) //nolint:errcheck
	}
}

func (s *Server) handleGetComposeFile(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(chi.URLParam(r, "id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, err := os.ReadFile(p.ComposeFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write(data) //nolint:errcheck
}

func (s *Server) handlePutComposeFile(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(chi.URLParam(r, "id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10MB limit
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := os.WriteFile(p.ComposeFile, data, 0644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.auditFromCtx(r, "compose.file.update", p.Name, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleComposeLogsWS(w http.ResponseWriter, r *http.Request) {
	p, ok := s.findCompose(chi.URLParam(r, "id"))
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

func (s *Server) findCompose(id string) (models.ComposeProject, bool) {
	cfg, _ := s.store.Read()
	for _, p := range cfg.ComposeProjects {
		if p.ID == id {
			return p, true
		}
	}
	return models.ComposeProject{}, false
}
