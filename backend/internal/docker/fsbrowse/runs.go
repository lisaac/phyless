package fsbrowse

import (
	"context"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"

	ctr "phyless/backend/internal/docker/container"
	"phyless/backend/internal/docker/debugshell"
)

// runsTTL reuses a container's process list across the listings of a walk.
const runsTTL = 10 * time.Second

// exeScript prints the executable of every process in the PID namespace.
// readlink shows each path as the process's own mount namespace sees it,
// so it reads like a path inside the target.
var exeScript = `for e in /proc/[0-9]*/exe; do ` + debugshell.Busybox + ` readlink "$e"; done; true`

// ownExeScript is exeScript run by the target's own shell, skipping that shell
// (the readlinks start after the glob, so they are never listed). Exit 127
// without readlink, so a missing tool falls back instead of tagging nothing.
const ownExeScript = `command -v readlink >/dev/null || exit 127; for e in /proc/[0-9]*; do [ "$e" = /proc/$$ ] || readlink "$e/exe"; done; true`

type runs struct {
	at   time.Time
	exes []string
}

// runCache holds the executables of each running container's processes.
type runCache struct {
	mu sync.Mutex
	m  map[string]runs
}

// get returns t's running executables; nil when t isn't running, shares the
// host's PID namespace (its processes would be the host's), or they can't be
// read — tags are a nicety, never a reason to fail a listing.
func (c *runCache) get(ctx context.Context, f *FS, t container.InspectResponse) []string {
	if !t.State.Running || t.HostConfig != nil && t.HostConfig.PidMode.IsHost() {
		return nil
	}
	c.mu.Lock()
	r, ok := c.m[t.ID]
	c.mu.Unlock()
	if ok && time.Since(r.at) < runsTTL {
		return r.exes
	}
	out, err := f.ownExes(ctx, t)
	if err != nil {
		if out, err = f.pool.Run(ctx, pidKey(t.ID), pidSpec(t), "sh", "-c", exeScript); err != nil {
			return nil
		}
	}
	r = runs{at: time.Now()}
	box := path.Dir(debugshell.Busybox) + "/"
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSuffix(strings.TrimSpace(l), " (deleted)")
		// The browse container's own sleep/sh/readlink run its busybox.
		if strings.HasPrefix(l, "/") && !strings.HasPrefix(l, box) {
			r.exes = append(r.exes, path.Clean(l))
		}
	}
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]runs{}
	}
	for id, old := range c.m { // drop stale entries of stopped/removed containers
		if time.Since(old.at) >= runsTTL {
			delete(c.m, id)
		}
	}
	c.m[t.ID] = r
	c.mu.Unlock()
	return r.exes
}

// ownExes reads t's executables with its own sh and readlink, so a container
// that has them never needs a browse container just for the run tags.
func (f *FS) ownExes(ctx context.Context, t container.InspectResponse) (string, error) {
	if t.State.Paused || f.lacksLs(t.ID) { // exec refused / no coreutils either
		return "", ctr.ErrExecNotFound
	}
	stdout, _, code, err := ctr.ExecCapture(ctx, f.cli, t.ID, []string{"sh", "-c", ownExeScript})
	if err == nil && code != 0 {
		err = ctr.ErrExecNotFound
	}
	if err != nil {
		return "", err
	}
	return stdout.String(), nil
}
