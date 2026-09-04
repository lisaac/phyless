package container

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type upgradeClient struct {
	client.APIClient
	alreadyStopped                    bool
	wrongPlatform                     bool
	sameImage                         bool
	pullError, stopError, removeError bool
	stopped, removed, created         bool
	platform                          string
}

func (c *upgradeClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return container.InspectResponse{ContainerJSONBase: &container.ContainerJSONBase{Image: "old", Name: "app", HostConfig: &container.HostConfig{}}, Config: &container.Config{Image: "example/app:latest"}}, nil
}
func (c *upgradeClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: "old", Os: "linux", Architecture: "arm64"}, nil
}
func (c *upgradeClient) ImageInspectWithRaw(context.Context, string) (image.InspectResponse, []byte, error) {
	arch := "arm64"
	if c.wrongPlatform {
		arch = "amd64"
	}
	id := "new"
	if c.sameImage {
		id = "old"
	}
	return image.InspectResponse{ID: id, Os: "linux", Architecture: arch}, nil, nil
}
func (c *upgradeClient) ImagePull(_ context.Context, _ string, opts image.PullOptions) (io.ReadCloser, error) {
	c.platform = opts.Platform
	if c.pullError {
		return io.NopCloser(strings.NewReader(`{"errorDetail":{"message":"denied"}}`)), nil
	}
	return io.NopCloser(strings.NewReader(`{"status":"done"}`)), nil
}
func (c *upgradeClient) ContainerStop(context.Context, string, container.StopOptions) error {
	c.stopped = true
	if c.alreadyStopped {
		return errdefs.NotModified(errors.New("already stopped"))
	}
	if c.stopError {
		return errors.New("stop failed")
	}
	return nil
}
func (c *upgradeClient) ContainerRemove(context.Context, string, container.RemoveOptions) error {
	c.removed = true
	if c.removeError {
		return errors.New("remove failed")
	}
	return nil
}
func (c *upgradeClient) ContainerCreate(context.Context, *container.Config, *container.HostConfig, *network.NetworkingConfig, *ocispec.Platform, string) (container.CreateResponse, error) {
	c.created = true
	return container.CreateResponse{ID: "new-container"}, nil
}
func (c *upgradeClient) ContainerStart(context.Context, string, container.StartOptions) error {
	return nil
}

func TestUpgradeDoesNotContinueAfterFailure(t *testing.T) {
	for _, tc := range []struct {
		name                                                 string
		pull, stop, remove, wantStop, wantRemove, wantCreate bool
	}{
		{"pull", true, false, false, false, false, false},
		{"stop", false, true, false, true, false, false},
		{"remove", false, false, true, true, true, false},
		{"success", false, false, false, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &upgradeClient{pullError: tc.pull, stopError: tc.stop, removeError: tc.remove}
			_, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
			if (err != nil) != (tc.pull || tc.stop || tc.remove) {
				t.Fatalf("error = %v", err)
			}
			if c.stopped != tc.wantStop || c.removed != tc.wantRemove || c.created != tc.wantCreate {
				t.Fatalf("actions stop=%v remove=%v create=%v", c.stopped, c.removed, c.created)
			}
			if c.platform != "linux/arm64" {
				t.Fatalf("platform = %s", c.platform)
			}
		})
	}
}

func TestUpgradeAlreadyStoppedContainer(t *testing.T) {
	c := &upgradeClient{alreadyStopped: true}
	if _, err := Upgrade(context.Background(), c, "old", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	if !c.removed || !c.created {
		t.Fatal("stopped container was not upgraded")
	}
}

func TestUpgradeKeepsContainerOnPlatformMismatch(t *testing.T) {
	c := &upgradeClient{wrongPlatform: true}
	if _, err := Upgrade(context.Background(), c, "old", io.Discard, image.PullOptions{}); err == nil {
		t.Fatal("expected a platform mismatch")
	}
	if c.stopped || c.removed || c.created {
		t.Fatal("platform mismatch changed the original container")
	}
}

func TestUpgradeSkipsRecreateWhenImageIsCurrent(t *testing.T) {
	c := &upgradeClient{sameImage: true}
	newID, err := Upgrade(context.Background(), c, "old", io.Discard, image.PullOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "" {
		t.Fatalf("new container ID = %q, want empty for an up-to-date image", newID)
	}
	if c.stopped || c.removed || c.created {
		t.Fatalf("up-to-date image changed container: stop=%v remove=%v create=%v", c.stopped, c.removed, c.created)
	}
}
