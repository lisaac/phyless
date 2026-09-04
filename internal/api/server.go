package api

import (
	"context"
	"net/http"
	"os"

	dockerclient "github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"phyless/internal/audit"
	"phyless/internal/auth"
	"phyless/internal/docker"
	dockercompose "phyless/internal/docker/compose"
	"phyless/internal/models"
	"phyless/internal/store"
	"phyless/internal/ws"
)

type contextKey struct{}

type Server struct {
	store          *store.Store
	jwtSecret      []byte
	dataDir        string
	audit          *audit.Logger
	docker         dockerclient.APIClient
	composeRuntime *dockercompose.Runtime
}

func New(s *store.Store, jwtSecret []byte, dataDir string) http.Handler {
	dc, err := docker.NewClient()
	if err != nil {
		panic("cannot connect to Docker: " + err.Error())
	}
	composeRuntime, err := dockercompose.NewRuntime(dc)
	if err != nil {
		_ = dc.Close()
		panic("cannot initialize Compose: " + err.Error())
	}
	srv := &Server{
		store:          s,
		jwtSecret:      jwtSecret,
		dataDir:        dataDir,
		audit:          audit.New(dataDir + "/audit.log"),
		docker:         dc,
		composeRuntime: composeRuntime,
	}
	r := chi.NewRouter()
	// chi routes on r.URL.RawPath when set, which leaves path params percent-encoded
	// (e.g. image IDs like "sha256:abc" arrive as "sha256%3Aabc" and get passed
	// straight to Docker, which rejects them). Clear it so chi matches and extracts
	// params from the already-decoded r.URL.Path instead.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.URL.RawPath = ""
			next.ServeHTTP(w, r)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Public
	r.Post("/api/auth/login", srv.handleLogin)
	r.Post("/api/auth/logout", srv.handleLogout)

	// Viewer+
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(jwtSecret, models.RoleViewer))
		r.Get("/api/auth/me", srv.handleMe)
	})

	// Operator+
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(jwtSecret, models.RoleOperator))
		srv.mountDockerRoutes(r)
		srv.mountComposeRoutes(r)
		srv.mountConfigRoutes(r)
		srv.mountFsRoutes(r)
		srv.mountRegistryRoutes(r)
		srv.mountTemplateRoutes(r)
	})

	// Admin only
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(jwtSecret, models.RoleAdmin))
		r.Get("/api/users", srv.handleListUsers)
		r.Post("/api/users", srv.handleCreateUser)
		r.Get("/api/users/{id}", srv.handleGetUser)
		r.Put("/api/users/{id}", srv.handleUpdateUser)
		r.Delete("/api/users/{id}", srv.handleDeleteUser)
		r.Get("/api/audit", srv.handleListAudit)
	})

	// WebSocket routes (auth via query param token for WS upgrade compatibility)
	r.Get("/ws/containers/{id}/logs", wsAuth(jwtSecret, models.RoleViewer, ws.Logs(dc)))
	r.Get("/ws/containers/{id}/terminal", wsAuth(jwtSecret, models.RoleOperator, ws.Terminal(dc)))
	r.Get("/ws/containers/{id}/stats", wsAuth(jwtSecret, models.RoleViewer, ws.Stats(dc)))
	r.Get("/ws/events", wsAuth(jwtSecret, models.RoleViewer, ws.Events(dc)))
	r.Get("/ws/compose/logs", wsAuth(jwtSecret, models.RoleViewer, srv.handleComposeLogsWS))

	// Download routes — browsers can't set Authorization headers on <a href>, use query token instead
	r.Get("/api/containers/{id}/export", wsAuth(jwtSecret, models.RoleOperator, srv.handleContainerExport))
	r.Get("/api/containers/{id}/files/download", wsAuth(jwtSecret, models.RoleOperator, srv.handleContainerDownloadFile))
	r.Get("/api/images/save", wsAuth(jwtSecret, models.RoleOperator, srv.handleImageSave))

	distDir := "./web/dist"
	if _, err := os.Stat(distDir); err == nil {
		fs := http.FileServer(http.Dir(distDir))
		r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			if _, err := os.Stat(distDir + path); os.IsNotExist(err) {
				// SPA fallback — index.html must never be stale
				w.Header().Set("Cache-Control", "no-store")
				http.ServeFile(w, r, distDir+"/index.html")
				return
			}
			// Hashed assets (e.g. /assets/index-abc123.js) can be cached forever.
			// index.html itself must not be cached.
			if path == "/" || path == "/index.html" {
				w.Header().Set("Cache-Control", "no-store")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fs.ServeHTTP(w, r)
		})
	}

	return r
}

// wsAuth accepts token via ?token= query param (browsers can't set headers on WS upgrade).
func wsAuth(secret []byte, minRole models.Role, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		claims, err := auth.ValidateToken(token, secret)
		if err != nil || claims.Role.Level() < minRole.Level() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, claims)))
	}
}

func (s *Server) mountDockerRoutes(r chi.Router) {
	// Containers
	r.Get("/api/containers", s.handleListContainers)
	r.Post("/api/containers", s.handleCreateContainer)
	r.Get("/api/containers/{id}", s.handleGetContainer)
	r.Delete("/api/containers/{id}", s.handleDeleteContainer)
	r.Post("/api/containers/{id}/start", s.handleContainerStart)
	r.Post("/api/containers/{id}/stop", s.handleContainerStop)
	r.Post("/api/containers/{id}/restart", s.handleContainerRestart)
	r.Post("/api/containers/{id}/pause", s.handleContainerPause)
	r.Post("/api/containers/{id}/unpause", s.handleContainerUnpause)
	r.Post("/api/containers/{id}/kill", s.handleContainerKill)
	r.Post("/api/containers/{id}/rename", s.handleContainerRename)
	r.Post("/api/containers/{id}/duplicate", s.handleContainerDuplicate)
	r.Post("/api/containers/{id}/upgrade", s.handleContainerUpgrade)
	r.Put("/api/containers/{id}/resources", s.handleContainerUpdateResources)
	r.Get("/api/containers/{id}/inspect", s.handleContainerInspect)
	r.Post("/api/containers/import", s.handleContainerImport)
	r.Get("/api/containers/{id}/top", s.handleContainerTop)
	r.Get("/api/containers/{id}/files", s.handleContainerListFiles)
	r.Post("/api/containers/{id}/files/upload", s.handleContainerUploadFile)
	r.Delete("/api/containers/{id}/files", s.handleContainerDeleteFile)
	r.Post("/api/containers/{id}/files/rename", s.handleContainerRenameFile)
	r.Post("/api/containers/{id}/files/copy-to", s.handleContainerCopyToContainer)

	// Images — id passed as ?id= (query string), not a path segment: image
	// refs routinely contain colons ("sha256:abc", "nginx:latest"), and colons
	// in path segments hit an unresolved chi RawPath decoding quirk that leaked
	// literal "%3A" through to the Docker daemon. Query string decoding has no
	// such ambiguity.
	r.Get("/api/images", s.handleListImages)
	r.Get("/api/images/detail", s.handleGetImage)
	r.Delete("/api/images", s.handleDeleteImage)
	r.Get("/api/images/inspect", s.handleImageInspect)
	r.Get("/api/images/history", s.handleImageHistory)
	r.Post("/api/images/pull", s.handleImagePull)
	r.Post("/api/images/tag", s.handleImageTag)
	r.Delete("/api/images/untag", s.handleImageDeleteTag)
	r.Post("/api/images/load", s.handleImageLoad)

	// Networks
	r.Get("/api/networks", s.handleListNetworks)
	r.Post("/api/networks", s.handleCreateNetwork)
	r.Get("/api/networks/{id}", s.handleGetNetwork)
	r.Delete("/api/networks/{id}", s.handleDeleteNetwork)
	r.Get("/api/networks/{id}/inspect", s.handleNetworkInspect)
	r.Post("/api/networks/{id}/connect", s.handleNetworkConnect)
	r.Post("/api/networks/{id}/disconnect", s.handleNetworkDisconnect)

	// Volumes
	r.Get("/api/volumes", s.handleListVolumes)
	r.Post("/api/volumes", s.handleCreateVolume)
	r.Get("/api/volumes/{id}", s.handleGetVolume)
	r.Delete("/api/volumes/{id}", s.handleDeleteVolume)
	r.Get("/api/volumes/{id}/inspect", s.handleVolumeInspect)
	r.Get("/api/volumes/{id}/files", s.handleVolumeListFiles)
}
