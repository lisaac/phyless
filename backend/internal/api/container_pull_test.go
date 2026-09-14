package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"phyless/backend/internal/audit"
	"phyless/backend/internal/docker"
)

type createPullClient struct {
	client.APIClient
	inspectErr      error
	templateErr     error
	pullFailure     bool
	pulled, created bool
	createdConfig   *container.Config
	proxied         bool
	options         image.PullOptions
}

func (c *createPullClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{Os: "linux", Architecture: "amd64"}, c.inspectErr
}
func (c *createPullClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	if c.templateErr != nil {
		return container.InspectResponse{}, c.templateErr
	}
	return container.InspectResponse{Config: &container.Config{Image: "template"}}, nil
}
func (c *createPullClient) ImagePull(ctx context.Context, _ string, options image.PullOptions) (io.ReadCloser, error) {
	c.pulled = true
	c.proxied = docker.HasPullProxy(ctx)
	c.options = options
	if c.pullFailure {
		return io.NopCloser(strings.NewReader(`{"errorDetail":{"message":"denied"}}`)), nil
	}
	return io.NopCloser(strings.NewReader(`{"status":"done"}`)), nil
}
func (c *createPullClient) ContainerCreate(_ context.Context, cfg *container.Config, _ *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	c.created = true
	c.createdConfig = cfg
	return container.CreateResponse{ID: "new-container"}, nil
}

func TestCreatePullPoliciesAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name, policy                      string
		inspectErr                        error
		pullFailure, wantPull, wantCreate bool
	}{
		{"empty", "", nil, false, false, true},
		{"always", "always", nil, false, true, true},
		{"never", "never", nil, false, false, true},
		{"present", "missing", nil, false, false, true},
		{"missing", "missing", errdefs.NotFound(errors.New("missing")), false, true, true},
		{"inspect-error", "missing", errors.New("daemon unavailable"), false, false, false},
		{"pull-error", "always", nil, true, true, false},
		{"invalid", "bogus", nil, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &createPullClient{inspectErr: tc.inspectErr, pullFailure: tc.pullFailure}
			s := &Server{docker: c, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
			r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"image":"alpine","pull_policy":"`+tc.policy+`"}`))
			w := httptest.NewRecorder()
			s.handleCreateContainer(w, r)
			if c.pulled != tc.wantPull || c.created != tc.wantCreate {
				t.Fatalf("pull=%v create=%v response=%s", c.pulled, c.created, w.Body.String())
			}
		})
	}
}

func TestCreateRejectsTemplateInspectError(t *testing.T) {
	c := &createPullClient{templateErr: errors.New("template unavailable")}
	s := &Server{docker: c, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"image":"alpine","template_id":"missing"}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != 400 || c.created {
		t.Fatalf("status=%d created=%v body=%s", w.Code, c.created, w.Body.String())
	}
}

func TestCreateRejectsMissingImage(t *testing.T) {
	c := &createPullClient{}
	s := &Server{docker: c, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"name":"app"}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != 400 || c.created || c.pulled {
		t.Fatalf("status=%d created=%v pulled=%v body=%s", w.Code, c.created, c.pulled, w.Body.String())
	}
}

func TestCreatePreservesExplicitEmptyEntrypoint(t *testing.T) {
	c := &createPullClient{}
	s := &Server{docker: c, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"image":"alpine","entrypoint":[]}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != http.StatusOK || c.createdConfig == nil || c.createdConfig.Entrypoint == nil || len(c.createdConfig.Entrypoint) != 0 {
		t.Fatalf("status=%d config=%#v body=%s", w.Code, c.createdConfig, w.Body.String())
	}
}
