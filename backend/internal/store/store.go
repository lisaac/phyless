package store

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"

	"phyless/backend/internal/models"
)

type Config struct {
	Users                []models.User           `json:"users"`
	ComposeProjects      []models.ComposeProject `json:"compose_projects"`
	Registries           []models.Registry       `json:"registries"`
	DockerServers        []models.DockerServer   `json:"docker_servers"`
	ActiveDockerServerID string                  `json:"active_docker_server_id"`
	LegacyDocker         *models.DockerEndpoint  `json:"docker,omitempty"`
	Templates            []models.Template       `json:"templates"`
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
	return s.readLocked()
}

func (s *Store) readLocked() (*Config, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return emptyConfig(), nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Users == nil {
		cfg.Users = []models.User{}
	}
	if cfg.ComposeProjects == nil {
		cfg.ComposeProjects = []models.ComposeProject{}
	}
	if cfg.Registries == nil {
		cfg.Registries = []models.Registry{}
	}
	if cfg.Templates == nil {
		cfg.Templates = []models.Template{}
	}
	normalizeDockerServers(&cfg)
	return &cfg, nil
}

func (s *Store) Write(cfg *Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeLocked(cfg)
}

// Update serializes a read-modify-write operation and only replaces the
// configuration after the callback and atomic temporary-file write succeed.
// A directory-sync error after Rename is returned even though the replacement
// is already committed; callers must not blindly retry such an error.
func (s *Store) Update(fn func(*Config) error) error {
	if fn == nil {
		return fmt.Errorf("store: nil update callback")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := s.readLocked()
	if err != nil {
		return err
	}
	if err := fn(cfg); err != nil {
		return err
	}
	return s.writeLocked(cfg)
}

func (s *Store) writeLocked(cfg *Config) error {
	normalizeDockerServers(cfg)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		log.Printf("store: create temporary file in %s failed: %v", dir, err)
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	var written int
	written, err = tmp.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmpName, s.path)
	}
	if err == nil {
		// Sync the directory entry too; a crash after rename must not resurrect
		// the old name when the filesystem replays metadata.
		if dirFile, openErr := os.Open(dir); openErr != nil {
			err = openErr
		} else {
			err = dirFile.Sync()
			if closeErr := dirFile.Close(); err == nil {
				err = closeErr
			}
		}
	}
	if err != nil {
		log.Printf("store: write %s failed: %v", s.path, err)
		return err
	}
	return nil
}

func emptyConfig() *Config {
	return &Config{
		Users:                []models.User{},
		ComposeProjects:      []models.ComposeProject{},
		Registries:           []models.Registry{},
		DockerServers:        []models.DockerServer{{ID: models.LocalDockerServerID, Name: "本机 Docker", ComposeDir: "/srv"}},
		Templates:            []models.Template{},
		ActiveDockerServerID: models.LocalDockerServerID,
	}
}

// ActiveDockerServer returns the selected server after the migration/default
// normalization performed by Read and Write.
func (cfg *Config) ActiveDockerServer() (models.DockerServer, error) {
	for _, server := range cfg.DockerServers {
		if server.ID == cfg.ActiveDockerServerID {
			return server, nil
		}
	}
	return models.DockerServer{}, fmt.Errorf("store: active Docker server not found")
}

func normalizeDockerServers(cfg *Config) {
	if cfg.DockerServers == nil {
		cfg.DockerServers = []models.DockerServer{}
	}
	if len(cfg.DockerServers) == 0 {
		name := "本机 Docker"
		endpoint := models.DockerEndpoint{}
		if cfg.LegacyDocker != nil {
			endpoint = *cfg.LegacyDocker
			if endpoint != (models.DockerEndpoint{}) {
				name = "默认 Docker"
			}
		}
		cfg.DockerServers = append(cfg.DockerServers, models.DockerServer{
			ID: models.LocalDockerServerID, Name: name, DockerEndpoint: endpoint,
		})
	}
	cfg.LegacyDocker = nil
	for i := range cfg.DockerServers {
		if cfg.DockerServers[i].ComposeDir == "" {
			cfg.DockerServers[i].ComposeDir = "/srv"
		}
	}
	for _, server := range cfg.DockerServers {
		if server.ID == cfg.ActiveDockerServerID {
			return
		}
	}
	cfg.ActiveDockerServerID = cfg.DockerServers[0].ID
}

// NewID returns a collision-resistant identifier without adding a dependency.
func NewID(prefix string) (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s_%x", prefix, raw), nil
}
