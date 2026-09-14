package api

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	dockerclient "github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/auth"
	dockercompose "phyless/backend/internal/docker/compose"
	"phyless/backend/internal/docker/imagefs"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
	"phyless/backend/internal/ws"
	"phyless/backend/web"
)

type Server struct {
	store          *store.Store
	jwtSecret      []byte
	dataDir        string
	audit          *audit.Logger
	docker         dockerclient.APIClient
	composeRuntime *dockercompose.Runtime
	imagefs        *imagefs.Manager
	buildCache     *buildCapabilityCache
	reloadDocker   func() error
}

func New(s *store.Store, jwtSecret []byte, dataDir string) http.Handler {
	runtime := newDockerRuntime(s, jwtSecret, dataDir)
	if err := runtime.reload(); err != nil {
		panic("cannot initialize Docker runtime: " + err.Error())
	}
	return runtime
}

// routes builds the complete HTTP router from an already constructed Server.
// Keeping Docker/Compose construction in New lets route and authorization
// tests use a fake API client without requiring a daemon.
func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	jwtSecret := s.jwtSecret
	dc := s.docker
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
			origin := r.Header.Get("Origin")
			if origin != "" && !sameOrigin(r, origin) {
				http.Error(w, "cross-origin request denied", http.StatusForbidden)
				return
			}
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(limitJSONBody)
	r.Use(redactRequestURI)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Public
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/logout", s.handleLogout)

	// Viewer+
	r.Group(func(r chi.Router) {
		r.Use(auth.MiddlewareWithUser(jwtSecret, models.RoleViewer, s.lookupUser))
		r.Get("/api/auth/me", s.handleMe)
		s.mountViewerResourceRoutes(r)
	})

	// Operator+
	r.Group(func(r chi.Router) {
		r.Use(auth.MiddlewareWithUser(jwtSecret, models.RoleOperator, s.lookupUser))
		s.mountDockerRoutes(r)
		s.mountComposeRoutes(r)
		s.mountConfigRoutes(r)
		s.mountFsRoutes(r)
		s.mountRegistryRoutes(r)
		s.mountTemplateRoutes(r)
	})

	// Admin only
	r.Group(func(r chi.Router) {
		r.Use(auth.MiddlewareWithUser(jwtSecret, models.RoleAdmin, s.lookupUser))
		s.mountDockerSettingsRoutes(r)
		r.Get("/api/users", s.handleListUsers)
		r.Post("/api/users", s.handleCreateUser)
		r.Get("/api/users/{id}", s.handleGetUser)
		r.Put("/api/users/{id}", s.handleUpdateUser)
		r.Delete("/api/users/{id}", s.handleDeleteUser)
		r.Get("/api/audit", s.handleListAudit)
	})

	// WebSocket routes (auth via query param token for WS upgrade compatibility)
	r.Get("/ws/containers/{id}/logs", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, ws.Logs(dc)))
	r.Get("/ws/containers/{id}/terminal", wsAuthWithUser(jwtSecret, models.RoleOperator, s.lookupUser, ws.Terminal(dc)))
	r.Get("/ws/containers/{id}/stats", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, ws.Stats(dc)))
	r.Get("/ws/events", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, ws.Events(dc)))
	r.Get("/ws/compose/logs", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, s.handleComposeLogsWS))
	r.Get("/ws/images/load", wsAuthWithUser(jwtSecret, models.RoleOperator, s.lookupUser, ws.ImageLoad(dc)))

	// Download routes — browsers can't set Authorization headers on <a href>, use query token instead
	r.Get("/api/containers/{id}/export", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, s.handleContainerExport))
	r.Get("/api/containers/{id}/files/download", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, s.handleContainerDownloadFile))
	r.Get("/api/images/files/download", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, s.handleImageDownloadFile))
	r.Get("/api/images/save", wsAuthWithUser(jwtSecret, models.RoleViewer, s.lookupUser, s.handleImageSave))

	dist, _ := fs.Sub(web.Dist, "dist") // "dist" is a valid path, Sub cannot fail
	// A fresh clone without `npm run build` embeds only dist/.gitkeep; serve the
	// SPA only when there is actually an index.html to serve.
	if _, err := fs.Stat(dist, "index.html"); err == nil {
		r.Get("/*", spaHandler(dist))
	}

	return r
}

// spaHandler serves the embedded frontend. web/scripts/gzip.mjs ships hashed
// assets only as .gz, so the binary embeds the compressed bytes once; clients
// that accept gzip get them verbatim, anyone else gets them inflated.
func spaHandler(dist fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(dist))
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		name := strings.TrimPrefix(path, "/")
		if _, err := fs.Stat(dist, name); err == nil {
			// Hashed assets (e.g. /assets/index-abc123.js) can be cached forever.
			// index.html itself must not be cached.
			if path == "/" || path == "/index.html" {
				w.Header().Set("Cache-Control", "no-store")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		if gz, err := dist.Open(name + ".gz"); err == nil && strings.HasPrefix(name, "assets/") {
			defer gz.Close()
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			w.Header().Set("Vary", "Accept-Encoding")
			if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				http.ServeFileFS(w, r, dist, name+".gz")
				return
			}
			zr, err := gzip.NewReader(gz)
			if err != nil {
				http.Error(w, "bad asset", http.StatusInternalServerError)
				return
			}
			_, _ = io.Copy(w, zr) // ponytail: rare path (no browser omits gzip); no range/etag support
			return
		}
		// SPA fallback — index.html must never be stale
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFileFS(w, r, dist, "index.html")
	}
}

// wsAuth accepts token via ?token= query param (browsers can't set headers on WS upgrade).
func wsAuth(secret []byte, minRole models.Role, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := auth.ValidateToken(r.URL.Query().Get("token"), secret)
		if err != nil || claims.Role.Level() < minRole.Level() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r.WithContext(auth.WithClaims(r.Context(), claims)))
	}
}

func wsAuthWithUser(secret []byte, minRole models.Role, lookup auth.UserLookup, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		ctx, claims, err := auth.Authenticate(r.Context(), token, secret, minRole, lookup)
		if err != nil {
			status := http.StatusUnauthorized
			if errors.Is(err, auth.ErrForbidden) {
				status = http.StatusForbidden
			} else if errors.Is(err, auth.ErrLookup) {
				status = http.StatusServiceUnavailable
			}
			http.Error(w, http.StatusText(status), status)
			return
		}
		if claims.ExpiresAt != nil && !claims.ExpiresAt.Time.IsZero() {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, claims.ExpiresAt.Time)
			defer cancel()
		}
		next(w, r.WithContext(ctx))
	}
}

func (s *Server) lookupUser(ctx context.Context, id string) (*models.User, error) {
	cfg, err := s.store.Read()
	if err != nil {
		return nil, err
	}
	for i := range cfg.Users {
		if cfg.Users[i].ID == id {
			return &cfg.Users[i], nil
		}
	}
	return nil, nil
}

func (s *Server) mountViewerResourceRoutes(r chi.Router) {
	r.Get("/api/containers", s.handleListContainers)
	r.Get("/api/containers/{id}", s.handleGetContainer)
	r.Get("/api/containers/{id}/inspect", s.handleContainerInspect)
	r.Get("/api/containers/{id}/top", s.handleContainerTop)
	r.Get("/api/containers/{id}/files", s.handleContainerListFiles)
	r.Get("/api/images", s.handleListImages)
	r.Get("/api/images/detail", s.handleGetImage)
	r.Get("/api/images/inspect", s.handleImageInspect)
	r.Get("/api/images/history", s.handleImageHistory)
	r.Get("/api/images/files", s.handleImageListFiles)
	r.Get("/api/networks", s.handleListNetworks)
	r.Get("/api/networks/{id}", s.handleGetNetwork)
	r.Get("/api/networks/{id}/inspect", s.handleNetworkInspect)
	r.Get("/api/volumes", s.handleListVolumes)
	r.Get("/api/volumes/{id}", s.handleGetVolume)
	r.Get("/api/volumes/{id}/inspect", s.handleVolumeInspect)
	r.Get("/api/volumes/{id}/files", s.handleVolumeListFiles)
	r.Get("/api/compose", s.handleListCompose)
	r.Get("/api/compose/detail", s.handleGetCompose)
	r.Get("/api/compose/config", s.handleComposeResolvedConfig)
	r.Get("/api/compose/pull-plan", s.handleComposePullPlan)
	r.Get("/api/system/platform", s.handleSystemPlatform)
	r.Get("/api/compose/files", s.handleComposeListFiles)
	r.Get("/api/compose/files/content", s.handleComposeGetFileContent)
	r.Get("/api/compose/files/download", s.handleComposeDownloadFile)
	r.Get("/api/config/files", s.handleConfigListFiles)
	r.Get("/api/config/files/content", s.handleConfigGetFile)
	r.Get("/api/config/files/download", s.handleConfigDownloadFile)
	r.Get("/api/fs/list", s.handleFsList)
	r.Get("/api/fs/file", s.handleFsGetFile)
	r.Get("/api/registries", s.handleListRegistries)
	r.Get("/api/templates", s.handleListTemplates)
	r.Get("/api/system/info", s.handleSystemInfo)
}

const maxJSONBody = 10 << 20

func limitJSONBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !boundedBodyRequest(r) || r.Body == nil {
			next.ServeHTTP(w, r)
			return
		}
		if r.ContentLength > maxJSONBody {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
		next.ServeHTTP(w, r)
	})
}

func boundedBodyRequest(r *http.Request) bool {
	if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodPatch {
		return false
	}
	path := r.URL.Path
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if path == "/api/images/import" {
		return !strings.HasPrefix(contentType, "application/x-tar") && !strings.HasPrefix(contentType, "application/octet-stream")
	}
	if path == "/api/images/load" || path == "/api/containers/import" ||
		strings.HasSuffix(path, "/files/upload") ||
		(path == "/api/config/files/content" && r.Method == http.MethodPut) ||
		(path == "/api/fs/file" && r.Method == http.MethodPut) ||
		(path == "/api/compose/files/content" && r.Method == http.MethodPut) {
		return false
	}
	return true
}

func redactRequestURI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		original := r.RequestURI
		r.RequestURI = safeRequestURI(r)
		defer func() { r.RequestURI = original }()
		next.ServeHTTP(w, r)
	})
}

func safeRequestURI(r *http.Request) string {
	u := *r.URL
	q := u.Query()
	if _, ok := q["token"]; ok {
		q.Set("token", "[REDACTED]")
		u.RawQuery = q.Encode()
	}
	return u.RequestURI()
}

func sameOrigin(r *http.Request, origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host == r.Host
}

func (s *Server) mountDockerRoutes(r chi.Router) {
	// Containers
	r.Post("/api/containers", s.handleCreateContainer)
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
	r.Post("/api/containers/import", s.handleContainerImport)
	r.Post("/api/containers/{id}/files/upload", s.handleContainerUploadFile)
	r.Delete("/api/containers/{id}/files", s.handleContainerDeleteFile)
	r.Post("/api/containers/{id}/files/rename", s.handleContainerRenameFile)
	r.Post("/api/containers/{id}/files/copy-to", s.handleContainerCopyToContainer)

	// Images — id passed as ?id= (query string), not a path segment: image
	// refs routinely contain colons ("sha256:abc", "nginx:latest"), and colons
	// in path segments hit an unresolved chi RawPath decoding quirk that leaked
	// literal "%3A" through to the Docker daemon. Query string decoding has no
	// such ambiguity.
	r.Delete("/api/images", s.handleDeleteImage)
	r.Post("/api/images/delete", s.handleImageDeleteProgress)
	r.Post("/api/images/pull", s.handleImagePull)
	r.Post("/api/images/tag", s.handleImageTag)
	r.Delete("/api/images/untag", s.handleImageDeleteTag)
	r.Post("/api/images/load", s.handleImageLoad)
	r.Post("/api/images/import", s.handleImageImport)
	r.Post("/api/images/prune", s.handleImagePrune)

	// Networks
	r.Post("/api/networks", s.handleCreateNetwork)
	r.Delete("/api/networks/{id}", s.handleDeleteNetwork)
	r.Post("/api/networks/{id}/connect", s.handleNetworkConnect)
	r.Post("/api/networks/{id}/disconnect", s.handleNetworkDisconnect)

	// Volumes
	r.Post("/api/volumes", s.handleCreateVolume)
	r.Delete("/api/volumes/{id}", s.handleDeleteVolume)
}
