package compose

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	composeapi "github.com/docker/compose/v2/pkg/api"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
)

type pullContextTestKey struct{}
type interceptPullClient struct {
	fakeAPIClient
	pulls        int
	opts         image.PullOptions
	contextValue any
	failure      bool
}

func (c *interceptPullClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	if c.pulls == 0 {
		return image.InspectResponse{}, errdefs.NotFound(errors.New("not found"))
	}
	return image.InspectResponse{ID: "sha256:test", Os: "linux", Architecture: "arm64"}, nil
}
func (c *interceptPullClient) ImagePull(ctx context.Context, _ string, opts image.PullOptions) (io.ReadCloser, error) {
	c.pulls++
	c.opts = opts
	c.contextValue = ctx.Value(pullContextTestKey{})
	if c.failure {
		return io.NopCloser(strings.NewReader(`{"errorDetail":{"message":"denied"}}`)), nil
	}
	return io.NopCloser(strings.NewReader(`{"status":"Pull complete"}`)), nil
}

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
				"app": {Name: "app", Image: "registry.example/app:latest", Platform: "linux/arm64"},
			}}
			err = svc.Compose().Pull(ctx, project, composeapi.PullOptions{})
			if (err != nil) != fail {
				t.Fatalf("error = %v", err)
			}
			if c.pulls != 1 || c.contextValue != "request-marker" || c.opts.Platform != "linux/arm64" {
				t.Fatalf("pulls=%d context=%v platform=%s", c.pulls, c.contextValue, c.opts.Platform)
			}
			auth, err := registry.DecodeAuthConfig(c.opts.RegistryAuth)
			if err != nil || auth.Username != "test" || auth.Password != "test-password" {
				t.Fatalf("auth forwarding failed: %v", err)
			}
		})
	}
}
