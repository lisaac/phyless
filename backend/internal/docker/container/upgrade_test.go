package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"

	dockerspec "github.com/moby/docker-image-spec/specs-go/v1"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
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
	pullCalls            int
	createHook           func()
	networks             map[string]network.Inspect
	apiVersion           string
	listed               []container.Summary
	others               map[string]container.InspectResponse
	newState             *container.State
	created              int
	tagMoved             bool // the tag moves back to the old image after the post-pull check
	tagLookups           int
	createdImages        map[string]string
	createdHostConfigs   []*container.HostConfig
	restartCalls         []string
}

func (c *upgradeClient) ContainerRestart(_ context.Context, id string, _ client.ContainerRestartOptions) (client.ContainerRestartResult, error) {
	c.restartCalls = append(c.restartCalls, id)
	return client.ContainerRestartResult{}, nil
}

// pullBody is a progress stream; Upgrade only reads it.
type pullBody struct {
	client.ImagePullResponse
	r io.Reader
}

func (b pullBody) Read(p []byte) (int, error) { return b.r.Read(p) }
func (pullBody) Close() error                 { return nil }

func mac(s string) network.HardwareAddr {
	m, err := net.ParseMAC(s)
	if err != nil {
		panic(err)
	}
	return network.HardwareAddr(m)
}

func init() { upgradeSettleTime = 0 }

func newUpgradeClient() *upgradeClient {
	return &upgradeClient{
		info: container.InspectResponse{
			ID:         "old-container",
			Image:      "old",
			Name:       "/app",
			State:      &container.State{Running: true},
			HostConfig: &container.HostConfig{},
			Config:     &container.Config{Image: "example/app:latest"},
		},
		oldImage: image.InspectResponse{ID: "old", Os: "linux", Architecture: "arm64"},
		newImage: image.InspectResponse{ID: "new", Os: "linux", Architecture: "arm64"},
		networks: make(map[string]network.Inspect),
	}
}

func (c *upgradeClient) ContainerInspect(_ context.Context, id string, _ client.ContainerInspectOptions) (client.ContainerInspectResult, error) {
	if strings.HasPrefix(id, "new-container") {
		state := c.newState
		if state == nil {
			state = &container.State{Running: true}
		}
		return client.ContainerInspectResult{Container: container.InspectResponse{ID: id, Image: c.createdImages[id], State: state}}, nil
	}
	if other, ok := c.others[id]; ok {
		return client.ContainerInspectResult{Container: other}, nil
	}
	return client.ContainerInspectResult{Container: c.info}, nil
}

// The container's own image ID resolves to the old image; any tag resolves to
// the freshly pulled one.
func (c *upgradeClient) ImageInspect(_ context.Context, ref string, _ ...client.ImageInspectOption) (client.ImageInspectResult, error) {
	if ref == "example/app:latest" {
		c.tagLookups++
	}
	if ref == c.oldImage.ID || (c.tagMoved && ref == "example/app:latest" && c.tagLookups > 1) {
		return client.ImageInspectResult{InspectResponse: c.oldImage}, nil
	}
	return client.ImageInspectResult{InspectResponse: c.newImage}, nil
}

func (c *upgradeClient) ClientVersion() string {
	if c.apiVersion == "" {
		return "1.47"
	}
	return c.apiVersion
}

func (c *upgradeClient) ContainerList(context.Context, client.ContainerListOptions) (client.ContainerListResult, error) {
	return client.ContainerListResult{Items: c.listed}, nil
}

func (c *upgradeClient) ContainerLogs(context.Context, string, client.ContainerLogsOptions) (client.ContainerLogsResult, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func (c *upgradeClient) ImagePull(_ context.Context, _ string, _ client.ImagePullOptions) (client.ImagePullResponse, error) {
	c.pullCalls++
	if c.pullHook != nil {
		c.pullHook()
	}
	if c.pullError {
		return pullBody{r: strings.NewReader(`{"errorDetail":{"message":"denied"}}`)}, nil
	}
	return pullBody{r: strings.NewReader(`{"status":"done"}`)}, nil
}

func (c *upgradeClient) ContainerStop(_ context.Context, id string, _ client.ContainerStopOptions) (client.ContainerStopResult, error) {
	c.stopCalls = append(c.stopCalls, id)
	if c.stopError {
		return client.ContainerStopResult{}, errors.New("stop failed")
	}
	return client.ContainerStopResult{}, nil
}

func (c *upgradeClient) ContainerRemove(_ context.Context, id string, _ client.ContainerRemoveOptions) (client.ContainerRemoveResult, error) {
	c.removeCalls = append(c.removeCalls, id)
	if c.removeError || c.removeErrorID == id {
		return client.ContainerRemoveResult{}, errors.New("remove failed")
	}
	return client.ContainerRemoveResult{}, nil
}

func (c *upgradeClient) ContainerCreate(_ context.Context, o client.ContainerCreateOptions) (client.ContainerCreateResult, error) {
	cfg, hostCfg, networking, name := o.Config, o.HostConfig, o.NetworkingConfig, o.Name
	if c.createError {
		return client.ContainerCreateResult{}, errors.New("create failed")
	}
	c.createdConfig = cfg
	c.createdHostConfig = hostCfg
	c.createdNetworkConfig = networking
	c.createdName = name
	c.createdHostConfigs = append(c.createdHostConfigs, hostCfg)
	if c.createHook != nil {
		c.createHook()
	}
	c.created++
	id := "new-container"
	if c.created > 1 {
		id = fmt.Sprintf("new-container-%d", c.created)
	}
	img, _ := c.ImageInspect(context.Background(), cfg.Image)
	if cfg.Image == c.oldImage.ID || strings.HasPrefix(cfg.Image, "sha256:") || cfg.Image == c.newImage.ID {
		img.ID = cfg.Image
	}
	if c.createdImages == nil {
		c.createdImages = map[string]string{}
	}
	c.createdImages[id] = img.ID
	return client.ContainerCreateResult{ID: id}, nil
}

func (c *upgradeClient) ContainerStart(_ context.Context, id string, _ client.ContainerStartOptions) (client.ContainerStartResult, error) {
	c.startCalls = append(c.startCalls, id)
	if c.startError && id == "new-container" {
		return client.ContainerStartResult{}, errors.New("start failed")
	}
	return client.ContainerStartResult{}, nil
}

func (c *upgradeClient) NetworkInspect(_ context.Context, name string, _ client.NetworkInspectOptions) (client.NetworkInspectResult, error) {
	if info, ok := c.networks[name]; ok {
		return client.NetworkInspectResult{Network: info}, nil
	}
	return client.NetworkInspectResult{}, errors.New("network not found")
}

func (c *upgradeClient) NetworkDisconnect(_ context.Context, name string, _ client.NetworkDisconnectOptions) (client.NetworkDisconnectResult, error) {
	c.networkDisconnects = append(c.networkDisconnects, name)
	return client.NetworkDisconnectResult{}, nil
}

func (c *upgradeClient) NetworkConnect(_ context.Context, name string, o client.NetworkConnectOptions) (client.NetworkConnectResult, error) {
	endpoint := o.EndpointConfig
	c.networkConnects = append(c.networkConnects, name)
	if name == "macvlan-net" && (endpoint == nil || endpoint.IPAMConfig == nil || endpoint.IPAMConfig.IPv4Address != netip.MustParseAddr("10.0.0.2")) {
		return client.NetworkConnectResult{}, errors.New("unexpected endpoint config")
	}
	return client.NetworkConnectResult{}, nil
}

func (c *upgradeClient) ContainerRename(_ context.Context, id string, o client.ContainerRenameOptions) (client.ContainerRenameResult, error) {
	name := o.NewName
	c.renameCalls = append(c.renameCalls, [3]string{id, name, ""})
	if c.renameNewError && id == "new-container" && name == "app" {
		return client.ContainerRenameResult{}, errors.New("rename failed")
	}
	return client.ContainerRenameResult{}, nil
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
			_, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v", err)
			}
			if len(c.stopCalls) != tt.wantStop || len(c.startCalls) != tt.wantStarts+tt.wantOldStart || len(c.removeCalls) != tt.wantRemove || len(c.renameCalls) != tt.wantRenames {
				t.Fatalf("stop=%d start=%v remove=%d rename=%d", len(c.stopCalls), c.startCalls, len(c.removeCalls), len(c.renameCalls))
			}
			if c.createdConfig != nil && c.createdConfig.Image != "example/app:latest" {
				t.Fatalf("replacement image = %q, want original tag", c.createdConfig.Image)
			}
		})
	}
}

func TestUpgradeAlreadyStoppedKeepsStoppedState(t *testing.T) {
	c := newUpgradeClient()
	c.info.State.Running = false
	newID, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "new-container" || len(c.stopCalls) != 0 || len(c.startCalls) != 0 || len(c.removeCalls) != 1 || len(c.renameCalls) != 2 {
		t.Fatalf("new=%q stop=%v start=%v remove=%v rename=%v", newID, c.stopCalls, c.startCalls, c.removeCalls, c.renameCalls)
	}
}

func TestUpgradeWithoutPullUsesLoadedImage(t *testing.T) {
	c := newUpgradeClient()
	newID, err := UpgradeWithoutPull(context.Background(), c, "old-container", io.Discard, UpgradeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "new-container" || c.createdConfig == nil || c.createdConfig.Image != "example/app:latest" {
		t.Fatalf("new=%q config=%#v", newID, c.createdConfig)
	}
	if c.pullCalls != 0 {
		t.Fatalf("ImagePull calls = %d, want 0", c.pullCalls)
	}
}

func TestUpgradeCancellationBeforeMutation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := newUpgradeClient()
	c.pullHook = cancel
	_, err := Upgrade(ctx, c, "old-container", io.Discard, "", UpgradeOptions{})
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
		"macvlan-net": {IPAddress: netip.MustParseAddr("10.0.0.2")},
	}}
	c.networks["macvlan-net"] = network.Inspect{Network: network.Network{Driver: "macvlan"}}
	c.createHook = cancel
	_, err := Upgrade(ctx, c, "old-container", io.Discard, "", UpgradeOptions{})
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
					"bridge": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: netip.MustParseAddr("10.0.0.2")}},
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
			_, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
			if err == nil || c.createdConfig != nil || len(c.stopCalls) != 0 {
				t.Fatalf("unsafe upgrade was mutated: err=%v create=%v stop=%v", err, c.createdConfig, c.stopCalls)
			}
		})
	}
}

func TestDuplicatePreservesNetworkAndAnonymousVolume(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {Aliases: []string{"app"}, EndpointID: "dynamic", IPAddress: netip.MustParseAddr("10.0.0.2")},
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
		HostConfig: &container.HostConfig{Binds: []string{"/data"}},
		Mounts:     []container.MountPoint{{Type: mount.TypeVolume, Name: "anon-volume", Destination: "/data", RW: true}},
	}
	hostCfg := cloneHostConfig(info)
	if len(hostCfg.Binds) != 0 || len(hostCfg.Mounts) != 1 || hostCfg.Mounts[0].Source != "anon-volume" || hostCfg.Mounts[0].Target != "/data" || len(info.HostConfig.Binds) != 1 || info.HostConfig.Binds[0] != "/data" {
		t.Fatalf("anonymous volume bind = %#v", hostCfg)
	}
}

func TestDuplicateRejectsStaticNetworkAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: netip.MustParseAddr("10.0.0.2")}},
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
		"macvlan-net": {IPAddress: netip.MustParseAddr("10.0.0.2")},
	}}
	c.networks["macvlan-net"] = network.Inspect{Network: network.Network{Driver: "macvlan"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	ep := c.createdNetworkConfig.EndpointsConfig["macvlan-net"]
	if ep == nil || ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address != netip.MustParseAddr("10.0.0.2") {
		t.Fatalf("macvlan address = %#v", ep)
	}
}

func TestUpgradePreservesMacvlanMixedIPFamilies(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {
			IPAMConfig:        &network.EndpointIPAMConfig{IPv4Address: netip.MustParseAddr("10.0.0.2")},
			IPAddress:         netip.MustParseAddr("10.0.0.2"),
			GlobalIPv6Address: netip.MustParseAddr("2001:db8::2"),
		},
	}}
	c.networks["macvlan-net"] = network.Inspect{Network: network.Network{Driver: "macvlan"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	ipam := c.createdNetworkConfig.EndpointsConfig["macvlan-net"].IPAMConfig
	if ipam == nil || ipam.IPv4Address != netip.MustParseAddr("10.0.0.2") || ipam.IPv6Address != netip.MustParseAddr("2001:db8::2") {
		t.Fatalf("mixed macvlan addresses = %#v", ipam)
	}
}

func TestUpgradeDoesNotPinDynamicBridgeAddress(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAddress: netip.MustParseAddr("10.0.0.2")},
	}}
	c.networks["app-net"] = network.Inspect{Network: network.Network{Driver: "bridge"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if ep := c.createdNetworkConfig.EndpointsConfig["app-net"]; ep == nil || ep.IPAMConfig != nil {
		t.Fatalf("dynamic bridge address was pinned: %#v", ep)
	}
}

func TestUpgradePreservesStaticUserDefinedAddress(t *testing.T) {
	c := newUpgradeClient()
	c.networks["app-net"] = network.Inspect{Network: network.Network{Driver: "bridge"}}
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"app-net": {IPAMConfig: &network.EndpointIPAMConfig{IPv4Address: netip.MustParseAddr("10.0.0.2")}},
	}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	ep := c.createdNetworkConfig.EndpointsConfig["app-net"]
	if ep == nil || ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address != netip.MustParseAddr("10.0.0.2") {
		t.Fatalf("static address = %#v", ep)
	}
}

func TestUpgradeRestoresMacvlanAddressOnStartFailure(t *testing.T) {
	c := newUpgradeClient()
	c.startError = true
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {IPAddress: netip.MustParseAddr("10.0.0.2")},
	}}
	c.networks["macvlan-net"] = network.Inspect{Network: network.Network{Driver: "macvlan"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil {
		t.Fatal("expected replacement start failure")
	}
	if len(c.networkDisconnects) != 1 || len(c.networkConnects) != 1 {
		t.Fatalf("network restore calls = disconnect=%v connect=%v", c.networkDisconnects, c.networkConnects)
	}
}

func TestUpgradeContainerNetworkModeClearsConflictingOptions(t *testing.T) {
	c := newUpgradeClient()
	c.info.Config.Hostname = "pod19-host"
	c.info.Config.ExposedPorts = network.PortSet{network.MustParsePort("80/tcp"): {}}
	c.info.HostConfig.NetworkMode = container.NetworkMode("container:pod19")
	c.info.HostConfig.DNS = []netip.Addr{netip.MustParseAddr("1.1.1.1")}
	c.info.HostConfig.DNSSearch = []string{"example.com"}
	c.info.HostConfig.DNSOptions = []string{"ndots:1"}
	c.info.HostConfig.Links = []string{"db:db"}
	c.info.HostConfig.ExtraHosts = []string{"host:127.0.0.1"}
	c.info.HostConfig.PortBindings = network.PortMap{network.MustParsePort("80/tcp"): {{HostPort: "8080"}}}
	c.info.HostConfig.PublishAllPorts = true
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.createdConfig.Hostname != "" || len(c.createdConfig.ExposedPorts) != 0 {
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
	newID, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if newID != "" || len(c.stopCalls) != 0 || c.createdConfig != nil {
		t.Fatalf("current image changed container: id=%q stop=%v create=%v", newID, c.stopCalls, c.createdConfig)
	}
}

func TestUpgradeKeepsOriginalImageReferenceForNextPull(t *testing.T) {
	c := newUpgradeClient()
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := UpgradeImageRef(container.InspectResponse{Config: c.createdConfig}); got != "example/app:latest" {
		t.Fatalf("next image reference = %q", got)
	}
	if _, ok := c.createdConfig.Labels[upgradeImageRefLabel]; ok {
		t.Fatalf("tag still resolves to the new image; no pin label expected: %v", c.createdConfig.Labels)
	}
}

func TestUpgradePinsImageWhenTagMoved(t *testing.T) {
	c := newUpgradeClient()
	// The tag keeps resolving to the old image (e.g. retagged in between): the
	// replacement must still run the verified image, so pin it by ID.
	c.tagMoved = true
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.createdConfig.Image != "new" || c.createdConfig.Labels[upgradeImageRefLabel] != "example/app:latest" {
		t.Fatalf("image=%q labels=%v", c.createdConfig.Image, c.createdConfig.Labels)
	}
}

func TestUpgradeDropsOldImageDefaults(t *testing.T) {
	c := newUpgradeClient()
	c.info.ID = "0123456789abcdef"
	c.oldImage.Config = &dockerspec.DockerOCIImageConfig{ImageConfig: ocispec.ImageConfig{
		Env:          []string{"PATH=/usr/bin", "APP_VERSION=1.0"},
		Entrypoint:   []string{"/entry"},
		Cmd:          []string{"serve"},
		WorkingDir:   "/app",
		User:         "app",
		Labels:       map[string]string{"org.opencontainers.image.version": "1.0", "shared": "image"},
		Volumes:      map[string]struct{}{"/data": {}},
		ExposedPorts: map[string]struct{}{"80/tcp": {}},
	}}
	c.info.Config = &container.Config{
		Image:        "example/app:latest",
		Hostname:     "0123456789ab",
		Env:          []string{"PATH=/usr/bin", "APP_VERSION=1.0", "TZ=Asia/Shanghai"},
		Entrypoint:   []string{"/entry"},
		Cmd:          []string{"serve"},
		WorkingDir:   "/app",
		User:         "1000",
		Labels:       map[string]string{"org.opencontainers.image.version": "1.0", "shared": "mine", "com.docker.compose.project": "p"},
		Volumes:      map[string]struct{}{"/data": {}},
		ExposedPorts: network.PortSet{network.MustParsePort("80/tcp"): {}},
	}
	c.info.HostConfig.PortBindings = network.PortMap{network.MustParsePort("8080/tcp"): {{HostPort: "8080"}}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	got := c.createdConfig
	if strings.Join(got.Env, ",") != "TZ=Asia/Shanghai" {
		t.Errorf("env = %v", got.Env)
	}
	if got.Entrypoint != nil || got.Cmd != nil || got.WorkingDir != "" || got.Hostname != "" {
		t.Errorf("image defaults kept: entry=%v cmd=%v wd=%q host=%q", got.Entrypoint, got.Cmd, got.WorkingDir, got.Hostname)
	}
	if got.User != "1000" {
		t.Errorf("explicit user lost: %q", got.User)
	}
	if _, ok := got.Labels["org.opencontainers.image.version"]; ok || got.Labels["shared"] != "mine" || got.Labels["com.docker.compose.project"] != "p" {
		t.Errorf("labels = %v", got.Labels)
	}
	if len(got.Volumes) != 0 {
		t.Errorf("volumes = %v", got.Volumes)
	}
	if _, ok := got.ExposedPorts[network.MustParsePort("80/tcp")]; ok {
		t.Errorf("image-exposed port kept: %v", got.ExposedPorts)
	}
	if _, ok := got.ExposedPorts[network.MustParsePort("8080/tcp")]; !ok {
		t.Errorf("published port not exposed: %v", got.ExposedPorts)
	}
}

func TestUpgradeKeepsCustomCmdWithImageEntrypoint(t *testing.T) {
	c := newUpgradeClient()
	c.oldImage.Config = &dockerspec.DockerOCIImageConfig{ImageConfig: ocispec.ImageConfig{Entrypoint: []string{"/entry"}, Cmd: []string{"serve"}}}
	c.info.Config.Entrypoint = []string{"/entry"}
	c.info.Config.Cmd = []string{"worker", "--fast"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.createdConfig.Entrypoint != nil || strings.Join(c.createdConfig.Cmd, " ") != "worker --fast" {
		t.Fatalf("entry=%v cmd=%v", c.createdConfig.Entrypoint, c.createdConfig.Cmd)
	}
}

func TestUpgradeRollsBackCrashingReplacement(t *testing.T) {
	c := newUpgradeClient()
	c.newState = &container.State{Running: false, ExitCode: 1}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil {
		t.Fatal("expected crash rollback")
	}
	// replacement removed, original restarted, no name switch.
	if len(c.renameCalls) != 0 || len(c.removeCalls) != 1 || c.removeCalls[0] != "new-container" || c.startCalls[len(c.startCalls)-1] != "old-container" {
		t.Fatalf("rename=%v remove=%v start=%v", c.renameCalls, c.removeCalls, c.startCalls)
	}
}

func TestUpgradeOldDaemonConnectsExtraNetworksBeforeStart(t *testing.T) {
	c := newUpgradeClient()
	c.apiVersion = "1.43"
	c.info.HostConfig.NetworkMode = "front"
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"front": {Aliases: []string{"web", "old-containe"}},
		"back":  {},
	}}
	c.networks["front"] = network.Inspect{Network: network.Network{Driver: "bridge"}}
	c.networks["back"] = network.Inspect{Network: network.Network{Driver: "bridge"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(c.createdNetworkConfig.EndpointsConfig) != 1 || c.createdNetworkConfig.EndpointsConfig["front"] == nil {
		t.Fatalf("create endpoints = %v", c.createdNetworkConfig.EndpointsConfig)
	}
	if strings.Join(c.networkConnects, ",") != "back" {
		t.Fatalf("connects = %v", c.networkConnects)
	}
	if a := c.createdNetworkConfig.EndpointsConfig["front"].Aliases; strings.Join(a, ",") != "web" {
		t.Fatalf("old short-ID alias kept: %v", a)
	}
}

func TestUpgradeKeepsMacvlanMAC(t *testing.T) {
	c := newUpgradeClient()
	c.info.NetworkSettings = &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
		"macvlan-net": {IPAddress: netip.MustParseAddr("10.0.0.2"), MacAddress: mac("02:00:00:00:00:02")},
	}}
	c.networks["macvlan-net"] = network.Inspect{Network: network.Network{Driver: "macvlan"}}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := c.createdNetworkConfig.EndpointsConfig["macvlan-net"].MacAddress; got.String() != "02:00:00:00:00:02" {
		t.Fatalf("mac = %q", got)
	}
}

func TestUpgradeRecreatesNetworkDependents(t *testing.T) {
	c := newUpgradeClient()
	c.listed = []container.Summary{{ID: "dep", HostConfig: struct {
		NetworkMode string            `json:",omitempty"`
		Annotations map[string]string `json:",omitempty"`
	}{NetworkMode: "container:old-container"}}}
	c.others = map[string]container.InspectResponse{"dep": {
		ID: "dep", Image: "old", Name: "/qbit", State: &container.State{Running: true},
		HostConfig: &container.HostConfig{NetworkMode: "container:old-container"},
		Config:     &container.Config{Image: "old"},
	}}
	newID, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.createdHostConfigs) != 2 || c.createdHostConfigs[1].NetworkMode != container.NetworkMode("container:"+newID) {
		t.Fatalf("dependent not re-pointed: %d creates", len(c.createdHostConfigs))
	}
}

func TestUpgradeRemovalFailureKeepsSwitchedContainer(t *testing.T) {
	c := newUpgradeClient()
	c.removeErrorID = "old-container"
	var progress bytes.Buffer
	newID, err := Upgrade(context.Background(), c, "old-container", &progress, "", UpgradeOptions{})
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
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil {
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
		_, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{})
		firstDone <- err
	}()
	<-started
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("second upgrade error = %v", err)
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
}

func withDependent(c *upgradeClient, running bool) {
	c.listed = []container.Summary{{ID: "dep", HostConfig: struct {
		NetworkMode string            `json:",omitempty"`
		Annotations map[string]string `json:",omitempty"`
	}{NetworkMode: "container:old-container"}}}
	c.others = map[string]container.InspectResponse{"dep": {
		ID: "dep", Image: "old", Name: "/qbit", State: &container.State{Running: running},
		HostConfig: &container.HostConfig{NetworkMode: "container:old-container"},
		Config:     &container.Config{Image: "old"},
	}}
}

func TestUpgradeRollbackRestartsDependents(t *testing.T) {
	c := newUpgradeClient()
	withDependent(c, true)
	c.startError = true
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil {
		t.Fatal("expected failure")
	}
	if strings.Join(c.restartCalls, ",") != "dep" {
		t.Fatalf("dependent not reattached after rollback: %v", c.restartCalls)
	}
}

func TestUpgradeRejectsWhenDependentBusy(t *testing.T) {
	c := newUpgradeClient()
	withDependent(c, true)
	release, _ := tryUpgradeOperation("dep")
	defer release()
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err == nil || !strings.Contains(err.Error(), "qbit") {
		t.Fatalf("err = %v", err)
	}
	if c.created != 0 {
		t.Fatal("mutated despite busy dependent")
	}
}

func TestUpgradeStoppedMainRecreatesDependentStopped(t *testing.T) {
	c := newUpgradeClient()
	c.info.State.Running = false
	withDependent(c, true)
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	if c.created != 2 || len(c.startCalls) != 0 {
		t.Fatalf("created=%d starts=%v", c.created, c.startCalls)
	}
}

func TestRestoreConfigKeepsEntrypointThatDroppedImageCmd(t *testing.T) {
	info := container.InspectResponse{
		ID:     "0123456789abcdef",
		Config: &container.Config{Entrypoint: []string{"/entry"}},
	}
	img := image.InspectResponse{Config: &dockerspec.DockerOCIImageConfig{ImageConfig: ocispec.ImageConfig{Entrypoint: []string{"/entry"}, Cmd: []string{"serve"}}}}
	if cfg := restoreConfig(info, img); len(cfg.Entrypoint) != 1 || cfg.Cmd != nil {
		t.Fatalf("entry=%v cmd=%v", cfg.Entrypoint, cfg.Cmd)
	}
}

func TestRestoreConfigClearsLegacyPredecessorHostname(t *testing.T) {
	info := container.InspectResponse{
		ID:     "ffffffffffff0000",
		Config: &container.Config{Hostname: "0123456789ab", Labels: map[string]string{upgradeImageRefLabel: "app:1"}},
	}
	if cfg := restoreConfig(info, image.InspectResponse{}); cfg.Hostname != "" {
		t.Fatalf("hostname = %q", cfg.Hostname)
	}
	info.Config.Labels = nil
	if cfg := restoreConfig(info, image.InspectResponse{}); cfg.Hostname != "0123456789ab" {
		t.Fatalf("user hostname dropped: %q", cfg.Hostname)
	}
}

func TestUpgradeEnvFromImageDropsChosenValues(t *testing.T) {
	c := newUpgradeClient()
	c.info.Config.Env = []string{"NGINX_VERSION=1.25", "TZ=Asia/Shanghai"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{EnvFromImage: []string{"NGINX_VERSION"}}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(c.createdConfig.Env, ",") != "TZ=Asia/Shanghai" {
		t.Fatalf("env = %v", c.createdConfig.Env)
	}
}

func TestUpgradeEnvFromImageRecreatesEvenWhenCurrent(t *testing.T) {
	c := newUpgradeClient()
	c.newImage.ID = c.info.Image // already on the latest image
	c.info.Config.Env = []string{"NGINX_VERSION=1.25"}
	if _, err := Upgrade(context.Background(), c, "old-container", io.Discard, "", UpgradeOptions{EnvFromImage: []string{"NGINX_VERSION"}}); err != nil {
		t.Fatal(err)
	}
	if c.created != 1 || len(c.createdConfig.Env) != 0 {
		t.Fatalf("created=%d env=%v", c.created, c.createdConfig.Env)
	}
	c2 := newUpgradeClient()
	c2.newImage.ID = c2.info.Image
	if _, err := Upgrade(context.Background(), c2, "old-container", io.Discard, "", UpgradeOptions{EnvFromImage: []string{"ABSENT"}}); err != nil || c2.created != 0 {
		t.Fatalf("no-op env choice must not recreate: err=%v created=%d", err, c2.created)
	}
}
