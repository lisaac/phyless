package store

import (
	"encoding/json"
	"os"
	"sync"

	"phyless/internal/models"
)

type Config struct {
	Users           []models.User           `json:"users"`
	ComposeProjects []models.ComposeProject `json:"compose_projects"`
	Registries      []models.Registry       `json:"registries"`
}

type Store struct {
	path string
	mu   sync.RWMutex
}

func New(path string) *Store {
	return &Store{path: path}
}

func (s *Store) Read() (*Config, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return &Config{
			Users:           []models.User{},
			ComposeProjects: []models.ComposeProject{},
			Registries:      []models.Registry{},
		}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	return &cfg, json.Unmarshal(data, &cfg)
}

func (s *Store) Write(cfg *Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0600)
}
