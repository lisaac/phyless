package container

import (
	"bytes"
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
	"github.com/docker/go-connections/nat"
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
	networkDisconnects   []string
	networkConnects      []string
	renameCalls          [][3]string
	createdConfig        *container.Config
	createdHostConfig    *container.HostConfig
	createdNetworkConfig *network.NetworkingConfig
	createdName          string
	pullHook             func()
	createHook           func()
	networks             map[string]network.Inspect
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
		networks: make(map[string]network.Inspect),
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

func (c *upgradeClient) NetworkInspect(_ context.Context, name string, _ network.InspectOptions) (network.Inspect, error) {
	if info, ok := c.networks[name]; ok {
		return info, nil
	}
	return network.Inspect{}, errors.New("network not found")
}

func (c *upgradeClient) NetworkDisconnect(_ context.Context, name, _ string, _ bool) error {
	c.networkDisconnects = append(c.networkDisconnects, name)
	return nil
}

func (c *upgradeClient) NetworkConnect(_ context.Context, name, _ string, endpoint *network.EndpointSettings) error {
	c.networkConnects = append(c.networkConnects, name)
	if endpoint == nil || endpoint.IPAMConfig == nil || endpoint.IPAMConfig.IPv4Address != "10.0.0.2" {
		return errors.New("unexpected endpoint config")
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
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {IPAddress: "10.0.0.2"},
	}}
	c.networks["macvlan-net"] = network.Inspect{Driver: "macvlan"}
	c.createHook = cancel
	_, err := Upgrade(ctx, c, "old-container", io.Discard, image.PullOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation", err)
	}
	if len(c.stopCalls) != 0 || len(c.removeCalls) != 1 || len(c.startCalls) != 1 || c.startCalls[0] != "old-container" {
		t.Fatalf("cancellation after create changed old state: stop=%v remove=%v start=%v", c.stopCalls, c.removeCalls, c.startCalls)
	}
	if len(c.networkDisconnects) != 0 || len(c.networkConnects) != 0 {
		t.Fatalf("cancellation after create changed old network: disconnect=%v connect=%v", c.networkDisconnects, c.networkConnects)
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
					"bridge": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: "10.0.0.2"}},
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

func TestCloneHostConfigReusesAnonymousVolumeBind(t *testing.T) {
	info := container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{HostConfig: &container.HostConfig{Binds: []string{"/data"}}},
		Mounts:            []container.MountPoint{{Type: mount.TypeVolume, Name: "anon-volume", Destination: "/data", RW: true}},
	}
	hostCfg := cloneHostConfig(info)
	if len(hostCfg.Binds) != 0 || len(hostCfg.Mounts) != 1 || hostCfg.Mounts[0].Source != "anon-volume" || hostCfg.Mounts[0].Target != "/data" || len(info.HostConfig.Binds) != 1 || info.HostConfig.Binds[0] != "/data" {
		t.Fatalf("anonymous volume bind = %#v", hostCfg)
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

func TestUpgradePreservesMacvlanAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {IPAddress: "10.0.0.2"},
	}}
	c.networks["macvlan-net"] = network.Inspect{Driver: "macvlan"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	ep := c.createdNetworkConfig.EndpointsConfig["macvlan-net"]
	if ep == nil || ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address != "10.0.0.2" {
		t.Fatalf("macvlan address = %#v", ep)
	}
}

func TestUpgradePreservesMacvlanMixedIPFamilies(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {
			IPAMConfig:        &network.EndpointIPAMConfig{IPv4Address: "10.0.0.2"},
			IPAddress:         "10.0.0.2",
			GlobalIPv6Address: "2001:db8::2",
		},
	}}
	c.networks["macvlan-net"] = network.Inspect{Driver: "macvlan"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	ipam := c.createdNetworkConfig.EndpointsConfig["macvlan-net"].IPAMConfig
	if ipam == nil || ipam.IPv4Address != "10.0.0.2" || ipam.IPv6Address != "2001:db8::2" {
		t.Fatalf("mixed macvlan addresses = %#v", ipam)
	}
}

func TestUpgradeDoesNotPinDynamicBridgeAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAddress: "10.0.0.2"},
	}}
	c.networks["app-net"] = network.Inspect{Driver: "bridge"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	if ep := c.createdNetworkConfig.EndpointsConfig["app-net"]; ep == nil || ep.IPAMConfig != nil {
		t.Fatalf("dynamic bridge address was pinned: %#v", ep)
	}
}

func TestUpgradePreservesStaticUserDefinedAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: "10.0.0.2"}},
	}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	ep := c.createdNetworkConfig.EndpointsConfig["app-net"]
	if ep == nil || ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address != "10.0.0.2" {
		t.Fatalf("static address = %#v", ep)
	}
}

func TestUpgradeRestoresMacvlanAddressOnStartFailure(t *testing.T) {
	c := newUpgradeClient()
	c.startError = true
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {IPAddress: "10.0.0.2"},
	}}
	c.networks["macvlan-net"] = network.Inspect{Driver: "macvlan"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err == nil {
		t.Fatal("expected replacement start failure")
	}
	if len(c.networkDisconnects) != 1 || len(c.networkConnects) != 1 {
		t.Fatalf("network restore calls = disconnect=%v connect=%v", c.networkDisconnects, c.networkConnects)
	}
}

func TestUpgradeContainerNetworkModeClearsConflictingOptions(t *testing.T) {
	c := newUpgradeClient()
	c.info.Config.Hostname = "pod19-host"
	c.info.Config.ExposedPorts = nat.PortSet{"80/tcp": {}}
	c.info.Config.MacAddress = "02:42:ac:11:00:02"
	c.info.HostConfig.NetworkMode = container.NetworkMode("container:pod19")
	c.info.HostConfig.DNS = []string{"1.1.1.1"}
	c.info.HostConfig.DNSSearch = []string{"example.com"}
	c.info.HostConfig.DNSOptions = []string{"ndots:1"}
	c.info.HostConfig.Links = []string{"db:db"}
	c.info.HostConfig.ExtraHosts = []string{"host:127.0.0.1"}
	c.info.HostConfig.PortBindings = nat.PortMap{"80/tcp": {{HostPort: "8080"}}}
	c.info.HostConfig.PublishAllPorts = true
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, image.PullOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.createdConfig.Hostname != "" || len(c.createdConfig.ExposedPorts) != 0 || c.createdConfig.MacAddress != "" {
		t.Fatalf("container config conflicts remain: %#v", c.createdConfig)
	}
	if c.createdHostConfig.NetworkMode != container.NetworkMode("container:pod19") || len(c.createdHostConfig.DNS) != 0 || len(c.createdHostConfig.DNSSearch) != 0 || len(c.createdHostConfig.DNSOptions) != 0 || len(c.createdHostConfig.Links) != 0 || len(c.createdHostConfig.ExtraHosts) != 0 || len(c.createdHostConfig.PortBindings) != 0 || c.createdHostConfig.PublishAllPorts {
		t.Fatalf("host config conflicts remain: %#v", c.createdHostConfig)
	}
	if c.createdNetworkConfig != nil {
		t.Fatalf("container network mode should not have endpoint config: %#v", c.createdNetworkConfig)
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

func TestUpgradeRemovalFailureKeepsSwitchedContainer(t *testing.T) {
	c := newUpgradeClient()
	c.removeErrorID = "old-container"
	var progress bytes.Buffer
	newID, err := Upgrade(context.Background(), c, "old-container", &progress, image.PullOptions{})
	if err != nil || newID != "new-container" {
		t.Fatalf("upgrade = %q, %v", newID, err)
	}
	if len(c.renameCalls) != 2 || c.renameCalls[0][0] != "old-container" || c.renameCalls[1][0] != "new-container" {
		t.Fatalf("switch renames = %v", c.renameCalls)
	}
	if len(c.startCalls) != 1 || c.startCalls[0] != "new-container" {
		t.Fatalf("replacement was not kept running: %v", c.startCalls)
	}
	if len(c.removeCalls) != 1 || c.removeCalls[0] != "old-container" {
		t.Fatalf("replacement was removed after old cleanup failure: %v", c.removeCalls)
	}
	if !strings.Contains(progress.String(), "旧容器清理失败") || !strings.Contains(progress.String(), "升级完成") {
		t.Fatalf("progress did not report successful switch and cleanup warning: %s", progress.String())
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
