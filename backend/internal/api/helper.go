package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
	dockercompose "phyless/backend/internal/docker/compose"
	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/self"
	"phyless/backend/internal/store"
)

// RunHelper is the `phyless helper ...` entry point run inside the helper
// container (see self.Launch). It performs one operation that stops the main
// phyless container, writes NDJSON progress to stdout and audits the outcome.
// Returns the process exit code.
//
//	helper --user U container-upgrade <id> [ENV...]
//	helper --user U compose <up|redeploy|restart|stop|down> <project id>
func RunHelper(dataDir string, args []string) int {
	out := os.Stdout
	user := "anonymous"
	if len(args) >= 2 && args[0] == "--user" {
		user, args = args[1], args[2:]
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	s, err := helperServer(dataDir)
	if err == nil {
		defer s.docker.Close()
		switch {
		case len(args) >= 2 && args[0] == "container-upgrade":
			_, err = dockercontainer.UpgradeWithoutPull(ctx, s.docker, args[1], out, dockercontainer.UpgradeOptions{EnvFromImage: args[2:]})
			s.helperAudit(user, "container.upgrade", args[1], err)
		case len(args) == 3 && args[0] == "compose":
			err = s.helperCompose(ctx, out, args[1], args[2])
			s.helperAudit(user, "compose."+args[1], args[2], err)
		default:
			err = fmt.Errorf("usage: helper [--user U] container-upgrade <id> [ENV...] | compose <op> <project id>")
		}
	}
	if err != nil {
		dockercontainer.EmitError(out, err)
		return 1
	}
	return 0
}

func helperServer(dataDir string) (*Server, error) {
	st := store.New(filepath.Join(dataDir, "config.json"))
	cfg, err := st.Read()
	if err != nil {
		return nil, err
	}
	server, err := cfg.ActiveDockerServer()
	if err != nil {
		return nil, err
	}
	client, err := docker.NewClient(server.DockerEndpoint)
	if err != nil {
		return nil, err
	}
	rt, err := dockercompose.NewRuntime(client)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	return &Server{store: st, dataDir: dataDir, audit: audit.New(dataDir + "/audit.log"), docker: client, composeRuntime: rt}, nil
}

// helperCompose deploys from local images only: the main process already
// pulled with the request's credentials and proxy before handing off.
func (s *Server) helperCompose(ctx context.Context, out io.Writer, operation, id string) error {
	resolved, err := s.resolveCompose(ctx, id)
	if err != nil {
		return err
	}
	project, projectName, err := s.loadComposeForOperation(ctx, resolved, operation)
	if err != nil {
		return err
	}
	if err := validateComposeOperation(ctx, operation, project); err != nil {
		return err
	}
	output := dockercompose.NewNDJSONWriter(out)
	err = s.composeExec(ctx, operation, project, projectName, dockercompose.ServiceOptions{Output: output}, requestPullOptions{PullPolicy: "never"}, output)
	output.Flush()
	if err == nil {
		dockercontainer.EmitStream(out, "✓ 完成")
	}
	return err
}

func (s *Server) helperAudit(user, action, target string, err error) {
	if logErr := s.audit.Log(user, action, target, composeOperationResult(err)); logErr != nil {
		fmt.Fprintf(os.Stderr, "audit: write failed: %v\n", logErr)
	}
}

// handleSelf tells the UI which container is phyless itself ("" when bare), so
// stop/restart/delete on it can warn first.
func (s *Server) handleSelf(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"id": s.selfID(r.Context())})
}

func (s *Server) handleHelperResult(w http.ResponseWriter, r *http.Request) {
	res, err := self.LastResult(r.Context(), s.docker)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}
