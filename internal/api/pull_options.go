package api

import (
	"context"
	"fmt"

	"github.com/distribution/reference"
	"github.com/docker/docker/api/types/registry"
	"phyless/internal/docker"
)

type requestPullOptions struct {
	ProxyURL    string   `json:"proxy_url,omitempty"`
	RegistryID  string   `json:"registry_id,omitempty"`
	Platform    string   `json:"platform,omitempty"`
	RegistryIDs []string `json:"registry_ids,omitempty"`
}

func (s *Server) pullContext(ctx context.Context, proxyURL string) (context.Context, error) {
	return docker.WithPullProxy(ctx, proxyURL)
}

func safePullTarget(ref string) string {
	if _, err := reference.ParseAnyReference(ref); err != nil {
		return "<invalid image>"
	}
	return ref
}

// composeRegistryAuth selects credentials explicitly and never consults an
// external credential helper. Duplicate accounts for one host are ambiguous.
func (s *Server) composeRegistryAuth(ids []string) (map[string]registry.AuthConfig, error) {
	result := make(map[string]registry.AuthConfig, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	cfg, err := s.store.Read()
	if err != nil {
		return nil, fmt.Errorf("cannot read registry configuration")
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		found := false
		for _, reg := range cfg.Registries {
			if reg.ID != id {
				continue
			}
			found = true
			host, err := docker.RegistryHost(reg.URL)
			if err != nil {
				return nil, err
			}
			if _, exists := result[host]; exists {
				return nil, fmt.Errorf("multiple registry accounts selected for %s", host)
			}
			result[host] = registry.AuthConfig{Username: reg.Username, Password: decrypt(reg.PasswordEnc), ServerAddress: host}
			break
		}
		if !found {
			return nil, fmt.Errorf("unknown registry ID")
		}
	}
	return result, nil
}

func (s *Server) registryAuthForImage(ref, id string) (string, error) {
	if id == "" {
		if _, err := reference.ParseAnyReference(ref); err != nil {
			return "", fmt.Errorf("invalid image reference")
		}
		return "", nil
	}
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return "", fmt.Errorf("invalid image reference")
	}
	configs, err := s.composeRegistryAuth([]string{id})
	if err != nil {
		return "", err
	}
	host, err := docker.RegistryHost(reference.Domain(named))
	if err != nil {
		return "", err
	}
	config, ok := configs[host]
	if !ok {
		return "", fmt.Errorf("selected registry does not match image host")
	}
	return registry.EncodeAuthConfig(config)
}
