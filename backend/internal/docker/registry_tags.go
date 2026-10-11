package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// MaxListedTags bounds one tag listing returned to the UI.
const MaxListedTags = 5000

// ListTags returns a repository's tag names over the request transport (the
// pull proxy or phyless's own network), following registry pagination.
// ponytail: remote.List reads every page before the cap applies; a paged
// lister is the upgrade if a registry with huge tag counts becomes a problem.
func ListTags(ctx context.Context, t *http.Transport, repository, registryAuth string) ([]string, error) {
	repo, err := name.NewRepository(repository)
	if err != nil {
		return nil, errors.New("invalid repository")
	}
	auth, err := pullAuth(repo.Tag("latest"), registryAuth)
	if err != nil {
		return nil, err
	}
	tags, err := remote.List(repo,
		remote.WithAuth(auth),
		remote.WithContext(ctx),
		remote.WithTransport(&metadataLimitTransport{inner: t}),
	)
	if err != nil {
		return nil, registryCheckError(err)
	}
	if len(tags) > MaxListedTags {
		tags = tags[:MaxListedTags]
	}
	return tags, nil
}

// CheckRegistryLogin verifies an account the way a pull authenticates: the
// registry's token service (eagerly, for bearer registries) and then /v2/.
func CheckRegistryLogin(ctx context.Context, t *http.Transport, host, username, password string) error {
	reg, err := name.NewRegistry(host)
	if err != nil {
		return errors.New("invalid registry")
	}
	auth := authn.FromConfig(authn.AuthConfig{Username: username, Password: password})
	rt, err := transport.NewWithContext(ctx, reg, auth, t, nil)
	if err != nil {
		return registryCheckError(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reg.Scheme()+"://"+reg.RegistryStr()+"/v2/", nil)
	if err != nil {
		return errors.New("invalid registry")
	}
	resp, err := rt.RoundTrip(req)
	if err != nil {
		return registryCheckError(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("registry returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// RegistryGet reads one registry object (manifest or blob path under /v2/)
// with pull credentials; the transport keeps credentials off redirects to
// other hosts (blob CDNs). The caller bounds and closes the body.
func RegistryGet(ctx context.Context, t *http.Transport, host, repository, path, accept, registryAuth string) (*http.Response, error) {
	repo, err := name.NewRepository(host + "/" + repository)
	if err != nil {
		return nil, errors.New("invalid repository")
	}
	auth, err := pullAuth(repo.Tag("latest"), registryAuth)
	if err != nil {
		return nil, err
	}
	rt, err := transport.NewWithContext(ctx, repo.Registry, auth, t, []string{repo.Scope(transport.PullScope)})
	if err != nil {
		return nil, registryCheckError(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, repo.Registry.Scheme()+"://"+repo.RegistryStr()+path, nil)
	if err != nil {
		return nil, errors.New("invalid registry path")
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := (&http.Client{Transport: rt}).Do(req)
	if err != nil {
		return nil, registryCheckError(err)
	}
	return resp, nil
}
