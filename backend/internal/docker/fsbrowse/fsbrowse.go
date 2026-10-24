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
	"sync"
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

// ContainerLabel names the container a browse container serves, so deleting
// that container releases them all — a box replaced early still runs a while.
const ContainerLabel = "phyless.container"

// Pool keys: one browse container per image, per running container without
// ls (PID-sharing), and per stopped container (its image + its volumes, or
// without volumes when those cannot be mounted).
func imageKey(id string) string       { return "image:" + id }
func pidKey(id string) string         { return "pid:" + id }
func stoppedKey(id string) string     { return "stopped:" + id }
func stoppedBareKey(id string) string { return "stopped-novols:" + id }

// containerKeys are every key that can pin container id.
func containerKeys(id string) []string {
	return []string{pidKey(id), stoppedKey(id), stoppedBareKey(id)}
}

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
	noLs    sync.Map // container ID → struct{}: its own ls is missing; dropped on ReleaseContainer
	runs    runCache
}

func New(cli client.APIClient) *FS {
	return &FS{cli: cli, pool: debugshell.NewPool(cli)}
}

// Run removes helpers a crashed phyless left created-but-never-started
// (downloads; running helpers expire on their own), including the image-fs
// helpers of older versions, then debug images/volumes of other versions.
func (f *FS) Run(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	defer debugshell.Prune(ctx, f.cli)
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
	return f.listImage(ctx, id, ref, path.Clean("/"+p))
}

// runtimeDirs are mounted by the runtime into the browse container; in an
// image they are empty mount points, so its view of them would be a lie.
var runtimeDirs = []string{"/proc", "/sys", "/dev"}

// listImage lists p in image id; ref is how the user named it (a tag reads
// better than an ID in the helper's container name).
func (f *FS) listImage(ctx context.Context, id, ref, p string) ([]ctr.FileEntry, error) {
	return imageView(p, func() ([]ctr.FileEntry, error) {
		return f.pool.Ls(ctx, imageKey(id), debugshell.Spec{Name: ref, Image: id, Labels: map[string]string{ImageLabel: id}}, p)
	})
}

// imageView is ls of an image's own files as a browse container sees them,
// minus what the container runtime adds.
func imageView(p string, ls func() ([]ctr.FileEntry, error)) ([]ctr.FileEntry, error) {
	for _, d := range runtimeDirs {
		if p == d || strings.HasPrefix(p, d+"/") {
			return []ctr.FileEntry{}, nil
		}
	}
	entries, err := ls()
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
	entries, err := f.listContainer(ctx, t, p)
	exes := f.runs.get(ctx, f, t)
	for i := range entries {
		full := path.Join(p, entries[i].Name)
		if m, ok := mountOf(t.Mounts, full); ok {
			entries[i].Mount = &ctr.MountRef{Type: string(m.Type), Source: m.Source, Destination: m.Destination}
		}
		for _, m := range t.Mounts {
			if strings.HasPrefix(path.Clean("/"+m.Destination), full+"/") {
				entries[i].MountBelow = true
			}
		}
		for _, x := range exes {
			entries[i].Run = entries[i].Run || x == full
			entries[i].RunBelow = entries[i].RunBelow || strings.HasPrefix(x, full+"/")
		}
	}
	return entries, err
}

func (f *FS) listContainer(ctx context.Context, t container.InspectResponse, p string) ([]ctr.FileEntry, error) {
	switch {
	case t.State.Running && !t.State.Paused && !f.lacksLs(t.ID):
		// Its own ls is live, free, and names owners from its own passwd.
		entries, err := ctr.ExecLs(ctx, f.cli, t.ID, p)
		if !errors.Is(err, ctr.ErrExecNotFound) {
			return entries, err
		}
		f.noLs.Store(t.ID, struct{}{}) // ponytail: containers deleted outside phyless stay; IDs are tiny
		fallthrough
	case t.State.Running: // no ls (distroless), or paused (exec refused)
		return f.pool.Ls(ctx, pidKey(t.ID), pidSpec(t), debugshell.TargetRoot(t)+p)
	default:
		return f.listStopped(ctx, t, p)
	}
}

// ListContainerDiff lists only what changed in p relative to the image (docker
// diff), keeping the directory structure: a directory appears when something
// beneath it changed. Without stat it returns names and change kinds only,
// enough to mark a normal listing.
func (f *FS) ListContainerDiff(ctx context.Context, ref, p string, stat bool) ([]ctr.FileEntry, error) {
	t, err := f.cli.ContainerInspect(ctx, ref)
	if err != nil {
		return nil, err
	}
	if t.ContainerJSONBase == nil || t.State == nil {
		return nil, fmt.Errorf("容器状态未知: %s", ref)
	}
	p = path.Clean("/" + p)
	key := t.State.FinishedAt
	if t.State.Running {
		// ponytail: a running container's changes move; reuse them for 10s
		// so drilling down doesn't refetch each level.
		key = "running@" + time.Now().Truncate(10*time.Second).String()
	}
	cs, err := f.changes.get(ctx, f.cli, t.ID, key)
	if err != nil {
		return nil, err
	}
	out, need := diffEntries(cs.children(p))
	for i := range out {
		if out[i].IsDir {
			out[i].Kinds = cs.kindsUnder(path.Join(p, out[i].Name))
		}
	}
	if stat {
		statCtx, cancel := context.WithTimeout(ctx, statTimeout)
		defer cancel()
		cs.stat(statCtx, f.cli, t.ID, p, out, need)
	}
	slices.SortFunc(out, func(a, b ctr.FileEntry) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

func (f *FS) lacksLs(id string) bool { _, ok := f.noLs.Load(id); return ok }

// pidSpec is a browse container sharing t's PID namespace.
func pidSpec(t container.InspectResponse) debugshell.Spec {
	return debugshell.Spec{Name: t.Name, Labels: map[string]string{ContainerLabel: t.ID}, Host: container.HostConfig{
		PidMode: container.PidMode("container:" + t.ID),
		CapAdd:  []string{"SYS_PTRACE"}, // /proc/<pid>/root of another uid
	}}
}

// stoppedSpec is a stopped container's one browse container, for listing and
// for changes: its image with its volumes mounted as t mounts them (a
// read-only mount stays read-only).
func stoppedSpec(t container.InspectResponse) debugshell.Spec {
	return debugshell.Spec{Name: t.Name, Image: t.Image,
		Labels: map[string]string{ImageLabel: t.Image, ContainerLabel: t.ID},
		Host:   container.HostConfig{VolumesFrom: []string{t.ID}}}
}

// listStopped lists a stopped container's filesystem without streaming its
// bytes (a 4 GB layer took minutes via archive/export). One browse container
// — its image with its own volumes — serves every path:
// mounts are listed as they are, the rest is the image's listing merged with
// the writable-layer changes.
func (f *FS) listStopped(ctx context.Context, t container.InspectResponse, p string) ([]ctr.FileEntry, error) {
	if underMount(t.Mounts, p) {
		return f.lsStopped(ctx, t, p)
	}
	cs, err := f.changes.get(ctx, f.cli, t.ID, t.State.FinishedAt)
	if err != nil {
		return nil, err
	}
	if cs.deleted(p) {
		return nil, fmt.Errorf("目录不存在: %s", p)
	}
	kids := cs.children(p)
	base, err := imageView(p, func() ([]ctr.FileEntry, error) { return f.lsStopped(ctx, t, p) })
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

// lsStopped runs ls in t's browse container. A mount source gone from the host
// (say a deleted bind directory) fails that container as a whole; paths
// outside the mounts then still list from a volume-less one.
func (f *FS) lsStopped(ctx context.Context, t container.InspectResponse, p string) ([]ctr.FileEntry, error) {
	spec := stoppedSpec(t)
	entries, err := f.pool.Ls(ctx, stoppedKey(t.ID), spec, p)
	if errors.Is(err, debugshell.ErrBoxStart) && !underMount(t.Mounts, p) {
		spec.Host.VolumesFrom = nil
		return f.pool.Ls(ctx, stoppedBareKey(t.ID), spec, p)
	}
	return entries, err
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
	}, &container.HostConfig{NetworkMode: "none"}, nil, nil, debugshell.HelperName("download", ref))
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
	if err := f.pool.Remove(ctx, imageKey(id)); err != nil {
		return err
	}
	return f.removeLabeled(ctx, ImageLabel+"="+id)
}

// ReleaseContainer drops a container's browse helpers before it is deleted, so
// none keeps its volumes in use.
func (f *FS) ReleaseContainer(ctx context.Context, ref string) error {
	t, err := f.cli.ContainerInspect(ctx, ref)
	if errdefs.IsNotFound(err) || err == nil && t.ContainerJSONBase == nil {
		return nil // nothing of ours can pin what does not exist
	}
	if err != nil {
		return err // unknown: deleting now could leave its volumes pinned
	}
	f.noLs.Delete(t.ID)
	for _, key := range containerKeys(t.ID) {
		if err := f.pool.Remove(ctx, key); err != nil {
			return err
		}
	}
	return f.removeLabeled(ctx, ContainerLabel+"="+t.ID)
}

// removeLabeled removes every helper carrying label, other phyless
// instances' included.
func (f *FS) removeLabeled(ctx context.Context, label string) error {
	list, err := f.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", label))})
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
	_, ok := mountOf(mounts, p)
	return ok
}

// mountOf returns the innermost mount p is or lies beneath.
func mountOf(mounts []container.MountPoint, p string) (container.MountPoint, bool) {
	var best container.MountPoint
	found := false
	for _, m := range mounts {
		d := path.Clean("/" + m.Destination)
		if (p == d || strings.HasPrefix(p, strings.TrimSuffix(d, "/")+"/")) && (!found || len(d) > len(path.Clean("/"+best.Destination))) {
			best, found = m, true
		}
	}
	return best, found
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
