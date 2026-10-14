// Package fsbrowse lists and reads files of images and containers without
// needing any tool inside them and without streaming their bytes: a target's
// own ls when it has one, otherwise busybox in a browse container (see
// debugshell.Pool), plus /containers/{id}/changes for stopped containers.
package fsbrowse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"

	"phyless/backend/internal/docker"
	ctr "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/debugshell"
)

// ImageLabel names the image a helper container pins, so deleting that image
// can release its helpers first (Docker refuses while they exist).
const ImageLabel = "phyless.image"

// statTimeout bounds the stats of one listing; entries not stat'ed in time
// keep their placeholder metadata.
const statTimeout = 30 * time.Second

// staleHelper is how old a never-started helper must be before startup removes
// it — younger ones may belong to another phyless on the same daemon.
const staleHelper = time.Hour

type FS struct {
	cli     client.APIClient
	pool    *debugshell.Pool
	changes changeCache
}

func New(cli client.APIClient) *FS {
	return &FS{cli: cli, pool: debugshell.NewPool(cli)}
}

// Run removes helpers a crashed phyless left created-but-never-started
// (downloads; running helpers expire on their own), including the image-fs
// helpers of older versions.
func (f *FS) Run(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	list, err := f.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(
		filters.Arg("label", docker.RoleLabel), filters.Arg("status", "created"))})
	if err != nil {
		return
	}
	for _, c := range list {
		role := c.Labels[docker.RoleLabel]
		if (role == debugshell.Role || role == "image-fs") && time.Since(time.Unix(c.Created, 0)) > staleHelper {
			_ = f.remove(ctx, c.ID)
		}
	}
}

// ListImage lists p inside an image.
func (f *FS) ListImage(ctx context.Context, ref, p string) ([]ctr.FileEntry, error) {
	id, err := f.imageID(ctx, ref)
	if err != nil {
		return nil, err
	}
	return f.listImage(ctx, id, path.Clean("/"+p))
}

// runtimeDirs are mounted by the runtime into the browse container; in an
// image they are empty mount points, so its view of them would be a lie.
var runtimeDirs = []string{"/proc", "/sys", "/dev"}

func (f *FS) listImage(ctx context.Context, id, p string) ([]ctr.FileEntry, error) {
	for _, d := range runtimeDirs {
		if p == d || strings.HasPrefix(p, d+"/") {
			return []ctr.FileEntry{}, nil
		}
	}
	entries, err := f.pool.Ls(ctx, "image:"+id, debugshell.Spec{Image: id, Labels: map[string]string{ImageLabel: id}}, p)
	if p == "/" { // hide the busybox mount point
		entries = slices.DeleteFunc(entries, func(e ctr.FileEntry) bool { return "/"+e.Name == path.Dir(debugshell.Busybox) })
	}
	return entries, err
}

// ListContainer lists p inside a container in any state.
func (f *FS) ListContainer(ctx context.Context, ref, p string) ([]ctr.FileEntry, error) {
	t, err := f.cli.ContainerInspect(ctx, ref)
	if err != nil {
		return nil, err
	}
	if t.ContainerJSONBase == nil || t.State == nil {
		return nil, fmt.Errorf("容器状态未知: %s", ref)
	}
	p = path.Clean("/" + p)
	pidKey := "pid:" + t.ID
	switch {
	case t.State.Running && !t.State.Paused && !f.pool.Has(pidKey):
		// Its own ls is live and free; a pid box for it means it has none.
		entries, err := ctr.ExecLs(ctx, f.cli, t.ID, p)
		if !errors.Is(err, ctr.ErrExecNotFound) {
			return entries, err
		}
		fallthrough
	case t.State.Running: // no ls (distroless), or paused (exec refused)
		return f.pool.Ls(ctx, pidKey, debugshell.Spec{Host: container.HostConfig{
			PidMode: container.PidMode("container:" + t.ID),
			CapAdd:  []string{"SYS_PTRACE"}, // /proc/<pid>/root of another uid
		}}, debugshell.TargetRoot(t)+p)
	case underMount(t.Mounts, p):
		return f.pool.Ls(ctx, "vols:"+t.ID, debugshell.Spec{Host: container.HostConfig{
			VolumesFrom: []string{t.ID + ":ro"},
		}}, p)
	default:
		return f.listStopped(ctx, t, p)
	}
}

// listStopped lists a stopped container's own filesystem: its image's listing
// merged with its writable-layer changes. Nothing streams the layer's bytes
// (a 4 GB layer took minutes via archive/export).
func (f *FS) listStopped(ctx context.Context, t container.InspectResponse, p string) ([]ctr.FileEntry, error) {
	cs, err := f.changes.get(ctx, f.cli, t.ID, t.State.FinishedAt)
	if err != nil {
		return nil, err
	}
	if cs.deleted(p) {
		return nil, fmt.Errorf("目录不存在: %s", p)
	}
	kids := cs.children(p)
	base, err := f.listImage(ctx, t.Image, p)
	if err != nil {
		// A directory the container created exists only in its changes.
		if c, ok := cs.find(p); len(kids) == 0 && !(ok && c.kind == container.ChangeAdd) {
			return nil, err
		}
		base = nil
	}
	out, need := merge(base, kids)
	statCtx, cancel := context.WithTimeout(ctx, statTimeout)
	defer cancel()
	cs.stat(statCtx, f.cli, t.ID, p, out, need)
	slices.SortFunc(out, func(a, b ctr.FileEntry) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// OpenImage streams p out of an image as a tar archive. It uses its own
// never-started container: a browse container may expire mid-download.
func (f *FS) OpenImage(ctx context.Context, ref, p string) (io.ReadCloser, error) {
	id, err := f.imageID(ctx, ref)
	if err != nil {
		return nil, err
	}
	resp, err := f.cli.ContainerCreate(ctx, &container.Config{
		Image:  id,
		Cmd:    []string{"/"}, // never run; images without CMD need one to create
		Labels: map[string]string{docker.RoleLabel: debugshell.Role, ImageLabel: id},
	}, &container.HostConfig{NetworkMode: "none"}, nil, nil, "")
	if err != nil {
		return nil, err
	}
	rc, _, err := f.cli.CopyFromContainer(ctx, resp.ID, path.Clean("/"+p))
	if err != nil {
		_ = f.remove(context.WithoutCancel(ctx), resp.ID)
		return nil, err
	}
	return &removeOnClose{ReadCloser: rc, done: func() { _ = f.remove(context.WithoutCancel(ctx), resp.ID) }}, nil
}

// ReleaseImage removes every helper pinning an image so it can be deleted.
func (f *FS) ReleaseImage(ctx context.Context, ref string) error {
	id, err := f.imageID(ctx, ref)
	if err != nil {
		id = ref // may be uninspectable already; still clean by label
	}
	if err := f.pool.Remove(ctx, "image:"+id); err != nil {
		return err
	}
	list, err := f.cli.ContainerList(ctx, container.ListOptions{All: true,
		Filters: filters.NewArgs(filters.Arg("label", ImageLabel+"="+id))})
	if err != nil {
		return err
	}
	for _, c := range list {
		if err := f.remove(ctx, c.ID); err != nil {
			return err
		}
	}
	return nil
}

// ReleaseContainer drops a container's browse helpers before it is deleted, so
// none keeps its volumes in use.
func (f *FS) ReleaseContainer(ctx context.Context, ref string) error {
	t, err := f.cli.ContainerInspect(ctx, ref)
	if err != nil || t.ContainerJSONBase == nil {
		return nil // nothing of ours can pin what does not exist
	}
	if err := f.pool.Remove(ctx, "pid:"+t.ID); err != nil {
		return err
	}
	return f.pool.Remove(ctx, "vols:"+t.ID)
}

// Invalidate forgets cached changes after phyless wrote into a container.
func (f *FS) Invalidate() { f.changes.clear() }

// imageID resolves a reference; full IDs skip the round trip.
func (f *FS) imageID(ctx context.Context, ref string) (string, error) {
	if strings.HasPrefix(ref, "sha256:") && len(ref) == len("sha256:")+64 {
		return ref, nil
	}
	img, err := f.cli.ImageInspect(ctx, ref)
	if err != nil {
		return "", err
	}
	return img.ID, nil
}

func (f *FS) remove(ctx context.Context, id string) error {
	err := f.cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: true, RemoveVolumes: true})
	if errdefs.IsNotFound(err) {
		return nil
	}
	return err
}

// underMount reports whether p is a mount destination or lies beneath one.
func underMount(mounts []container.MountPoint, p string) bool {
	for _, m := range mounts {
		d := path.Clean("/" + m.Destination)
		if p == d || strings.HasPrefix(p, strings.TrimSuffix(d, "/")+"/") {
			return true
		}
	}
	return false
}

type removeOnClose struct {
	io.ReadCloser
	done func()
}

func (r *removeOnClose) Close() error {
	err := r.ReadCloser.Close()
	r.done()
	return err
}
