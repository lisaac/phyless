// Package imagefs indexes Docker image and stopped-container filesystems without
// starting them. Tar headers become a bounded temporary disk index; file downloads
// continue to stream through CopyFromContainer.
package imagefs

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	ctr "phyless/backend/internal/docker/container"
)

const (
	RoleLabel         = "phyless.role"
	RoleValue         = "image-fs"
	ImageLabel        = "phyless.image"
	maxIndexEntries   = 100_000
	maxIndexNameBytes = 16 << 20
	maxIndexBytes     = 128 << 20
)

// IsHelper reports whether a container's labels mark it as an imagefs helper,
// so listings can hide it.
func IsHelper(labels map[string]string) bool { return labels[RoleLabel] == RoleValue }

type session struct {
	key         string
	removing    bool
	containerID string
	index       *os.File
	owned       bool
	lastUsed    time.Time
	inflight    int
	ready       chan struct{} // closed when the build finished
	err         error
}

type Manager struct {
	cli client.APIClient

	mu       sync.Mutex // guards sessions and session state, held across Docker I/O only during startup cleanup
	sessions map[string]*session

	now    func() time.Time
	idle   time.Duration
	tick   time.Duration
	closed bool
	max    int // LRU cap on open disk indexes and helper containers
}

func New(cli client.APIClient) *Manager {
	return &Manager{
		cli:      cli,
		sessions: map[string]*session{},
		now:      time.Now,
		idle:     3 * time.Minute,
		tick:     time.Minute,
		max:      4,
	}
}

// List returns the direct children of path inside the image.
func (m *Manager) List(ctx context.Context, imageID, p string) ([]ctr.FileEntry, error) {
	s, err := m.session(ctx, imageID)
	if err != nil {
		return nil, err
	}
	defer m.done(s)
	return m.list(ctx, s, p)
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
	defer m.done(s)
	return m.list(ctx, s, p)
}

func (m *Manager) list(ctx context.Context, s *session, p string) ([]ctr.FileEntry, error) {
	// The caller pins s; independent SectionReaders avoid a global lock during disk I/O.
	return listIndex(ctx, s.index, normPath(p))
}

// Open streams one path out of the image as a tar archive. The session is
// pinned against GC until the returned reader is closed.
func (m *Manager) Open(ctx context.Context, imageID, p string) (io.ReadCloser, error) {
	s, err := m.session(ctx, imageID)
	if err != nil {
		return nil, err
	}
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
	if s != nil {
		if s.inflight > 0 || s.removing {
			m.mu.Unlock()
			return fmt.Errorf("filesystem is in use; retry after the current operation")
		}
		s.removing = true
		m.mu.Unlock()
		return m.discard(ctx, s)
	}
	// Reserve the key during the fallback lookup as well.
	s = &session{key: key, removing: true}
	m.sessions[key] = s
	m.mu.Unlock()
	defer func() { m.mu.Lock(); delete(m.sessions, key); m.mu.Unlock() }()
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
			m.mu.Lock()
			m.closed = true
			for _, s := range m.sessions {
				if s.inflight == 0 && s.index != nil {
					_ = s.index.Close()
				}
			}
			m.mu.Unlock()
			return
		case <-t.C:
			m.gc(ctx)
		}
	}
}

func (m *Manager) cleanup(ctx context.Context) {
	// Startup only: never race a new build or remove an already acquired helper.
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) != 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
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
		if s.inflight == 0 && !s.removing && now.Sub(s.lastUsed) > m.idle {
			s.removing = true
			stale[id] = s
		}
	}
	m.mu.Unlock()
	for _, s := range stale {
		_ = m.discard(ctx, s)
	}
}

// Keep a retiring session reserved until Docker confirms removal, so a new
// request cannot reuse a helper that GC is about to delete.
func (m *Manager) discard(ctx context.Context, s *session) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var err error
	if s.owned {
		err = m.remove(ctx, s.containerID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[s.key] == s {
		if err == nil {
			delete(m.sessions, s.key)
			if s.index != nil {
				_ = s.index.Close()
			}
		} else {
			s.removing = false
		}
	}
	return err
}

func (m *Manager) remove(ctx context.Context, containerID string) error {
	err := m.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true, RemoveVolumes: true})
	if errdefs.IsNotFound(err) {
		return nil
	}
	return err
}

// session returns the ready session for an image, building it if needed.
// Concurrent callers for the same image share one build; a failed build is
// dropped so the next call retries.
func (m *Manager) session(ctx context.Context, imageID string) (*session, error) {
	id, err := m.resolve(ctx, imageID)
	if err != nil {
		return nil, err
	}
	return m.cached(ctx, "image:"+id, true, func() (string, *os.File, error) {
		return m.build(ctx, id)
	})
}

func (m *Manager) containerSession(ctx context.Context, containerID string) (*session, error) {
	return m.cached(ctx, "container:"+containerID, false, func() (string, *os.File, error) {
		rc, _, err := m.cli.CopyFromContainer(ctx, containerID, "/")
		if err != nil {
			return "", nil, err
		}
		defer rc.Close()
		index, err := buildIndex(rc)
		return containerID, index, err
	})
}

func (m *Manager) cached(ctx context.Context, key string, owned bool, build func() (string, *os.File, error)) (*session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, fmt.Errorf("filesystem manager is closed")
	}
	if s := m.sessions[key]; s != nil {
		if s.removing {
			m.mu.Unlock()
			return nil, fmt.Errorf("filesystem is being released; retry shortly")
		}
		s.inflight++
		s.lastUsed = m.now()
		m.mu.Unlock()
		select {
		case <-s.ready:
			if s.err != nil {
				m.done(s)
			}
			return s, s.err
		case <-ctx.Done():
			m.done(s)
			return nil, ctx.Err()
		}
	}
	if evict := m.evictLocked(); evict != nil {
		m.mu.Unlock()
		if err := m.discard(ctx, evict); err != nil {
			return nil, err
		}
		return m.cached(ctx, key, owned, build)
	}
	if len(m.sessions) >= m.max {
		m.mu.Unlock()
		return nil, fmt.Errorf("filesystem index limit reached; retry after an active operation finishes")
	}
	s := &session{key: key, ready: make(chan struct{}), lastUsed: m.now(), owned: owned, inflight: 1}
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
	if s.err != nil {
		m.done(s)
	}
	return s, s.err
}

// evictLocked reserves the least recently used idle session when the cap is
// reached and returns it so the caller can remove its helper container.
// Caller holds m.mu.
func (m *Manager) evictLocked() *session {
	if len(m.sessions) < m.max {
		return nil
	}
	var victim *session
	for _, s := range m.sessions {
		select {
		case <-s.ready:
		default:
			continue
		}
		if s.inflight == 0 && !s.removing && (victim == nil || s.lastUsed.Before(victim.lastUsed)) {
			victim = s
		}
	}
	if victim != nil {
		victim.removing = true
	}
	return victim
}

func (m *Manager) resolve(ctx context.Context, imageID string) (string, error) {
	info, err := m.cli.ImageInspect(ctx, imageID)
	if err != nil {
		return "", err
	}
	return info.ID, nil
}

func (m *Manager) build(ctx context.Context, id string) (string, *os.File, error) {
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
	indexed := false
	defer func() {
		if !indexed {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			_ = m.remove(cleanup, containerID)
		}
	}()
	rc, err := m.cli.ContainerExport(ctx, containerID)
	if err != nil {
		return "", nil, err
	}
	defer rc.Close()
	index, err := buildIndex(rc)
	if err != nil {
		return "", nil, err
	}
	indexed = true
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
	if m.closed && s.inflight == 0 && s.index != nil {
		_ = s.index.Close()
	}
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

type indexEntry struct {
	Path  string
	Entry ctr.FileEntry
}

// buildIndex retains metadata only. Unlink immediately so crashes and daemon
// switches cannot leave sensitive filesystem metadata or orphan cache files.
func buildIndex(r io.Reader) (_ *os.File, err error) {
	f, err := os.CreateTemp("", "phyless-imagefs-*")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(f.Name()); err != nil {
		f.Close()
		return nil, err
	}
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	writer := bufio.NewWriterSize(f, 64<<10)
	total := 0
	tr := tar.NewReader(r)
	for {
		h, readErr := tr.Next()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
		if len(h.Name) > 4096 || strings.Count(h.Name, "/") > 256 || len(h.Uname) > 4096 {
			return nil, fmt.Errorf("filesystem path metadata is too large")
		}
		name := normPath(h.Name)
		if name == "/" {
			continue
		}
		entry := ctr.FileEntry{Name: path.Base(name), Size: h.Size, Mode: modeString(h),
			IsDir: h.Typeflag == tar.TypeDir, ModTime: h.ModTime.Unix(), Uname: h.Uname, Uid: h.Uid, Gid: h.Gid}
		if h.Typeflag == tar.TypeSymlink {
			entry.Size = 0
		}
		data, err := json.Marshal(indexEntry{Path: name, Entry: entry})
		if err != nil {
			return nil, err
		}
		total += len(data) + 1
		if total > maxIndexBytes {
			return nil, fmt.Errorf("filesystem disk index exceeds %d bytes", maxIndexBytes)
		}
		if _, err := writer.Write(append(data, '\n')); err != nil {
			return nil, err
		}
	}
	if err := writer.Flush(); err != nil {
		return nil, err
	}
	return f, nil
}

func listIndex(ctx context.Context, f *os.File, dir string) ([]ctr.FileEntry, error) {
	// ponytail: sequential local metadata scan; add offsets only if disk scan latency warrants it.
	scanner := bufio.NewScanner(io.NewSectionReader(f, 0, maxIndexBytes))
	scanner.Buffer(make([]byte, 4096), 64<<10)
	entries := []ctr.FileEntry{}
	positions := map[string]int{}
	found := dir == "/"
	prefix := strings.TrimSuffix(dir, "/") + "/"
	nameBytes := 0
	encodedPrefix, _ := json.Marshal(prefix)
	descendant := append([]byte(`{"Path":`), encodedPrefix[:len(encodedPrefix)-1]...)
	encodedDir, _ := json.Marshal(dir)
	exact := append(append([]byte(`{"Path":`), encodedDir...), ',')
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line := scanner.Bytes()
		if !bytes.HasPrefix(line, descendant) && !bytes.HasPrefix(line, exact) {
			continue
		}
		var record indexEntry
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return nil, err
		}
		if record.Path == dir && record.Entry.IsDir {
			found = true
		}
		if !strings.HasPrefix(record.Path, prefix) {
			continue
		}
		found = true
		relative := strings.TrimPrefix(record.Path, prefix)
		entry := record.Entry
		implicit := strings.Contains(relative, "/")
		if implicit {
			entry = ctr.FileEntry{Name: strings.SplitN(relative, "/", 2)[0], Mode: "drwxr-xr-x", IsDir: true}
		}
		if i, ok := positions[entry.Name]; ok {
			if !implicit {
				nameBytes += len(entry.Uname) - len(entries[i].Uname)
				if nameBytes > maxIndexNameBytes {
					return nil, fmt.Errorf("filesystem directory exceeds its name size limit")
				}
				entries[i] = entry
			}
			continue
		}
		nameBytes += len(entry.Name) + len(entry.Uname)
		if len(entries) >= maxIndexEntries || nameBytes > maxIndexNameBytes {
			return nil, fmt.Errorf("filesystem directory exceeds its entry or name size limit")
		}
		positions[entry.Name] = len(entries)
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("目录不存在: %s", dir)
	}
	return entries, nil
}

// modeString formats a header like ls does; fs.FileMode prints 'L' for symlinks.
func modeString(h *tar.Header) string {
	s := h.FileInfo().Mode().String()
	if h.Typeflag == tar.TypeSymlink {
		return "l" + s[1:]
	}
	return s
}
