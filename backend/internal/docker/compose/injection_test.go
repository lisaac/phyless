package compose

import (
	"context"
	"io"
	"strings"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	cerrdefs "github.com/containerd/errdefs"
	composeapi "github.com/docker/compose/v5/pkg/api"
	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/client"
)

type pullContextTestKey struct{}
type interceptPullClient struct {
	fakeAPIClient
	pulls        int
	opts         client.ImagePullOptions
	contextValue any
	failure      bool
}

func (c *interceptPullClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	if c.pulls == 0 {
		return client.ImageInspectResult{}, cerrdefs.ErrNotFound.WithMessage("not found")
	}
	return client.ImageInspectResult{InspectResponse: image.InspectResponse{ID: "sha256:test", Os: "linux", Architecture: "arm64"}}, nil
}
func (c *interceptPullClient) ImagePull(ctx context.Context, _ string, opts client.ImagePullOptions) (client.ImagePullResponse, error) {
	c.pulls++
	c.opts = opts
	c.contextValue = ctx.Value(pullContextTestKey{})
	if c.failure {
		return pullBody{r: strings.NewReader(`{"errorDetail":{"message":"denied"}}`)}, nil
	}
	return pullBody{r: strings.NewReader(`{"status":"Pull complete"}`)}, nil
}

// pullBody is a progress stream; Compose only reads it.
type pullBody struct {
	client.ImagePullResponse
	r io.Reader
}

func (b pullBody) Read(p []byte) (int, error) { return b.r.Read(p) }
func (pullBody) Close() error                 { return nil }

func TestOfficialComposePullUsesInjectedAPIClient(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "stream-error"}[fail], func(t *testing.T) {
			t.Setenv("DOCKER_CONFIG", t.TempDir())
			c := &interceptPullClient{fakeAPIClient: fakeAPIClient{host: "unix:///var/run/docker.sock"}, failure: fail}
			runtime, err := NewRuntime(c)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.WithValue(context.Background(), pullContextTestKey{}, "request-marker")
			svc, err := runtime.NewService(ctx, ServiceOptions{AuthConfigs: map[string]registry.AuthConfig{
				"registry.example": {ServerAddress: "registry.example", Username: "test", Password: "test-password"},
			}})
			if err != nil {
				t.Fatal(err)
			}
			project := &composetypes.Project{Name: "test", Services: composetypes.Services{
				"app": {Name: "app", ContainerSpec: composetypes.ContainerSpec{Image: "registry.example/app:latest", Platform: "linux/arm64"}},
			}}
			err = svc.Compose().Pull(ctx, project, composeapi.PullOptions{})
			if (err != nil) != fail {
				t.Fatalf("error = %v", err)
			}
			if c.pulls != 1 || c.contextValue != "request-marker" || len(c.opts.Platforms) != 1 || c.opts.Platforms[0].OS != "linux" || c.opts.Platforms[0].Architecture != "arm64" {
				t.Fatalf("pulls=%d context=%v platforms=%v", c.pulls, c.contextValue, c.opts.Platforms)
			}
			auth, err := authconfig.Decode(c.opts.RegistryAuth)
			if err != nil || auth.Username != "test" || auth.Password != "test-password" {
				t.Fatalf("auth forwarding failed: %v", err)
			}
		})
	}
}
