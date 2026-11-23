package docker

// The SDK boundary for api/ws. Those packages import only this package, never
// github.com/moby/moby or containerd/errdefs, so an SDK upgrade (import paths,
// Options/Result signatures, filter types) is absorbed here and in the
// docker/* subpackages.
//
// Data types that api/ws forward to the browser as Docker JSON stay the SDK's
// own (aliases below): the frontend reads Docker's wire schema, and copying it
// field by field would only duplicate that schema.

import (
	"context"
	"io"
	"net/netip"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/containerd/platforms"
	"github.com/docker/go-connections/nat"
	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/registry"
	"github.com/moby/moby/api/types/system"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

type (
	ContainerSummary    = container.Summary
	ContainerInspect    = container.InspectResponse
	ContainerConfig     = container.Config
	HostConfig          = container.HostConfig
	UpdateConfig        = container.UpdateConfig
	MountPoint          = container.MountPoint
	PortSummary         = container.PortSummary
	RestartPolicy       = container.RestartPolicy
	RestartPolicyMode   = container.RestartPolicyMode
	NetworkMode         = container.NetworkMode
	HealthConfig        = container.HealthConfig
	DeviceMapping       = container.DeviceMapping
	LogConfig           = container.LogConfig
	ImageSummary        = image.Summary
	ImageInspect        = image.InspectResponse
	ImageHistoryItem    = image.HistoryResponseItem
	ImagePruneReport    = image.PruneReport
	NetworkSummary      = network.Summary
	NetworkInspect      = network.Inspect
	NetworkIPAM         = network.IPAM
	PortSet             = network.PortSet
	PortMap             = network.PortMap
	Volume              = volume.Volume
	SystemInfo          = system.Info
	ServerVersion       = client.ServerVersionResult
	AuthConfig          = registry.AuthConfig
	DistributionInspect = registry.DistributionInspect
	Event               = events.Message
	Platform            = ocispec.Platform
	HijackedResponse    = client.HijackedResponse
)

const MountTypeVolume = mount.TypeVolume

var (
	IsNotFound    = cerrdefs.IsNotFound
	IsNotModified = cerrdefs.IsNotModified
	IsConflict    = cerrdefs.IsConflict
	EncodeAuth    = authconfig.Encode
	DecodeAuth    = authconfig.Decode
	DemuxLogs     = stdcopy.StdCopy
	ParsePlatform = platforms.Parse // "os/arch[/variant]"
)

// labelFilters builds an SDK filter matching every label ("k" or "k=v").
func labelFilters(labels []string) client.Filters {
	if len(labels) == 0 {
		return nil
	}
	return make(client.Filters).Add("label", labels...)
}

// --- containers ---------------------------------------------------------

// ListContainers lists all containers (running or not), optionally only those
// carrying every given label.
func (c *Client) ListContainers(ctx context.Context, labels ...string) ([]ContainerSummary, error) {
	res, err := c.ContainerList(ctx, client.ContainerListOptions{All: true, Filters: labelFilters(labels)})
	return res.Items, err
}

// ListRunningContainers is ListContainers without stopped containers.
func (c *Client) ListRunningContainers(ctx context.Context, labels ...string) ([]ContainerSummary, error) {
	res, err := c.ContainerList(ctx, client.ContainerListOptions{Filters: labelFilters(labels)})
	return res.Items, err
}

func (c *Client) InspectContainer(ctx context.Context, id string) (ContainerInspect, error) {
	res, err := c.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	return res.Container, err
}

// InspectContainerSize is InspectContainer plus SizeRw/SizeRootFs (slow on
// large filesystems; Docker walks the layer).
func (c *Client) InspectContainerSize(ctx context.Context, id string) (ContainerInspect, error) {
	res, err := c.ContainerInspect(ctx, id, client.ContainerInspectOptions{Size: true})
	return res.Container, err
}

func (c *Client) CreateContainer(ctx context.Context, name string, cfg *ContainerConfig, host *HostConfig, platform *Platform) (string, error) {
	res, err := c.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: cfg, HostConfig: host, Platform: platform})
	return res.ID, err
}

func (c *Client) RemoveContainer(ctx context.Context, id string, force bool) error {
	_, err := c.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: force})
	return err
}

func (c *Client) StartContainer(ctx context.Context, id string) error {
	_, err := c.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return err
}

func (c *Client) StopContainer(ctx context.Context, id string) error {
	_, err := c.ContainerStop(ctx, id, client.ContainerStopOptions{})
	return err
}

func (c *Client) RestartContainer(ctx context.Context, id string) error {
	_, err := c.ContainerRestart(ctx, id, client.ContainerRestartOptions{})
	return err
}

func (c *Client) PauseContainer(ctx context.Context, id string) error {
	_, err := c.ContainerPause(ctx, id, client.ContainerPauseOptions{})
	return err
}

func (c *Client) UnpauseContainer(ctx context.Context, id string) error {
	_, err := c.ContainerUnpause(ctx, id, client.ContainerUnpauseOptions{})
	return err
}

func (c *Client) KillContainer(ctx context.Context, id, signal string) error {
	_, err := c.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal})
	return err
}

func (c *Client) RenameContainer(ctx context.Context, id, name string) error {
	_, err := c.ContainerRename(ctx, id, client.ContainerRenameOptions{NewName: name})
	return err
}

func (c *Client) UpdateContainer(ctx context.Context, id string, u UpdateConfig) error {
	_, err := c.ContainerUpdate(ctx, id, client.ContainerUpdateOptions{Resources: &u.Resources, RestartPolicy: &u.RestartPolicy})
	return err
}

// ContainerProcesses is `docker top`.
func (c *Client) ContainerProcesses(ctx context.Context, id string) (titles []string, processes [][]string, err error) {
	res, err := c.ContainerTop(ctx, id, client.ContainerTopOptions{})
	return res.Titles, res.Processes, err
}

// ExportContainer streams the container filesystem as a tar. Caller closes.
func (c *Client) ExportContainer(ctx context.Context, id string) (io.ReadCloser, error) {
	return c.ContainerExport(ctx, id, client.ContainerExportOptions{})
}

// PathMissing reports whether path is definitely absent from the container
// (other errors count as present, leaving exec to fail on its own).
func (c *Client) PathMissing(ctx context.Context, id, path string) bool {
	_, err := c.ContainerStatPath(ctx, id, client.ContainerStatPathOptions{Path: path})
	return cerrdefs.IsNotFound(err)
}

// LogOptions is the subset of `docker logs` flags phyless exposes.
type LogOptions struct {
	Since, Until, Tail string
	Follow, Timestamps bool
}

// ContainerLogStream returns stdout+stderr (multiplexed unless the container
// has a TTY; see DemuxLogs). Caller closes.
func (c *Client) ContainerLogStream(ctx context.Context, id string, o LogOptions) (io.ReadCloser, error) {
	return c.ContainerLogs(ctx, id, client.ContainerLogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: o.Follow, Timestamps: o.Timestamps,
		Since: o.Since, Until: o.Until, Tail: o.Tail,
	})
}

// StatsStream streams one JSON stats object per line. Caller closes.
func (c *Client) StatsStream(ctx context.Context, id string) (io.ReadCloser, error) {
	res, err := c.ContainerStats(ctx, id, client.ContainerStatsOptions{Stream: true})
	return res.Body, err
}

// ExecTTY starts cmd in a TTY exec session attached to stdin/stdout. resize
// sets the terminal size. Caller closes the response.
func (c *Client) ExecTTY(ctx context.Context, id string, cmd []string, user string) (resp HijackedResponse, resize func(rows, cols uint) error, err error) {
	created, err := c.ExecCreate(ctx, id, client.ExecCreateOptions{
		AttachStdin: true, AttachStdout: true, AttachStderr: true, TTY: true, Cmd: cmd, User: user,
	})
	if err != nil {
		return resp, nil, err
	}
	attached, err := c.ExecAttach(ctx, created.ID, client.ExecAttachOptions{TTY: true})
	if err != nil {
		return resp, nil, err
	}
	return attached.HijackedResponse, func(rows, cols uint) error {
		_, err := c.ExecResize(ctx, created.ID, client.ExecResizeOptions{Height: rows, Width: cols})
		return err
	}, nil
}

// ResizeContainerTTY resizes the TTY of a container started with one.
func (c *Client) ResizeContainerTTY(ctx context.Context, id string, rows, cols uint) error {
	_, err := c.ContainerResize(ctx, id, client.ContainerResizeOptions{Height: rows, Width: cols})
	return err
}

// EventStream streams daemon events; since/until are Docker's timestamp
// strings ("" = live from now / no end). Both channels end with ctx.
func (c *Client) EventStream(ctx context.Context, since, until string) (<-chan Event, <-chan error) {
	res := c.Events(ctx, client.EventsListOptions{Since: since, Until: until})
	return res.Messages, res.Err
}

// --- images -------------------------------------------------------------

func (c *Client) ListImages(ctx context.Context) ([]ImageSummary, error) {
	res, err := c.ImageList(ctx, client.ImageListOptions{All: true})
	return res.Items, err
}

func (c *Client) InspectImage(ctx context.Context, ref string) (ImageInspect, error) {
	res, err := c.ImageInspect(ctx, ref)
	return res.InspectResponse, err
}

func (c *Client) RemoveImage(ctx context.Context, ref string, force bool) error {
	_, err := c.ImageRemove(ctx, ref, client.ImageRemoveOptions{Force: force})
	return err
}

func (c *Client) ListImageHistory(ctx context.Context, ref string) ([]ImageHistoryItem, error) {
	res, err := c.ImageHistory(ctx, ref)
	return res.Items, err
}

func (c *Client) TagImage(ctx context.Context, source, target string) error {
	_, err := c.ImageTag(ctx, client.ImageTagOptions{Source: source, Target: target})
	return err
}

// SaveImage streams `docker save` of one image. Caller closes.
func (c *Client) SaveImage(ctx context.Context, ref string) (io.ReadCloser, error) {
	return c.ImageSave(ctx, []string{ref})
}

// LoadImage streams `docker load` progress JSON. Caller closes.
func (c *Client) LoadImage(ctx context.Context, tar io.Reader) (io.ReadCloser, error) {
	return c.ImageLoad(ctx, tar)
}

// ImportImage streams `docker import` progress JSON. Caller closes.
func (c *Client) ImportImage(ctx context.Context, tar io.Reader, ref string) (io.ReadCloser, error) {
	return c.ImageImport(ctx, client.ImageImportSource{Source: tar, SourceName: "-"}, ref, client.ImageImportOptions{})
}

// ImportImageURL is `docker import <http(s) URL> ref`; the daemon downloads.
// Caller closes.
func (c *Client) ImportImageURL(ctx context.Context, url, ref string) (io.ReadCloser, error) {
	return c.ImageImport(ctx, client.ImageImportSource{SourceName: url}, ref, client.ImageImportOptions{})
}

// PruneUnusedImages removes every image no container uses (dangling or not).
func (c *Client) PruneUnusedImages(ctx context.Context) (ImagePruneReport, error) {
	res, err := c.ImagePrune(ctx, client.ImagePruneOptions{Filters: make(client.Filters).Add("dangling", "false")})
	return res.Report, err
}

// PullImage streams `docker pull` progress JSON (request-scoped proxy aware,
// see ImagePull). platform is "os/arch[/variant]" or "" for the daemon's.
// Caller closes.
func (c *Client) PullImage(ctx context.Context, ref, encodedAuth, platform string) (io.ReadCloser, error) {
	opts := client.ImagePullOptions{RegistryAuth: encodedAuth}
	if platform != "" {
		p, err := ParsePlatform(platform)
		if err != nil {
			return nil, err
		}
		opts.Platforms = []ocispec.Platform{p}
	}
	return c.ImagePull(ctx, ref, opts)
}

func (c *Client) InspectDistribution(ctx context.Context, ref, encodedAuth string) (DistributionInspect, error) {
	res, err := c.DistributionInspect(ctx, ref, client.DistributionInspectOptions{EncodedRegistryAuth: encodedAuth})
	return res.DistributionInspect, err
}

// --- networks -----------------------------------------------------------

func (c *Client) ListNetworks(ctx context.Context) ([]NetworkSummary, error) {
	res, err := c.NetworkList(ctx, client.NetworkListOptions{})
	return res.Items, err
}

func (c *Client) InspectNetwork(ctx context.Context, id string) (NetworkInspect, error) {
	res, err := c.NetworkInspect(ctx, id, client.NetworkInspectOptions{})
	return res.Network, err
}

// NetworkSpec is what the create-network form can set.
type NetworkSpec struct {
	Driver  string
	IPAM    *NetworkIPAM
	Options map[string]string
	Labels  map[string]string
}

func (c *Client) CreateNetwork(ctx context.Context, name string, s NetworkSpec) (string, error) {
	res, err := c.NetworkCreate(ctx, name, client.NetworkCreateOptions{
		Driver: s.Driver, IPAM: s.IPAM, Options: s.Options, Labels: s.Labels,
	})
	return res.ID, err
}

func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	_, err := c.NetworkRemove(ctx, id, client.NetworkRemoveOptions{})
	return err
}

func (c *Client) ConnectNetwork(ctx context.Context, networkID, containerID string) error {
	_, err := c.NetworkConnect(ctx, networkID, client.NetworkConnectOptions{Container: containerID})
	return err
}

func (c *Client) DisconnectNetwork(ctx context.Context, networkID, containerID string, force bool) error {
	_, err := c.NetworkDisconnect(ctx, networkID, client.NetworkDisconnectOptions{Container: containerID, Force: force})
	return err
}

// --- volumes ------------------------------------------------------------

func (c *Client) ListVolumes(ctx context.Context) ([]Volume, error) {
	res, err := c.VolumeList(ctx, client.VolumeListOptions{})
	return res.Items, err
}

func (c *Client) InspectVolume(ctx context.Context, name string) (Volume, error) {
	res, err := c.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	return res.Volume, err
}

func (c *Client) CreateVolume(ctx context.Context, name, driver string, labels map[string]string) (Volume, error) {
	res, err := c.VolumeCreate(ctx, client.VolumeCreateOptions{Name: name, Driver: driver, Labels: labels})
	return res.Volume, err
}

func (c *Client) RemoveVolume(ctx context.Context, name string, force bool) error {
	_, err := c.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: force})
	return err
}

// --- system -------------------------------------------------------------

func (c *Client) SystemInfo(ctx context.Context) (SystemInfo, error) {
	res, err := c.Info(ctx, client.InfoOptions{})
	return res.Info, err
}

func (c *Client) Version(ctx context.Context) (ServerVersion, error) {
	return c.ServerVersion(ctx, client.ServerVersionOptions{})
}

// --- helpers ------------------------------------------------------------

// PlatformMatches reports whether img is exactly platform p.
func PlatformMatches(p Platform, img ImageInspect) bool {
	return platforms.OnlyStrict(p).Match(ocispec.Platform{OS: img.Os, Architecture: img.Architecture, Variant: img.Variant})
}

// ParsePortSpecs parses `docker run -p` specs ([ip:]host:container[/proto])
// into the exposed set and bindings Docker expects.
func ParsePortSpecs(specs []string) (PortSet, PortMap, error) {
	natExposed, natBindings, err := nat.ParsePortSpecs(specs)
	if err != nil {
		return nil, nil, err
	}
	exposed := PortSet{}
	for p := range natExposed {
		port, err := network.ParsePort(string(p))
		if err != nil {
			return nil, nil, err
		}
		exposed[port] = struct{}{}
	}
	bindings := PortMap{}
	for p, bs := range natBindings {
		port, err := network.ParsePort(string(p))
		if err != nil {
			return nil, nil, err
		}
		out := make([]network.PortBinding, 0, len(bs))
		for _, b := range bs {
			var ip netip.Addr
			if b.HostIP != "" {
				if ip, err = netip.ParseAddr(b.HostIP); err != nil {
					return nil, nil, err
				}
			}
			out = append(out, network.PortBinding{HostIP: ip, HostPort: b.HostPort})
		}
		bindings[port] = out
	}
	return exposed, bindings, nil
}
