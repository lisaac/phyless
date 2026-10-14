package fsbrowse

import (
	"context"
	"io/fs"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"

	ctr "phyless/backend/internal/docker/container"
)

const (
	// maxCachedChanges bounds change paths kept across all containers
	// (~80 B each); a container above it is served once and not cached.
	maxCachedChanges = 300_000
	// changesTTL frees a container's changes after this long unused.
	changesTTL = 5 * time.Minute
	// maxStats caps per-listing stat calls for entries the changes list has no
	// metadata for. ponytail: past it entries show without size/mode.
	maxStats = 256
)

type change struct {
	path string
	kind container.ChangeType
}

// changeSet is one stopped container's writable-layer changes (paths only,
// from /containers/{id}/changes), sorted for prefix lookups.
type changeSet struct {
	finishedAt string // invalid once the container ran again
	ready      chan struct{}
	err        error
	changes    []change
	lastUsed   time.Time
	timer      *time.Timer

	statMu sync.Mutex
	stats  map[string]ctr.FileEntry // full path → stat'ed entry
}

// changeCache shares changeSets between listings of the same container.
type changeCache struct {
	mu    sync.Mutex
	sets  map[string]*changeSet
	total int
}

func (c *changeCache) get(ctx context.Context, cli client.APIClient, id, finishedAt string) (*changeSet, error) {
	c.mu.Lock()
	if c.sets == nil {
		c.sets = map[string]*changeSet{}
	}
	s := c.sets[id]
	if s != nil && s.finishedAt == finishedAt {
		s.lastUsed = time.Now()
		if s.timer != nil {
			s.timer.Reset(changesTTL)
		}
		c.mu.Unlock()
		select {
		case <-s.ready:
			return s, s.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if s != nil {
		c.removeLocked(id, s)
	}
	s = &changeSet{finishedAt: finishedAt, ready: make(chan struct{}), lastUsed: time.Now(), stats: map[string]ctr.FileEntry{}}
	c.sets[id] = s
	c.mu.Unlock()

	raw, err := cli.ContainerDiff(ctx, id)
	if err == nil {
		s.changes = make([]change, len(raw))
		for i, r := range raw {
			s.changes[i] = change{path: path.Clean("/" + r.Path), kind: r.Kind}
		}
		slices.SortFunc(s.changes, func(a, b change) int { return strings.Compare(a.path, b.path) })
	}
	s.err = err

	c.mu.Lock()
	switch {
	case c.sets[id] != s: // invalidated meanwhile: serve this caller only
	case err != nil || len(s.changes) > maxCachedChanges:
		delete(c.sets, id)
	default:
		c.total += len(s.changes)
		s.timer = time.AfterFunc(changesTTL, func() { c.remove(id, s) })
		c.evictLocked(s)
	}
	c.mu.Unlock()
	close(s.ready)
	return s, err
}

// evictLocked drops least recently used sets until the budget fits, never
// keep (the one just built). Caller holds c.mu.
func (c *changeCache) evictLocked(keep *changeSet) {
	for c.total > maxCachedChanges {
		var oldID string
		var old *changeSet
		for id, s := range c.sets {
			if s != keep && s.timer != nil && (old == nil || s.lastUsed.Before(old.lastUsed)) {
				oldID, old = id, s
			}
		}
		if old == nil {
			return
		}
		c.removeLocked(oldID, old)
	}
}

func (c *changeCache) remove(id string, s *changeSet) {
	c.mu.Lock()
	c.removeLocked(id, s)
	c.mu.Unlock()
}

func (c *changeCache) removeLocked(id string, s *changeSet) {
	if c.sets[id] != s {
		return
	}
	delete(c.sets, id)
	if s.timer != nil {
		s.timer.Stop()
		c.total -= len(s.changes)
	}
}

// clear drops everything, e.g. after phyless wrote into a stopped container
// (its FinishedAt does not change). The cache is small; precision isn't worth
// a name→ID lookup.
func (c *changeCache) clear() {
	c.mu.Lock()
	for id, s := range c.sets {
		c.removeLocked(id, s)
	}
	c.mu.Unlock()
}

func (s *changeSet) find(p string) (change, bool) {
	i := sort.Search(len(s.changes), func(i int) bool { return s.changes[i].path >= p })
	if i < len(s.changes) && s.changes[i].path == p {
		return s.changes[i], true
	}
	return change{}, false
}

// deleted reports whether dir or one of its ancestors was removed.
func (s *changeSet) deleted(dir string) bool {
	for a := dir; a != "/"; a = path.Dir(a) {
		if c, ok := s.find(a); ok && c.kind == container.ChangeDelete {
			return true
		}
	}
	return false
}

type child struct {
	kind     container.ChangeType
	explicit bool // the child itself is in the list, not only things beneath it
	dir      bool // something beneath it changed
}

// children returns dir's direct children that changed.
func (s *changeSet) children(dir string) map[string]child {
	prefix := strings.TrimSuffix(dir, "/") + "/"
	out := map[string]child{}
	i := sort.Search(len(s.changes), func(i int) bool { return s.changes[i].path >= prefix })
	for ; i < len(s.changes) && strings.HasPrefix(s.changes[i].path, prefix); i++ {
		name, _, nested := strings.Cut(s.changes[i].path[len(prefix):], "/")
		ch := out[name]
		if nested {
			ch.dir = true
		} else {
			ch.kind, ch.explicit = s.changes[i].kind, true
		}
		out[name] = ch
	}
	return out
}

// merge applies dir's changes to the image's listing: deletions drop entries,
// additions appear, and entries whose metadata the image cannot vouch for are
// returned in need for a stat.
func merge(base []ctr.FileEntry, kids map[string]child) (out []ctr.FileEntry, need []int) {
	removed := func(ch child) bool { return ch.explicit && ch.kind == container.ChangeDelete }
	out = make([]ctr.FileEntry, 0, len(base)+len(kids))
	pos := make(map[string]int, len(base))
	for _, e := range base {
		if ch, ok := kids[e.Name]; ok && removed(ch) {
			continue
		}
		pos[e.Name] = len(out)
		out = append(out, e)
	}
	for name, ch := range kids {
		i, inImage := pos[name]
		switch {
		case removed(ch):
		case inImage && out[i].IsDir && (ch.dir || ch.kind == container.ChangeModify):
			// Only its contents changed; the image's metadata stands.
		case inImage:
			need = append(need, i)
		default:
			e := ctr.FileEntry{Name: name, Mode: "-?????????"}
			if ch.dir {
				e.IsDir, e.Mode = true, "d?????????"
			}
			need = append(need, len(out))
			out = append(out, e)
		}
	}
	return out, need
}

// stat fills real metadata for out[need] (capped, cached per changeSet).
func (s *changeSet) stat(ctx context.Context, cli client.APIClient, id, dir string, out []ctr.FileEntry, need []int) {
	if len(need) > maxStats {
		need = need[:maxStats]
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, i := range need {
		full := path.Join(dir, out[i].Name)
		s.statMu.Lock()
		cached, ok := s.stats[full]
		s.statMu.Unlock()
		if ok {
			out[i] = cached
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(e *ctr.FileEntry) {
			defer func() { <-sem; wg.Done() }()
			st, err := cli.ContainerStatPath(ctx, id, full)
			if err != nil {
				return
			}
			*e = ctr.FileEntry{Name: e.Name, Size: st.Size, Mode: modeString(st.Mode), IsDir: st.Mode.IsDir()}
			if st.Mode&fs.ModeSymlink != 0 {
				e.Size = 0
			}
			if !st.Mtime.IsZero() {
				e.ModTime = st.Mtime.Unix()
			}
			s.statMu.Lock()
			s.stats[full] = *e
			s.statMu.Unlock()
		}(&out[i])
	}
	wg.Wait()
}

// modeString formats like ls; fs.FileMode prints 'L' for symlinks.
func modeString(m fs.FileMode) string {
	s := m.String()
	if m&fs.ModeSymlink != 0 {
		return "l" + s[1:]
	}
	return s
}
