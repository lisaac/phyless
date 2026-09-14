package main

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

func seedAdmin(s *store.Store, password string) error {
	return s.Update(func(current *store.Config) error {
		if len(current.Users) > 0 {
			return nil
		}
		if strings.TrimSpace(password) == "" {
			return errors.New("ADMIN_PASSWORD must be set for first startup")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		id, err := store.NewID("u")
		if err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		current.Users = append(current.Users, models.User{
			ID:           id,
			Username:     "admin",
			PasswordHash: string(hash),
			Role:         models.RoleAdmin,
		})
		return nil
	})
}
