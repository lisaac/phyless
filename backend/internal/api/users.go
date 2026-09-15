package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

var (
	errUserNotFound      = errors.New("user not found")
	errDuplicateUsername = errors.New("username already exists")
	errLastAdmin         = errors.New("cannot remove the last administrator")
)

func userMutationStatus(err error) int {
	switch {
	case errors.Is(err, errUserNotFound):
		return http.StatusNotFound
	case errors.Is(err, errDuplicateUsername), errors.Is(err, errLastAdmin):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

func passwordHash(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Never expose password hashes
	type safeUser struct {
		ID       string      `json:"id"`
		Username string      `json:"username"`
		Role     models.Role `json:"role"`
	}
	out := make([]safeUser, len(cfg.Users))
	for i, u := range cfg.Users {
		out[i] = safeUser{ID: u.ID, Username: u.Username, Role: u.Role}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string      `json:"username"`
		Password string      `json:"password"`
		Role     models.Role `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" || !body.Role.Valid() {
		writeError(w, http.StatusBadRequest, "username, password and a valid role are required")
		return
	}
	hash, err := passwordHash(body.Password)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid password")
		return
	}
	var id string
	err = s.store.Update(func(cfg *store.Config) error {
		for _, existing := range cfg.Users {
			if strings.EqualFold(existing.Username, body.Username) {
				return errDuplicateUsername
			}
		}
		var err error
		id, err = store.NewID("u")
		if err != nil {
			return err
		}
		cfg.Users = append(cfg.Users, models.User{ID: id, Username: body.Username, PasswordHash: string(hash), Role: body.Role})
		return nil
	})
	if err != nil {
		writeError(w, userMutationStatus(err), err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, err := s.store.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, u := range cfg.Users {
		if u.ID == id {
			writeJSON(w, http.StatusOK, map[string]any{"id": u.ID, "username": u.Username, "role": u.Role})
			return
		}
	}
	writeError(w, http.StatusNotFound, "user not found")
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Password string      `json:"password,omitempty"`
		Role     models.Role `json:"role,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Role != "" && !body.Role.Valid() {
		writeError(w, http.StatusBadRequest, "invalid role")
		return
	}
	var hash string
	if body.Password != "" {
		generated, err := passwordHash(body.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid password")
			return
		}
		hash = generated
	}
	err := s.store.Update(func(cfg *store.Config) error {
		for i, u := range cfg.Users {
			if u.ID != id {
				continue
			}
			changed := body.Password != "" || (body.Role != "" && body.Role != u.Role)
			if body.Role != "" && body.Role != u.Role && u.Role == models.RoleAdmin && body.Role != models.RoleAdmin && countAdmins(cfg.Users) == 1 {
				return errLastAdmin
			}
			if body.Password != "" {
				cfg.Users[i].PasswordHash = hash
			}
			if body.Role != "" {
				cfg.Users[i].Role = body.Role
			}
			if changed {
				if cfg.Users[i].TokenVersion == ^uint64(0) {
					return errors.New("user token version exhausted")
				}
				cfg.Users[i].TokenVersion++
			}
			return nil
		}
		return errUserNotFound
	})
	if err != nil {
		writeError(w, userMutationStatus(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.Update(func(cfg *store.Config) error {
		for i, u := range cfg.Users {
			if u.ID != id {
				continue
			}
			if u.Role == models.RoleAdmin && countAdmins(cfg.Users) == 1 {
				return errLastAdmin
			}
			cfg.Users = append(cfg.Users[:i], cfg.Users[i+1:]...)
			return nil
		}
		return errUserNotFound
	})
	if err != nil {
		writeError(w, userMutationStatus(err), err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func countAdmins(users []models.User) int {
	n := 0
	for _, u := range users {
		if u.Role == models.RoleAdmin {
			n++
		}
	}
	return n
}
