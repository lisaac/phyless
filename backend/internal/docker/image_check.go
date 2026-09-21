package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

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

// ResolveRemoteImage reads manifests only — no config or layer blobs. It uses
// the request's pull proxy when one is set, otherwise phyless' own network.
func ResolveRemoteImage(ctx context.Context, ref, platform, registryAuth string) (RemoteImage, error) {
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
	var t *http.Transport
	if cfg, ok := pullProxyFromContext(ctx); ok {
		if t, err = proxyTransport(cfg); err != nil {
			return RemoteImage{}, err
		}
	} else if base, ok := http.DefaultTransport.(*http.Transport); ok {
		t = base.Clone()
	} else {
		return RemoteImage{}, errors.New("default HTTP transport is not configurable")
	}
	defer t.CloseIdleConnections()
	desc, err := remote.Get(parsed,
		remote.WithAuth(auth),
		remote.WithContext(ctx),
		remote.WithPlatform(normalizePullPlatform(*p)),
		remote.WithTransport(&metadataLimitTransport{inner: t}),
	)
	if err != nil {
		return RemoteImage{}, registryCheckError(err)
	}
	img, err := desc.Image()
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
