package api

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"

	"phyless/internal/audit"
	"phyless/internal/docker"
	dockercompose "phyless/internal/docker/compose"
	"phyless/internal/docker/imagefs"
	"phyless/internal/models"
	"phyless/internal/store"
)

// dockerRuntime swaps a complete route graph so every new request captures one
// Docker client, Compose runtime, and imagefs manager from the same server.
// This is smaller and safer than teaching every APIClient method to delegate.
type dockerRuntime struct {
	store     *store.Store
	jwtSecret []byte
	dataDir   string
	audit     *audit.Logger

	mu      sync.Mutex
	current atomic.Pointer[dockerRuntimeState]
}

type dockerRuntimeState struct {
	handler http.Handler
	ctx     context.Context
	cancel  context.CancelFunc
	client  *docker.Client
}

func newDockerRuntime(s *store.Store, jwtSecret []byte, dataDir string) *dockerRuntime {
	return &dockerRuntime{
		store: s, jwtSecret: jwtSecret, dataDir: dataDir,
		audit: audit.New(dataDir + "/audit.log"),
	}
}

func (r *dockerRuntime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	state := r.current.Load()
	if state == nil {
		http.Error(w, "Docker runtime unavailable", http.StatusServiceUnavailable)
		return
	}
	state.serveHTTP(w, request)
}

// reload builds the new state before publishing it, so a bad TLS payload or
// Compose initialization error leaves the current daemon serving requests.
func (r *dockerRuntime) reload() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	cfg, err := r.store.Read()
	if err != nil {
		return fmt.Errorf("read Docker configuration: %w", err)
	}
	server, err := cfg.ActiveDockerServer()
	if err != nil {
		return err
	}
	next, err := r.newState(server)
	if err != nil {
		return err
	}
	previous := r.current.Swap(next)
	if previous != nil {
		previous.close()
	}
	return nil
}

func (r *dockerRuntime) newState(server models.DockerServer) (*dockerRuntimeState, error) {
	client, err := docker.NewClient(server.DockerEndpoint)
	if err != nil {
		return nil, fmt.Errorf("initialize Docker server %q: %w", server.Name, err)
	}
	composeRuntime, err := dockercompose.NewRuntime(client)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("initialize Compose for Docker server %q: %w", server.Name, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	mgr := imagefs.New(client)
	go mgr.Run(ctx)
	srv := &Server{
		store:          r.store,
		jwtSecret:      r.jwtSecret,
		dataDir:        r.dataDir,
		audit:          r.audit,
		docker:         client,
		composeRuntime: composeRuntime,
		imagefs:        mgr,
		buildCache:     newBuildCapabilityCache(),
		reloadDocker:   r.reload,
	}
	return &dockerRuntimeState{handler: srv.routes(), ctx: ctx, cancel: cancel, client: client}, nil
}

func (s *dockerRuntimeState) serveHTTP(w http.ResponseWriter, request *http.Request) {
	// Retain client disconnect cancellation while also allowing a server switch
	// to interrupt a blocked Docker dial or stream immediately.
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer func() {
		stop()
		cancel()
	}()
	s.handler.ServeHTTP(w, request.WithContext(ctx))
}

func (s *dockerRuntimeState) close() {
	s.cancel()
	_ = s.client.Close()
}

func (r *dockerRuntime) close() {
	r.mu.Lock()
	state := r.current.Swap(nil)
	r.mu.Unlock()
	if state != nil {
		state.close()
	}
}
