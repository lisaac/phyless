package api

import (
	"context"
	"errors"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"
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
	options         client.ImagePullOptions
}

// pullStream is a canned ImagePull body; handlers only read it as a stream.
type pullStream struct{ io.ReadCloser }

func (pullStream) JSONMessages(context.Context) iter.Seq2[jsonstream.Message, error] {
	return func(func(jsonstream.Message, error) bool) {}
}
func (pullStream) Wait(context.Context) error { return nil }

func newPullStream(body string) client.ImagePullResponse {
	return pullStream{io.NopCloser(strings.NewReader(body))}
}

func (c *createPullClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{Os: "linux", Architecture: "amd64"}}, c.inspectErr
}
func (c *createPullClient) ContainerInspect(context.Context, string, client.ContainerInspectOptions) (client.ContainerInspectResult, error) {
	if c.templateErr != nil {
		return client.ContainerInspectResult{}, c.templateErr
	}
	return client.ContainerInspectResult{Container: container.InspectResponse{Config: &container.Config{Image: "template"}}}, nil
}
func (c *createPullClient) ImagePull(ctx context.Context, _ string, options client.ImagePullOptions) (client.ImagePullResponse, error) {
	c.pulled = true
	c.proxied = docker.HasPullProxy(ctx)
	c.options = options
	if c.pullFailure {
		return newPullStream(`{"errorDetail":{"message":"denied"}}`), nil
	}
	return newPullStream(`{"status":"done"}`), nil
}
func (c *createPullClient) ContainerCreate(_ context.Context, opts client.ContainerCreateOptions) (client.ContainerCreateResult, error) {
	c.created = true
	c.createdConfig = opts.Config
	return client.ContainerCreateResult{ID: "new-container"}, nil
}

func TestCreatePullPoliciesAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name, policy                      string
		inspectErr                        error
		pullFailure, wantPull, wantCreate bool
	}{
		{"empty-present", "", nil, false, false, true},
		{"empty-missing", "", cerrdefs.ErrNotFound.WithMessage("missing"), false, true, true},
		{"always", "always", nil, false, true, true},
		{"never", "never", nil, false, false, true},
		{"present", "missing", nil, false, false, true},
		{"missing", "missing", cerrdefs.ErrNotFound.WithMessage("missing"), false, true, true},
		{"inspect-error", "missing", errors.New("daemon unavailable"), false, false, false},
		{"pull-error", "always", nil, true, true, false},
		{"invalid", "bogus", nil, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &createPullClient{inspectErr: tc.inspectErr, pullFailure: tc.pullFailure}
			s := &Server{docker: &docker.Client{APIClient: c}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
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
	s := &Server{docker: &docker.Client{APIClient: c}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"image":"alpine","template_id":"missing"}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != 400 || c.created {
		t.Fatalf("status=%d created=%v body=%s", w.Code, c.created, w.Body.String())
	}
}

func TestCreateRejectsMissingImage(t *testing.T) {
	c := &createPullClient{}
	s := &Server{docker: &docker.Client{APIClient: c}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"name":"app"}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != 400 || c.created || c.pulled {
		t.Fatalf("status=%d created=%v pulled=%v body=%s", w.Code, c.created, c.pulled, w.Body.String())
	}
}

func TestCreatePreservesExplicitEmptyEntrypoint(t *testing.T) {
	c := &createPullClient{}
	s := &Server{docker: &docker.Client{APIClient: c}, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
	r := httptest.NewRequest("POST", "/api/containers", strings.NewReader(`{"image":"alpine","entrypoint":[]}`))
	w := httptest.NewRecorder()
	s.handleCreateContainer(w, r)
	if w.Code != http.StatusOK || c.createdConfig == nil || c.createdConfig.Entrypoint == nil || len(c.createdConfig.Entrypoint) != 0 {
		t.Fatalf("status=%d config=%#v body=%s", w.Code, c.createdConfig, w.Body.String())
	}
}
