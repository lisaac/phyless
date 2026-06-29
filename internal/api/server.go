package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"phyless/internal/auth"
	"phyless/internal/models"
	"phyless/internal/store"
)

type Server struct {
	store     *store.Store
	jwtSecret []byte
	dataDir   string
}

func New(s *store.Store, jwtSecret []byte, dataDir string) http.Handler {
	srv := &Server{store: s, jwtSecret: jwtSecret, dataDir: dataDir}
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

func (s *Server) mountDockerRoutes(r chi.Router)   {}
func (s *Server) mountComposeRoutes(r chi.Router)  {}
func (s *Server) mountConfigRoutes(r chi.Router)   {}
func (s *Server) mountRegistryRoutes(r chi.Router) {}
