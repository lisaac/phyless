package debugshell

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"io"
	"sync"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"

	"phyless/backend/internal/docker"
)

// Static busybox from Alpine's busybox-static; refresh with scripts/fetch-busybox.sh.
// Embedded as strings: read-only data, never copied onto the heap.
var (
	//go:embed busybox-amd64
	busyboxAmd64 string
	//go:embed busybox-arm64
	busyboxArm64 string
)

// Role is the RoleLabel value of every object this package creates.
const Role = "debug"

// Busybox is where browse containers see the shared busybox volume, so any
// image — distroless included — can run it.
const Busybox = "/.phyless/busybox"

// asset is the busybox build for one daemon architecture, named by content so
// a binary upgrade gets a fresh image and volume instead of stale ones.
type asset struct {
	arch, tag, bin string
}

func (a asset) image() string  { return "phyless-debug:" + a.tag }
func (a asset) volume() string { return "phyless-busybox-" + a.tag }

func newAsset(arch, bin string) func() asset {
	return sync.OnceValue(func() asset {
		sum := sha256.Sum256([]byte(bin)) // once per arch
		return asset{arch: arch, tag: fmt.Sprintf("%s-%x", arch, sum[:6]), bin: bin}
	})
}

// Daemon architecture (GOARCH, as /version reports it) → embedded build.
var assets = map[string]func() asset{
	"amd64": newAsset("amd64", busyboxAmd64),
	"arm64": newAsset("arm64", busyboxArm64),
}

// archCache keeps each daemon's architecture so the hot path costs no extra
// round trip. ponytail: one entry per Docker client, never evicted; clients
// are only recreated on server switches.
var archCache sync.Map

func assetFor(ctx context.Context, cli client.APIClient) (asset, error) {
	if a, ok := archCache.Load(cli); ok {
		return a.(func() asset)(), nil
	}
	v, err := cli.ServerVersion(ctx)
	if err != nil {
		return asset{}, err
	}
	a := assets[v.Arch]
	if a == nil {
		return asset{}, fmt.Errorf("调试模式不支持 %s 架构", v.Arch)
	}
	archCache.Store(cli, a)
	return a(), nil
}

// createDebug runs ContainerCreate on the debug image, importing it on first
// use (or after someone deleted it) — the hot path costs no extra round trip.
func createDebug(ctx context.Context, cli client.APIClient, name string, cfg *container.Config, hc *container.HostConfig) (container.CreateResponse, error) {
	a, err := assetFor(ctx, cli)
	if err != nil {
		return container.CreateResponse{}, err
	}
	cfg.Image = a.image()
	resp, err := cli.ContainerCreate(ctx, cfg, hc, nil, nil, name)
	if !errdefs.IsNotFound(err) {
		return resp, err
	}
	// NotFound may also be the target (pid=container:<gone>); only import when
	// the image is what's missing.
	if _, inspectErr := cli.ImageInspect(ctx, a.image()); !errdefs.IsNotFound(inspectErr) {
		return resp, err
	}
	if err := importImage(ctx, cli, a); err != nil {
		return container.CreateResponse{}, err
	}
	return cli.ContainerCreate(ctx, cfg, hc, nil, nil, name)
}

// importImage turns the embedded busybox into a local image — no registry,
// works offline and against remote daemons.
func importImage(ctx context.Context, cli client.APIClient, a asset) error {
	rootfs, err := rootfsTar(a.bin)
	if err != nil {
		return err
	}
	rc, err := cli.ImageImport(ctx, image.ImportSource{Source: bytes.NewReader(rootfs), SourceName: "-"}, a.image(),
		image.ImportOptions{Platform: "linux/" + a.arch, Changes: []string{"LABEL " + docker.RoleLabel + "=" + Role}})
	if err != nil {
		return fmt.Errorf("导入调试镜像失败: %w", err)
	}
	_, _ = io.Copy(io.Discard, rc)
	rc.Close()
	// Import reports failures inside the JSON stream; the tag is the truth.
	if _, err := cli.ImageInspect(ctx, a.image()); err != nil {
		return fmt.Errorf("导入调试镜像失败: %w", err)
	}
	return nil
}

// busyboxMount returns the read-only mount of the busybox volume, filling the
// volume first if needed: Docker copies an image's content into an empty
// named volume mounted over that path, so mounting it at the debug image's
// /bin once leaves busybox inside. A volume (not a bind mount) works against
// remote daemons too.
func busyboxMount(ctx context.Context, cli client.APIClient) (mount.Mount, error) {
	a, err := assetFor(ctx, cli)
	if err != nil {
		return mount.Mount{}, err
	}
	m := mount.Mount{Type: mount.TypeVolume, Source: a.volume(), Target: "/.phyless", ReadOnly: true}
	if _, err := cli.VolumeInspect(ctx, a.volume()); err == nil {
		return m, nil
	} else if !errdefs.IsNotFound(err) {
		return mount.Mount{}, err
	}
	resp, err := createDebug(ctx, cli, HelperName("busybox-init", ""), &container.Config{
		Cmd:    []string{"/bin/busybox"},
		Labels: map[string]string{docker.RoleLabel: Role},
	}, &container.HostConfig{NetworkMode: "none", Mounts: []mount.Mount{{
		Type: mount.TypeVolume, Source: a.volume(), Target: "/bin",
		VolumeOptions: &mount.VolumeOptions{Labels: map[string]string{docker.RoleLabel: Role}},
	}}})
	if err != nil {
		return mount.Mount{}, fmt.Errorf("创建 busybox 卷失败: %w", err)
	}
	// Created, never started: the copy happens at create. Keep the volume.
	if err := cli.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true}); err != nil {
		return mount.Mount{}, err
	}
	return m, nil
}

func rootfsTar(bin string) ([]byte, error) {
	var buf bytes.Buffer
	buf.Grow(len(bin) + 4<<10)
	tw := tar.NewWriter(&buf)
	for _, h := range []*tar.Header{
		{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "tmp/", Typeflag: tar.TypeDir, Mode: 0o1777},
		{Name: "bin/busybox", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(bin))},
	} {
		if err := tw.WriteHeader(h); err != nil {
			return nil, err
		}
	}
	if _, err := io.WriteString(tw, bin); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
