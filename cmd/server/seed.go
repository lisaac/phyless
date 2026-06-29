package main

import (
	"fmt"
	"log"

	"golang.org/x/crypto/bcrypt"
	"phyless/internal/models"
	"phyless/internal/store"
)

func seedAdmin(s *store.Store, _ []byte) error {
	cfg, err := s.Read()
	if err != nil {
		return err
	}
	if len(cfg.Users) > 0 {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("seed: %w", err)
	}
	cfg.Users = append(cfg.Users, models.User{
		ID:           "1",
		Username:     "admin",
		PasswordHash: string(hash),
		Role:         models.RoleAdmin,
	})
	log.Println("seeded default admin user (password: admin) — change immediately")
	return s.Write(cfg)
}
