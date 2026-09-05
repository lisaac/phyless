package container

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type upgradeClient struct {
	client.APIClient
	info                 container.InspectResponse
	oldImage, newImage   image.InspectResponse
	pullError            bool
	stopError            bool
	createError          bool
	startError           bool
	renameNewError       bool
	removeError          bool
	removeErrorID        string
	startCalls           []string
	stopCalls            []string
	removeCalls          []string
	renameCalls          [][3]string
	createdConfig        *container.Config
	createdHostConfig    *container.HostConfig
	createdNetworkConfig *network.NetworkingConfig
	createdName          string
	pullHook             func()
	createHook           func()
}

func newUpgradeClient() *upgradeClient {
	return &upgradeClient{
		info: container.InspectResponse{
			ContainerJSONBase: &container.ContainerJSONBase{
				ID:         "old-container",
				Image:      "old",
				Name:       "/app",
				State:      &container.State{Running: true},
				HostConfig: &container.HostConfig{},
			},
			Config: &container.Config{Image: "example/app:latest"},
		},
		oldImage: image.InspectResponse{ID: "old", Os: "linux", Architecture: "arm64"},
		newImage: image.InspectResponse{ID: "new", Os: "linux", Architecture: "arm64"},
	}
}

func (c *upgradeClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return c.info, nil
}

func (c *upgradeClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return c.oldImage, nil
}

func (c *upgradeClient) ImageInspectWithRaw(context.Context, string) (image.InspectResponse, []byte, error) {
	return c.newImage, nil, nil
}

func (c *upgradeClient) ImagePull(_ context.Context, _ string, _ image.PullOptions) (io.ReadCloser, error) {
	if c.pullHook != nil {
		c.pullHook()
	}
	if c.pullError {
		return io.NopCloser(strings.NewReader(`{"errorDetail":{"message":"denied"}}`)), nil
	}
	return io.NopCloser(strings.NewReader(`{"status":"done"}`)), nil
}

func (c *upgradeClient) ContainerStop(_ context.Context, id string, _ container.StopOptions) error {
	c.stopCalls = append(c.stopCalls, id)
	if c.stopError {
		return errors.New("stop failed")
	}
	return nil
}

func (c *upgradeClient) ContainerRemove(_ context.Context, id string, _ container.RemoveOptions) error {
	c.removeCalls = append(c.removeCalls, id)
	if c.removeError || c.removeErrorID == id {
		return errors.New("remove failed")
	}
	return nil
}

func (c *upgradeClient) ContainerCreate(_ context.Context, cfg *container.Config, hostCfg *container.HostConfig, networking *network.NetworkingConfig, _ *ocispec.Platform, name string) (container.CreateResponse, error) {
	if c.createError {
		return container.CreateResponse{}, errors.New("create failed")
	}
	c.createdConfig = cfg
	c.createdHostConfig = hostCfg
	c.createdNetworkConfig = networking
	c.createdName = name
	if c.createHook != nil {
		c.createHook()
	}
	return container.CreateResponse{ID: "new-container"}, nil
}

func (c *upgradeClient) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	c.startCalls = append(c.startCalls, id)
	if c.startError && id == "new-container" {
		return errors.New("start failed")
	}
	return nil
}

func (c *upgradeClient) ContainerRename(_ context.Context, id, name string) error {
	c.renameCalls = append(c.renameCalls, [3]string{id, name, ""})
	if c.renameNewError && id == "new-container" && name == "app" {
		return errors.New("rename failed")
	}
	return nil
}

func TestUpgradeFailureKeepsOrRestoresOriginal(t *testing.T) {
	tests := []struct {
		name         string
		configure    func(*upgradeClient)
		wantErr      bool
		wantStop     int
		wantStarts   int
		wantOldStart int
		wantRemove   int
		wantRenames  int
	}{
		{name: "pull", configure: func(c *upgradeClient) { c.pullError = true }, wantErr: true},
		{name: "create", configure: func(c *upgradeClient) { c.createError = true }, wantErr: true},
		{name: "start", configure: func(c *upgradeClient) { c.startError = true }, wantErr: true, wantStop: 1, wantStarts: 1, wantOldStart: 1, wantRemove: 1},
		{name: "rename", configure: func(c *upgradeClient) { c.renameNewError = true }, wantErr: true, wantStop: 1, wantStarts: 1, wantOldStart: 1, wantRemove: 1, wantRenames: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := newUpgradeClient()
			tt.configure(c)
			_, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v", err)
			}
			if len(c.stopCalls) != tt.wantStop || len(c.startCalls) != tt.wantStarts+tt.wantOldStart || len(c.removeCalls) != tt.wantRemove || len(c.renameCalls) != tt.wantRenames {
				t.Fatalf("stop=%d start=%v remove=%d rename=%d", len(c.stopCalls), c.startCalls, len(c.removeCalls), len(c.renameCalls))
			}
			if c.createdConfig != nil && c.createdConfig.Image != "new" {
				t.Fatalf("replacement image = %q, want pinned ID", c.createdConfig.Image)
			}
		})
	}
}

func TestUpgradeAlreadyStoppedKeepsStoppedState(t *testing.T) {
	c := newUpgradeClient()
	c.info.State.Running = false
	newID, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "new-container" || len(c.stopCalls) != 0 || len(c.startCalls) != 0 || len(c.removeCalls) != 1 || len(c.renameCalls) != 2 {
		t.Fatalf("new=%q stop=%v start=%v remove=%v rename=%v", newID, c.stopCalls, c.startCalls, c.removeCalls, c.renameCalls)
	}
}

func TestUpgradeCancellationBeforeMutation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newUpgradeClient()
	c.pullHook = cancel
	_, err := Upgrade(ctx, c, "old-container", io.Discard, image.PullOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	if len(c.stopCalls) != 0 || c.createdConfig != nil || len(c.removeCalls) != 0 {
		t.Fatalf("cancellation mutated old container: stop=%v create=%v remove=%v", c.stopCalls, c.createdConfig, c.removeCalls)
	}
}

func TestUpgradeCancellationAfterCreateCleansReplacement(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newUpgradeClient()
	c.createHook = cancel
	_, err := Upgrade(ctx, c, "old-container", io.Discard, image.PullOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	if len(c.stopCalls) != 0 || len(c.removeCalls) != 1 || len(c.startCalls) != 1 || c.startCalls[0] != "old-container" {
		t.Fatalf("cancellation after create changed old state: stop=%v remove=%v start=%v", c.stopCalls, c.removeCalls, c.startCalls)
	}
}

func TestUpgradeRejectsUnsafeModesBeforePull(t *testing.T) {
	for _, name := range []string{"auto-remove", "static-ip", "paused", "restarting", "dead", "unknown-state"} {
		t.Run(name, func(t *testing.T) {
			c := newUpgradeClient()
			if name == "auto-remove" {
				c.info.HostConfig.AutoRemove = true
			} else if name == "static-ip" {
				c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
					"app-net": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: "10.0.0.2"}},
				}}
			} else if name == "paused" {
				c.info.State.Paused = true
			} else if name == "restarting" {
				c.info.State.Restarting = true
			} else if name == "dead" {
				c.info.State.Dead = true
			} else {
				c.info.State = nil
			}
			_, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
			if err == nil || c.createdConfig != nil || len(c.stopCalls) != 0 {
				t.Fatalf("unsafe upgrade was mutated: err=%v create=%v stop=%v", err, c.createdConfig, c.stopCalls)
			}
		})
	}
}

func TestDuplicatePreservesNetworkAndAnonymousVolume(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {Aliases: []string{"app"}, EndpointID: "dynamic", IPAddress: "10.0.0.2"},
	}}
	c.info.HostConfig.Mounts = []mount.Mount{{Type: mount.TypeVolume, Target: "/data"}}
	c.info.Mounts = []container.MountPoint{{Type: mount.TypeVolume, Name: "anon-volume", Destination: "/data", RW: true}}
	if _, err := Duplicate(context.Background(), c, "old-container", "copy"); err != nil {
		t.Fatal(err)
	}
	if c.createdNetworkConfig == nil || c.createdNetworkConfig.EndpointsConfig["app-net"].EndpointID != "" || len(c.createdNetworkConfig.EndpointsConfig["app-net"].Aliases) != 1 {
		t.Fatalf("network config not preserved safely: %#v", c.createdNetworkConfig)
	}
	if len(c.createdHostConfig.Mounts) != 1 || c.createdHostConfig.Mounts[0].Source != "anon-volume" {
		t.Fatalf("anonymous volume not reused: %#v", c.createdHostConfig.Mounts)
	}
}

func TestDuplicateRejectsStaticNetworkAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: "10.0.0.2"}},
	}}
	if _, err := Duplicate(context.Background(), c, "old-container", "copy"); err == nil {
		t.Fatal("static network address was silently copied")
	}
	if c.createdConfig != nil {
		t.Fatal("duplicate created a container before rejecting static address")
	}
}

func TestUpgradeAlreadyCurrentDoesNotMutate(t *testing.T) {
	c := newUpgradeClient()
	c.newImage.ID = "old"
	newID, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "" || len(c.stopCalls) != 0 || c.createdConfig != nil {
		t.Fatalf("current image changed container: id=%q stop=%v create=%v", newID, c.stopCalls, c.createdConfig)
	}
}

func TestUpgradeKeepsOriginalImageReferenceForNextPull(t *testing.T) {
	c := newUpgradeClient()
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := UpgradeImageRef(container.InspectResponse{Config: c.createdConfig}); got != "example/app:latest" {
		t.Fatalf("next image reference = %q", got)
	}
	if c.createdConfig.Labels[upgradeImageRefLabel] != "example/app:latest" {
		t.Fatalf("image reference label = %q", c.createdConfig.Labels[upgradeImageRefLabel])
	}
}

func TestUpgradeRemovalFailureRestoresOriginal(t *testing.T) {
	c := newUpgradeClient()
	c.removeErrorID = "old-container"
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err == nil {
		t.Fatal("expected old removal error")
	}
	if len(c.renameCalls) != 4 || c.renameCalls[2][0] != "new-container" || c.renameCalls[2][1] != c.createdName || c.renameCalls[3][0] != "old-container" || c.renameCalls[3][1] != "app" {
		t.Fatalf("rollback renames = %v", c.renameCalls)
	}
	if len(c.startCalls) != 2 || c.startCalls[1] != "old-container" {
		t.Fatalf("old state was not restored: %v", c.startCalls)
	}
}

func TestUpgradePlatformMismatchDoesNotMutate(t *testing.T) {
	c := newUpgradeClient()
	c.newImage.Architecture = "amd64"
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err == nil {
		t.Fatal("expected platform mismatch")
	}
	if len(c.stopCalls) != 0 || c.createdConfig != nil {
		t.Fatal("platform mismatch changed original")
	}
}

func TestUpgradeRejectsConcurrentSameContainer(t *testing.T) {
	c := newUpgradeClient()
	started := make(chan struct{})
	release := make(chan struct{})
	c.pullHook = func() {
		select {
		case <-started:
		default:
			close(started)
		}
		<-release
	}
	firstDone := make(chan error, 1)
	go func() {
		_, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{})
		firstDone <- err
	}()
	<-started
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("second upgrade error = %v", err)
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}
