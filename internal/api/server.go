package api

import (
	"net/http"

	dockerclient "github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"phyless/internal/audit"
	"phyless/internal/auth"
	"phyless/internal/docker"
	"phyless/internal/models"
	"phyless/internal/store"
)

type Server struct {
	store     *store.Store
	jwtSecret []byte
	dataDir   string
	audit     *audit.Logger
	docker    *dockerclient.Client
}

func New(s *store.Store, jwtSecret []byte, dataDir string) http.Handler {
	dc, err := docker.NewClient()
	if err != nil {
		panic("cannot connect to Docker: " + err.Error())
	}
	srv := &Server{
		store:     s,
		jwtSecret: jwtSecret,
		dataDir:   dataDir,
		audit:     audit.New(dataDir + "/audit.log"),
		docker:    dc,
	}
	r := chi.NewRouter()
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
		srv.mountRegistryRoutes(r)
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

	return r
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
	r.Get("/api/containers/{id}/export", s.handleContainerExport)
	r.Post("/api/containers/import", s.handleContainerImport)
	r.Get("/api/containers/{id}/files", s.handleContainerListFiles)
	r.Get("/api/containers/{id}/files/download", s.handleContainerDownloadFile)
	r.Post("/api/containers/{id}/files/upload", s.handleContainerUploadFile)

	// Images
	r.Get("/api/images", s.handleListImages)
	r.Get("/api/images/{id}", s.handleGetImage)
	r.Delete("/api/images/{id}", s.handleDeleteImage)
	r.Get("/api/images/{id}/inspect", s.handleImageInspect)
	r.Get("/api/images/{id}/history", s.handleImageHistory)
	r.Post("/api/images/pull", s.handleImagePull)
	r.Post("/api/images/{id}/tag", s.handleImageTag)
	r.Delete("/api/images/{id}/tags/{tag}", s.handleImageDeleteTag)
	r.Get("/api/images/{id}/save", s.handleImageSave)
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

func (s *Server) mountComposeRoutes(r chi.Router)  {}
func (s *Server) mountConfigRoutes(r chi.Router)   {}
func (s *Server) mountRegistryRoutes(r chi.Router) {}
