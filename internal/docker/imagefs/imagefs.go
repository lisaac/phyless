// Package imagefs indexes Docker image and stopped-container filesystems without
// starting them. Tar headers become an in-memory directory index; file downloads
// continue to stream through CopyFromContainer.
package imagefs

import (
	"archive/tar"
	"context"
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
	ctr "phyless/internal/docker/container"
)

const (
	RoleLabel  = "phyless.role"
	RoleValue  = "image-fs"
	ImageLabel = "phyless.image"
)

// IsHelper reports whether a container's labels mark it as an imagefs helper,
// so listings can hide it.
func IsHelper(labels map[string]string) bool { return labels[RoleLabel] == RoleValue }

type session struct {
	containerID string
	index       map[string][]ctr.FileEntry
	owned       bool
	lastUsed    time.Time
	inflight    int
	ready       chan struct{} // closed when the build finished
	err         error
}

type Manager struct {
	cli client.APIClient

	mu       sync.Mutex // guards sessions and session state, never held across Docker I/O
	sessions map[string]*session

	now  func() time.Time
	idle time.Duration
	tick time.Duration
}

func New(cli client.APIClient) *Manager {
	return &Manager{
		cli:      cli,
		sessions: map[string]*session{},
		now:      time.Now,
		idle:     10 * time.Minute,
		tick:     time.Minute,
	}
}

// List returns the direct children of path inside the image.
func (m *Manager) List(ctx context.Context, imageID, p string) ([]ctr.FileEntry, error) {
	s, err := m.session(ctx, imageID)
	if err != nil {
		return nil, err
	}
	return m.list(s, p)
}

// ListContainer returns a cached snapshot of a container filesystem. Docker's
// archive API works for stopped containers and includes their mounted volumes.
// ponytail: one full archive scan buys CLI-free navigation; replace it if the
// Engine API gains a native readdir endpoint.
func (m *Manager) ListContainer(ctx context.Context, containerID, p string) ([]ctr.FileEntry, error) {
	s, err := m.containerSession(ctx, containerID)
	if err != nil {
		return nil, err
	}
	return m.list(s, p)
}

func (m *Manager) list(s *session, p string) ([]ctr.FileEntry, error) {
	dir := normPath(p)
	m.mu.Lock()
	defer m.mu.Unlock()
	s.lastUsed = m.now()
	entries, ok := s.index[dir]
	if !ok {
		return nil, fmt.Errorf("目录不存在: %s", dir)
	}
	return slices.Clone(entries), nil
}

// Open streams one path out of the image as a tar archive. The session is
// pinned against GC until the returned reader is closed.
func (m *Manager) Open(ctx context.Context, imageID, p string) (io.ReadCloser, error) {
	s, err := m.session(ctx, imageID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	s.inflight++
	s.lastUsed = m.now()
	m.mu.Unlock()
	rc, _, err := m.cli.CopyFromContainer(ctx, s.containerID, normPath(p))
	if err != nil {
		m.done(s)
		return nil, err
	}
	return &reader{ReadCloser: rc, m: m, s: s}, nil
}

// Release drops the helper container for an image, so the image itself can be
// removed. It is fine if there is nothing to release.
func (m *Manager) Release(ctx context.Context, imageID string) error {
	id, err := m.resolve(ctx, imageID)
	if err != nil {
		id = imageID // 镜像可能已不可 inspect，仍按 label 兜底清理
	}
	m.mu.Lock()
	key := "image:" + id
	s := m.sessions[key]
	delete(m.sessions, key)
	m.mu.Unlock()
	if s != nil {
		select { // 等索引建完，否则容器 ID 还没写进去
		case <-s.ready:
		case <-ctx.Done():
			return ctx.Err()
		}
		if s.containerID == "" {
			return nil
		}
		return m.remove(ctx, s.containerID)
	}
	// 重启后尚未访问过该镜像：按 label 找遗留容器
	found, err := m.find(ctx, id)
	if err != nil || found == "" {
		return err
	}
	return m.remove(ctx, found)
}

// Run cleans up leftover helper containers, then garbage-collects idle sessions
// until ctx is done. Blocking; run it in a goroutine.
func (m *Manager) Run(ctx context.Context) {
	m.cleanup(ctx)
	t := time.NewTicker(m.tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.gc(ctx)
		}
	}
}

func (m *Manager) cleanup(ctx context.Context) {
	list, err := m.cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", RoleLabel+"="+RoleValue)),
	})
	if err != nil {
		return
	}
	for _, c := range list {
		m.remove(ctx, c.ID) //nolint:errcheck
	}
}

func (m *Manager) gc(ctx context.Context) {
	now := m.now()
	m.mu.Lock()
	stale := map[string]*session{}
	for id, s := range m.sessions {
		select {
		case <-s.ready: // 建索引中的会话跳过：containerID 还在写
		default:
			continue
		}
		if s.inflight == 0 && now.Sub(s.lastUsed) > m.idle {
			stale[id] = s
		}
	}
	m.mu.Unlock()
	for id, s := range stale {
		if s.owned {
			if err := m.remove(ctx, s.containerID); err != nil {
				continue // 下一轮重试
			}
		}
		m.mu.Lock()
		delete(m.sessions, id)
		m.mu.Unlock()
	}
}

func (m *Manager) remove(ctx context.Context, containerID string) error {
	return m.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true, RemoveVolumes: true})
}

// session returns the ready session for an image, building it if needed.
// Concurrent callers for the same image share one build; a failed build is
// dropped so the next call retries.
func (m *Manager) session(ctx context.Context, imageID string) (*session, error) {
	id, err := m.resolve(ctx, imageID)
	if err != nil {
		return nil, err
	}
	return m.cached(ctx, "image:"+id, true, func() (string, map[string][]ctr.FileEntry, error) {
		return m.build(ctx, id)
	})
}

func (m *Manager) containerSession(ctx context.Context, containerID string) (*session, error) {
	return m.cached(ctx, "container:"+containerID, false, func() (string, map[string][]ctr.FileEntry, error) {
		rc, _, err := m.cli.CopyFromContainer(ctx, containerID, "/")
		if err != nil {
			return "", nil, err
		}
		defer rc.Close()
		index, err := buildIndex(rc)
		return containerID, index, err
	})
}

func (m *Manager) cached(ctx context.Context, key string, owned bool, build func() (string, map[string][]ctr.FileEntry, error)) (*session, error) {
	m.mu.Lock()
	if s := m.sessions[key]; s != nil {
		m.mu.Unlock()
		select {
		case <-s.ready:
			return s, s.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	s := &session{ready: make(chan struct{}), lastUsed: m.now(), owned: owned}
	m.sessions[key] = s
	m.mu.Unlock()

	s.containerID, s.index, s.err = build()
	if s.err != nil {
		m.mu.Lock()
		if m.sessions[key] == s {
			delete(m.sessions, key)
		}
		m.mu.Unlock()
	}
	close(s.ready)
	return s, s.err
}

func (m *Manager) resolve(ctx context.Context, imageID string) (string, error) {
	info, err := m.cli.ImageInspect(ctx, imageID)
	if err != nil {
		return "", err
	}
	return info.ID, nil
}

func (m *Manager) build(ctx context.Context, id string) (string, map[string][]ctr.FileEntry, error) {
	containerID, err := m.find(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if containerID == "" {
		resp, err := m.cli.ContainerCreate(ctx,
			&container.Config{
				Image:  id,
				Cmd:    []string{"/"},
				Labels: map[string]string{RoleLabel: RoleValue, ImageLabel: id},
			},
			&container.HostConfig{NetworkMode: "none"},
			nil, nil, helperName(id))
		if err != nil {
			return "", nil, err
		}
		containerID = resp.ID
	}
	rc, err := m.cli.ContainerExport(ctx, containerID)
	if err != nil {
		return "", nil, err
	}
	defer rc.Close()
	index, err := buildIndex(rc)
	if err != nil {
		return "", nil, err
	}
	return containerID, index, nil
}

func (m *Manager) find(ctx context.Context, id string) (string, error) {
	list, err := m.cli.ContainerList(ctx, container.ListOptions{
		All: true,
		Filters: filters.NewArgs(
			filters.Arg("label", RoleLabel+"="+RoleValue),
			filters.Arg("label", ImageLabel+"="+id),
		),
	})
	if err != nil || len(list) == 0 {
		return "", err
	}
	return list[0].ID, nil
}

func (m *Manager) done(s *session) {
	m.mu.Lock()
	s.inflight--
	s.lastUsed = m.now()
	m.mu.Unlock()
}

func helperName(id string) string {
	hex := strings.TrimPrefix(id, "sha256:")
	if len(hex) > 12 {
		hex = hex[:12]
	}
	return "phyless-imgfs-" + hex
}

type reader struct {
	io.ReadCloser
	m    *Manager
	s    *session
	once sync.Once
}

func (r *reader) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(func() { r.m.done(r.s) })
	return err
}

// normPath maps any request onto an absolute, cleaned path; path.Clean on a
// rooted path can never escape "/", so ".." needs no separate rejection.
func normPath(p string) string { return path.Clean("/" + p) }

// buildIndex parses only the tar headers of an image export into dir → entries.
func buildIndex(r io.Reader) (map[string][]ctr.FileEntry, error) {
	idx := map[string][]ctr.FileEntry{"/": nil}
	at := map[string]int{} // full path → position in its parent's slice
	var ensure func(dir string)
	add := func(full string, e ctr.FileEntry) {
		d := path.Dir(full)
		ensure(d)
		if i, ok := at[full]; ok {
			idx[d][i] = e
			return
		}
		at[full] = len(idx[d])
		idx[d] = append(idx[d], e)
	}
	ensure = func(dir string) {
		if dir == "/" {
			return
		}
		if _, ok := idx[dir]; ok {
			return
		}
		idx[dir] = nil
		add(dir, ctr.FileEntry{Name: path.Base(dir), Mode: "drwxr-xr-x", IsDir: true})
	}

	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return idx, nil
		}
		if err != nil {
			return nil, err
		}
		name := normPath(h.Name)
		if name == "/" {
			continue
		}
		e := ctr.FileEntry{
			Name:    path.Base(name),
			Size:    h.Size,
			Mode:    modeString(h),
			IsDir:   h.Typeflag == tar.TypeDir,
			ModTime: h.ModTime.Unix(),
			Uname:   h.Uname,
			Uid:     h.Uid,
			Gid:     h.Gid,
		}
		if h.Typeflag == tar.TypeSymlink {
			e.Size = 0
		}
		if e.IsDir {
			ensure(name)
		}
		add(name, e)
	}
}

// modeString formats a header like ls does; fs.FileMode prints 'L' for symlinks.
func modeString(h *tar.Header) string {
	s := h.FileInfo().Mode().String()
	if h.Typeflag == tar.TypeSymlink {
		return "l" + s[1:]
	}
	return s
}
