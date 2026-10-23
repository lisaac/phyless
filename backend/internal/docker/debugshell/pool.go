package debugshell

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"

	"phyless/backend/internal/docker"
	ctr "phyless/backend/internal/docker/container"
)

const (
	// BoxLife is how long a browse container lives: its main process is
	// `busybox sleep BoxLife`, so it exits and auto-removes on its own and a
	// crashed phyless leaves nothing behind — no GC loop needed.
	BoxLife = 5 * time.Minute
	// boxMargin replaces a box this close to expiry so an ls never races exit.
	boxMargin = 30 * time.Second
	// opTimeout bounds one listing: ls on a hung mount must not pin a request.
	opTimeout = 30 * time.Second
)

// ErrBoxStart wraps a browse container that could not be created or started
// — e.g. a VolumesFrom target whose bind source vanished from the host.
var ErrBoxStart = errors.New("浏览容器无法启动")

// Spec describes a browse container. Image "" means the debug image.
type Spec struct {
	Name   string // what it browses, for the container name
	Image  string
	Host   container.HostConfig // namespace/volume sharing; the pool adds the rest
	Labels map[string]string
}

// Pool keeps one short-lived browse container per key and lists directories
// by exec'ing the shared busybox in it (~50ms) instead of creating a container
// per listing (~0.5s).
type Pool struct {
	cli client.APIClient
	now func() time.Time

	mu    sync.Mutex
	boxes map[string]*box
}

type box struct {
	id      string
	name    string
	expires time.Time
	ready   chan struct{} // closed once id/err are set
	err     error
}

func NewPool(cli client.APIClient) *Pool {
	return &Pool{cli: cli, now: time.Now, boxes: map[string]*box{}}
}

// Has reports whether key has a live browse container.
func (p *Pool) Has(key string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.boxes[key]
	if b == nil || !b.expires.After(p.now()) {
		return false
	}
	select {
	case <-b.ready:
		return b.err == nil
	default:
		return true
	}
}

// Ls lists path inside key's browse container, creating it from spec when
// missing or about to expire. One retry covers a container that vanished
// early (removed by someone, its target stopped) and a busybox volume that
// came up empty (deleted between inspect and create, Docker then creates a
// blank one): that volume is dropped so the retry refills it.
func (p *Pool) Ls(ctx context.Context, key string, spec Spec, path string) (entries []ctr.FileEntry, err error) {
	err = p.do(ctx, key, spec, func(ctx context.Context, id string) error {
		entries, err = ctr.ExecLs(ctx, p.cli, id, path, Busybox, "ls")
		return err
	})
	return entries, err
}

// Run runs busybox with args in key's browse container and returns stdout;
// a non-zero exit is an error carrying stderr.
func (p *Pool) Run(ctx context.Context, key string, spec Spec, args ...string) (out string, err error) {
	err = p.do(ctx, key, spec, func(ctx context.Context, id string) error {
		stdout, stderr, code, err := ctr.ExecCapture(ctx, p.cli, id, append([]string{Busybox}, args...))
		if err == nil && code != 0 {
			err = fmt.Errorf("busybox %s: status %d: %s", args[0], code, strings.TrimSpace(stderr.String()))
			if code == 126 || code == 127 {
				err = fmt.Errorf("%w (status %d)", ctr.ErrExecNotFound, code)
			}
		}
		if err == nil {
			out = stdout.String()
		}
		return err
	})
	return out, err
}

// do runs op against key's browse container, creating it when missing or
// about to expire.
func (p *Pool) do(ctx context.Context, key string, spec Spec, op func(ctx context.Context, id string) error) error {
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	for retried := false; ; retried = true {
		b, err := p.get(ctx, key, spec)
		if err != nil {
			return err
		}
		if used, ok := ctx.Value(usedKey{}).(*string); ok {
			*used = b.name
		}
		err = op(ctx, b.id)
		broken := errors.Is(err, ctr.ErrExecNotFound)
		if err == nil || retried || !(broken || errdefs.IsNotFound(err) || errdefs.IsConflict(err)) {
			return err
		}
		if !broken {
			p.forget(key, b)
			continue
		}
		if err := p.Remove(ctx, key); err != nil {
			return err
		}
		if a, err := assetFor(ctx, p.cli); err == nil {
			_ = p.cli.VolumeRemove(ctx, a.volume(), false) // in use elsewhere: leave it
		}
	}
}

type usedKey struct{}

// Track returns a ctx whose pool operations record the browse container they
// ran in; used reports its name, "" when none was needed (the target's own ls).
func Track(ctx context.Context) (_ context.Context, used func() string) {
	name := new(string)
	return context.WithValue(ctx, usedKey{}, name), func() string { return *name }
}

// Remove deletes key's browse container now, e.g. before removing the image
// or container it pins. Nothing to remove is fine.
func (p *Pool) Remove(ctx context.Context, key string) error {
	p.mu.Lock()
	b := p.boxes[key]
	delete(p.boxes, key)
	p.mu.Unlock()
	if b == nil {
		return nil
	}
	select {
	case <-b.ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	if b.err != nil {
		return nil
	}
	err := p.cli.ContainerRemove(ctx, b.id, container.RemoveOptions{Force: true})
	if errdefs.IsNotFound(err) {
		return nil
	}
	return err
}

// get returns key's ready box. Concurrent callers share one creation.
func (p *Pool) get(ctx context.Context, key string, spec Spec) (*box, error) {
	p.mu.Lock()
	now := p.now()
	b := p.boxes[key]
	if b == nil || b.expires.Sub(now) < boxMargin {
		p.sweepLocked(now)
		b = &box{ready: make(chan struct{}), expires: now.Add(BoxLife)}
		p.boxes[key] = b
		p.mu.Unlock()
		b.id, b.name, b.err = p.start(ctx, spec)
		if b.err != nil {
			p.forget(key, b) // the next call retries
		}
		close(b.ready)
	} else {
		p.mu.Unlock()
	}
	select {
	case <-b.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if b.err != nil {
		return nil, b.err
	}
	return b, nil
}

// sweepLocked drops boxes whose containers already exited by themselves, so
// the map holds only keys used within the last BoxLife. Caller holds p.mu.
func (p *Pool) sweepLocked(now time.Time) {
	for k, b := range p.boxes {
		if b.expires.Before(now) {
			delete(p.boxes, k)
		}
	}
}

func (p *Pool) forget(key string, b *box) {
	p.mu.Lock()
	if p.boxes[key] == b {
		delete(p.boxes, key)
	}
	p.mu.Unlock()
}

// start creates and starts a browse container. It is detached from the
// caller's cancellation: a request dropped mid-create must not strand a
// created-but-never-started container (AutoRemove only fires after start).
func (p *Pool) start(ctx context.Context, spec Spec) (string, string, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	defer cancel()
	bb, err := busyboxMount(ctx, p.cli)
	if err != nil {
		return "", "", err
	}
	hc := spec.Host
	hc.AutoRemove = true
	hc.NetworkMode = "none"
	hc.Mounts = append(slices.Clip(hc.Mounts), bb)
	labels := maps.Clone(spec.Labels)
	if labels == nil {
		labels = map[string]string{}
	}
	labels[docker.RoleLabel] = Role
	cfg := &container.Config{
		Image: spec.Image,
		// Explicit Cmd: an image's own CMD must not leak in as sleep's args.
		Entrypoint: []string{Busybox},
		Cmd:        []string{"sleep", strconv.Itoa(int(BoxLife / time.Second))},
		User:       "0",
		WorkingDir: "/",
		// The image's healthcheck would run its own binaries every interval.
		Healthcheck: &container.HealthConfig{Test: []string{"NONE"}},
		Labels:      labels,
	}
	var resp container.CreateResponse
	name := HelperName("browse", spec.Name)
	if spec.Image == "" {
		resp, err = createDebug(ctx, p.cli, name, cfg, &hc)
	} else {
		resp, err = p.cli.ContainerCreate(ctx, cfg, &hc, nil, nil, name)
	}
	if err != nil {
		return "", "", fmt.Errorf("%w（创建）: %w", ErrBoxStart, err)
	}
	if err := p.cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = p.cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		return "", "", fmt.Errorf("%w（启动）: %w", ErrBoxStart, err)
	}
	return resp.ID, name, nil
}
