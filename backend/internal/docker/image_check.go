package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// RemoteImage is what a registry currently serves for a tag: the top-level
// descriptor digest (index or manifest), the selected platform's manifest
// digest (image ID of a browser-loaded image under the containerd store) and
// its config digest (image ID under Docker's classic store).
type RemoteImage struct {
	Digest         string
	ManifestDigest string
	ConfigDigest   string
}

// Matches reports whether a local image (ID + RepoDigests) is what the
// registry serves, for every way Docker records that: classic store (ID ==
// config digest), containerd store (ID == index or platform manifest digest,
// the latter for OCI-layout imports) and daemon pulls (RepoDigests). Images
// imported through the proxy/browser paths have no RepoDigests.
func (r RemoteImage) Matches(id string, repoDigests []string) bool {
	if id == "" {
		return false
	}
	for _, d := range []string{r.ConfigDigest, r.Digest, r.ManifestDigest} {
		if d != "" && strings.EqualFold(id, d) {
			return true
		}
	}
	for _, d := range repoDigests {
		if r.Digest != "" && strings.HasSuffix(d, "@"+r.Digest) {
			return true
		}
	}
	return false
}

// RequestTransport is the registry transport for ctx: the request's pull
// proxy, or phyless's own network. Share one per request so connections and
// registry tokens are reused; close idle connections when done.
func RequestTransport(ctx context.Context) (*http.Transport, error) {
	if cfg, ok := pullProxyFromContext(ctx); ok {
		return proxyTransport(cfg)
	}
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport is not configurable")
	}
	return base.Clone(), nil
}

// getImage is the manifest-only registry lookup shared by proxied pulls and
// update checks: the tag's descriptor (index or manifest) and the platform
// image under it. desc is nil when the registry request itself failed.
func getImage(ctx context.Context, ref name.Reference, platform v1.Platform, auth authn.Authenticator, rt *metadataLimitTransport) (*remote.Descriptor, v1.Image, error) {
	desc, err := remote.Get(ref,
		remote.WithAuth(auth),
		remote.WithContext(ctx),
		remote.WithPlatform(platform),
		remote.WithTransport(rt),
	)
	if err != nil {
		return nil, nil, err
	}
	if desc.Size < 0 || desc.Size > maxMetadataSize {
		return nil, nil, errors.New("image manifest is too large")
	}
	img, err := desc.Image()
	return desc, img, err
}

// ResolveRemoteImage reads manifests only — no config or layer blobs.
func ResolveRemoteImage(ctx context.Context, t *http.Transport, ref, platform, registryAuth string) (RemoteImage, error) {
	parsed, err := name.ParseReference(ref)
	if err != nil {
		return RemoteImage{}, errors.New("invalid image reference")
	}
	p, err := v1.ParsePlatform(platform)
	if err != nil || p.OS == "" || p.Architecture == "" {
		return RemoteImage{}, errors.New("invalid image platform")
	}
	auth, err := pullAuth(parsed, registryAuth)
	if err != nil {
		return RemoteImage{}, err
	}
	desc, img, err := getImage(ctx, parsed, normalizePullPlatform(*p), auth, &metadataLimitTransport{inner: t})
	if err != nil {
		return RemoteImage{}, registryCheckError(err)
	}
	m, err := img.Manifest()
	if err != nil {
		return RemoteImage{}, registryCheckError(err)
	}
	md, err := img.Digest()
	if err != nil {
		return RemoteImage{}, registryCheckError(err)
	}
	return RemoteImage{Digest: desc.Digest.String(), ManifestDigest: md.String(), ConfigDigest: m.Config.Digest.String()}, nil
}

// registryCheckError keeps the registry's status/code but never echoes the
// underlying error text, which can carry proxy URLs with credentials.
func registryCheckError(err error) error {
	var te *transport.Error
	switch {
	case errors.As(err, &te):
		codes := make([]string, 0, len(te.Errors))
		for _, e := range te.Errors {
			codes = append(codes, string(e.Code))
		}
		if len(codes) > 0 {
			return fmt.Errorf("registry returned HTTP %d (%s)", te.StatusCode, strings.Join(codes, ", "))
		}
		return fmt.Errorf("registry returned HTTP %d", te.StatusCode)
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("registry request timed out")
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case strings.Contains(err.Error(), "no child with platform"):
		return errors.New("image does not provide the container's platform")
	}
	return errors.New("registry request failed")
}
