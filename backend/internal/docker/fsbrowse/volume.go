package fsbrowse

import (
	"context"
	"io"
	"path"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"

	ctr "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/debugshell"
)

// Volumes are browsed and changed through a helper that mounts them, like
// everything else here: phyless's own filesystem may not hold the volume at
// all (a remote daemon, Docker Desktop's VM, a plugin driver), and a symlink
// inside it resolves in the helper — never on phyless's host.

// VolumeLabel names the volume a helper mounts, so deleting the volume can
// release them first (Docker refuses while one exists).
const VolumeLabel = "phyless.volume"

// volRoot is where helpers mount the volume: a path no error message or file
// name would otherwise contain, so boxErr can strip it.
const volRoot = "/.phyless-volume"

func volumeKey(name string) string { return "volume:" + name }

func volumeSpec(name string) debugshell.Spec {
	return debugshell.Spec{Name: name, Labels: map[string]string{VolumeLabel: name},
		Host: container.HostConfig{Mounts: []mount.Mount{{Type: mount.TypeVolume, Source: name, Target: volRoot}}}}
}

// volume checks name exists: mounting a missing named volume would create it.
func (f *FS) volume(ctx context.Context, name string) error {
	_, err := f.cli.VolumeInspect(ctx, name)
	return err
}

// ListVolume lists p inside a volume.
func (f *FS) ListVolume(ctx context.Context, name, p string) ([]ctr.FileEntry, error) {
	if err := f.volume(ctx, name); err != nil {
		return nil, err
	}
	return f.pool.Ls(ctx, volumeKey(name), volumeSpec(name), volRoot+path.Clean("/"+p))
}

// OpenVolume streams p out of a volume as a tar archive.
func (f *FS) OpenVolume(ctx context.Context, name, p string) (io.ReadCloser, error) {
	if err := f.volume(ctx, name); err != nil {
		return nil, err
	}
	return f.open(ctx, volumeSpec(name), volRoot+path.Clean("/"+p))
}

// UploadVolume writes one file named filename into dir of a volume.
func (f *FS) UploadVolume(ctx context.Context, name, dir, filename string, src io.Reader, maxBytes int64) error {
	if err := f.volume(ctx, name); err != nil {
		return err
	}
	id, err := debugshell.CreateIdle(ctx, f.cli, "upload", volumeSpec(name))
	if err != nil {
		return err
	}
	defer f.remove(context.WithoutCancel(ctx), id) //nolint:errcheck // a leftover is pruned at startup
	return boxErr(ctr.UploadTarFile(ctx, f.cli, id, volRoot+path.Clean("/"+dir), filename, src, maxBytes), volRoot)
}

// ReleaseVolume removes every helper mounting a volume so it can be deleted.
func (f *FS) ReleaseVolume(ctx context.Context, name string) error {
	if err := f.pool.Remove(ctx, volumeKey(name)); err != nil {
		return err
	}
	return f.removeLabeled(ctx, VolumeLabel+"="+name)
}
