package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/google/go-containerregistry/pkg/name"
	"phyless/backend/internal/docker"
	dockercontainer "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/imagefs"
)

const (
	updateLatest      = "latest"
	updateAvailable   = "update"
	updateLocalNewer  = "local-newer" // tag already points at a newer local image; upgrade needs no download
	updateUnsupported = "unsupported"
	updateError       = "error"

	updateCheckConcurrency = 4
	updateCheckTimeout     = 20 * time.Second
)

type updateCheckResult struct {
	ID       string `json:"id"`
	Ref      string `json:"ref"`
	Status   string `json:"status"`
	LocalID  string `json:"local_id"`
	RemoteID string `json:"remote_id,omitempty"`
	Error    string `json:"error,omitempty"`
}

// matchesRemote covers every way a local image can be "the same" as the
// registry's: classic store (ID == config digest), containerd store (ID ==
// manifest/index digest) and daemon pulls (RepoDigests). Images imported by
// the proxy/browser paths have no RepoDigests, hence the config comparison.
func matchesRemote(img image.InspectResponse, r docker.RemoteImage) bool {
	if img.ID == "" {
		return false
	}
	if (r.ConfigDigest != "" && img.ID == r.ConfigDigest) || (r.Digest != "" && img.ID == r.Digest) || (r.ManifestDigest != "" && img.ID == r.ManifestDigest) {
		return true
	}
	for _, d := range img.RepoDigests {
		if r.Digest != "" && strings.HasSuffix(d, "@"+r.Digest) {
			return true
		}
	}
	return false
}

func updateStatus(current, tag image.InspectResponse, tagErr error, remote docker.RemoteImage, remoteErr error) (string, string) {
	tagMoved := tagErr == nil && tag.ID != "" && tag.ID != current.ID
	if remoteErr != nil {
		if tagMoved {
			return updateLocalNewer, ""
		}
		return updateError, remoteErr.Error()
	}
	if matchesRemote(current, remote) {
		return updateLatest, ""
	}
	// Only the registry digest is known (phyless itself could not reach the
	// registry) and this image carries no digest record to compare it with.
	if remote.ConfigDigest == "" && len(current.RepoDigests) == 0 {
		if tagMoved {
			return updateLocalNewer, ""
		}
		return updateError, "cannot compare: image has no registry digest and the registry is unreachable from phyless"
	}
	if tagMoved && matchesRemote(tag, remote) {
		return updateLocalNewer, ""
	}
	return updateAvailable, ""
}

func upgradableRef(ref string) bool {
	if ref == "" || strings.HasPrefix(ref, "sha256:") {
		return false
	}
	parsed, err := name.ParseReference(ref)
	if err != nil {
		return false
	}
	_, isTag := parsed.(name.Tag)
	return isTag
}

func imagePlatform(img image.InspectResponse) string {
	if img.Os == "" || img.Architecture == "" {
		return ""
	}
	p := img.Os + "/" + img.Architecture
	if img.Variant != "" {
		p += "/" + img.Variant
	}
	return p
}

type updateCheckTarget struct {
	result   updateCheckResult
	current  image.InspectResponse
	group    string
	platform string
}

type remoteGroup struct {
	ref, platform string
	needConfig    bool // some image can only be compared by config digest
	remote        docker.RemoteImage
	err           error
}

// handleCheckUpdates compares each container's image with what its registry
// currently serves, without pulling. Registry traffic follows the same path
// a pull with these options would: the request proxy through phyless, or the
// daemon's own registry configuration when no proxy is given.
func (s *Server) handleCheckUpdates(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
		requestPullOptions
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ctx, err := s.pullContext(r.Context(), body.ProxyURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ids := body.IDs
	if len(ids) == 0 {
		list, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, c := range list {
			if !imagefs.IsHelper(c.Labels) {
				ids = append(ids, c.ID)
			}
		}
	}

	var daemonPlatform string
	targets := make([]*updateCheckTarget, 0, len(ids))
	groups := map[string]*remoteGroup{}
	for _, id := range ids {
		t := &updateCheckTarget{result: updateCheckResult{ID: id, Status: updateError}}
		targets = append(targets, t)
		info, err := s.docker.ContainerInspect(ctx, id)
		if err != nil {
			t.result.Error = err.Error()
			continue
		}
		t.result.ID = info.ID
		t.result.LocalID = info.Image
		t.result.Ref = dockercontainer.UpgradeImageRef(info)
		if t.result.Ref == info.Image || !upgradableRef(t.result.Ref) {
			t.result.Status = updateUnsupported
			t.result.Error = "image is not referenced by a registry tag"
			continue
		}
		t.current, _ = s.docker.ImageInspect(ctx, info.Image)
		t.platform = imagePlatform(t.current)
		if t.platform == "" {
			if daemonPlatform == "" {
				if sys, err := s.docker.Info(ctx); err == nil && sys.OSType != "" && sys.Architecture != "" {
					daemonPlatform = strings.ToLower(sys.OSType + "/" + sys.Architecture)
				}
			}
			t.platform = daemonPlatform
		}
		t.group = t.result.Ref + "|" + t.platform
		g := groups[t.group]
		if g == nil {
			g = &remoteGroup{ref: t.result.Ref, platform: t.platform}
			groups[t.group] = g
		}
		if len(t.current.RepoDigests) == 0 {
			g.needConfig = true
		}
	}

	proxied := docker.HasPullProxy(ctx)
	sem := make(chan struct{}, updateCheckConcurrency)
	var wg sync.WaitGroup
	for _, g := range groups {
		wg.Add(1)
		go func(g *remoteGroup) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			gctx, cancel := context.WithTimeout(ctx, updateCheckTimeout)
			defer cancel()
			g.remote, g.err = s.resolveRemote(gctx, g, body.RegistryIDs, proxied)
		}(g)
	}
	wg.Wait()

	out := make([]updateCheckResult, 0, len(targets))
	for _, t := range targets {
		if g := groups[t.group]; t.group != "" && g != nil {
			tag, tagErr := s.docker.ImageInspect(ctx, t.result.Ref)
			t.result.Status, t.result.Error = updateStatus(t.current, tag, tagErr, g.remote, g.err)
			t.result.RemoteID = g.remote.ConfigDigest
			if t.result.RemoteID == "" {
				t.result.RemoteID = g.remote.Digest
			}
		}
		out = append(out, t.result)
	}
	writeJSON(w, http.StatusOK, out)
}

// resolveRemote asks the daemon first when no proxy is set, so registry
// mirrors and daemon proxy settings apply exactly as they would to a pull.
// Only images without RepoDigests (imported by the proxy/browser paths) need
// the config digest, which the daemon's distribution API does not expose.
func (s *Server) resolveRemote(ctx context.Context, g *remoteGroup, registryIDs []string, proxied bool) (docker.RemoteImage, error) {
	auth, err := s.registryAuthFromIDs(g.ref, registryIDs)
	if err != nil {
		return docker.RemoteImage{}, err
	}
	if proxied {
		if g.platform == "" {
			return docker.RemoteImage{}, errors.New("cannot determine image platform")
		}
		return docker.ResolveRemoteImage(ctx, g.ref, g.platform, auth)
	}
	di, diErr := s.docker.DistributionInspect(ctx, g.ref, auth)
	if diErr == nil && (!g.needConfig || g.platform == "") {
		return docker.RemoteImage{Digest: di.Descriptor.Digest.String()}, nil
	}
	if g.platform != "" {
		// Best effort: phyless may lack the daemon's registry access (mirrors,
		// daemon proxy); the daemon's digest still decides for most images.
		if r, err := docker.ResolveRemoteImage(ctx, g.ref, g.platform, auth); err == nil || diErr != nil {
			return r, err
		}
	}
	if diErr != nil {
		return docker.RemoteImage{}, errors.New("registry request failed: " + diErr.Error())
	}
	return docker.RemoteImage{Digest: di.Descriptor.Digest.String()}, nil
}
