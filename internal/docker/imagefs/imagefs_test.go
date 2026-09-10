package imagefs

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

const imgID = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

type fakeClient struct {
	client.APIClient
	mu          sync.Mutex
	tar         []byte
	exportErr   error
	exports     int
	creates     int
	createdCfg  *container.Config
	createdHost *container.HostConfig
	createdName string
	existing    []container.Summary
	removed     []string
	copyPath    string
	copyID      string
	exportHook  func()
}

func (c *fakeClient) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{ID: imgID}, nil
}

func (c *fakeClient) ContainerList(_ context.Context, _ container.ListOptions) ([]container.Summary, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.existing, nil
}

func (c *fakeClient) ContainerCreate(_ context.Context, cfg *container.Config, host *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, name string) (container.CreateResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.creates++
	c.createdCfg, c.createdHost, c.createdName = cfg, host, name
	return container.CreateResponse{ID: "helper"}, nil
}

func (c *fakeClient) ContainerExport(_ context.Context, _ string) (io.ReadCloser, error) {
	c.mu.Lock()
	c.exports++
	hook, err := c.exportHook, c.exportErr
	data := c.tar
	c.mu.Unlock()
	if hook != nil {
		hook()
	}
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (c *fakeClient) ContainerRemove(_ context.Context, id string, _ container.RemoveOptions) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.removed = append(c.removed, id)
	return nil
}

func (c *fakeClient) CopyFromContainer(_ context.Context, id, path string) (io.ReadCloser, container.PathStat, error) {
	c.mu.Lock()
	c.copyID = id
	c.copyPath = path
	data := c.tar
	c.mu.Unlock()
	if path == "/" {
		return io.NopCloser(bytes.NewReader(data)), container.PathStat{}, nil
	}
	return io.NopCloser(strings.NewReader("payload")), container.PathStat{}, nil
}

func (c *fakeClient) ContainerStart(context.Context, string, container.StartOptions) error {
	panic("helper container must never be started")
}

type entry struct {
	name string
	typ  byte
	mode int64
	size int64
}

func makeTar(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		h := &tar.Header{
			Name: e.name, Typeflag: e.typ, Mode: e.mode, Size: e.size,
			Uname: "root", Uid: 0, Gid: 0, ModTime: time.Unix(1700000000, 0),
		}
		if e.typ == tar.TypeSymlink {
			h.Linkname = "/target"
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg && e.size > 0 {
			if _, err := tw.Write(bytes.Repeat([]byte("x"), int(e.size))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sampleClient(t *testing.T) *fakeClient {
	return &fakeClient{tar: makeTar(t, []entry{
		{name: "./", typ: tar.TypeDir, mode: 0755},
		{name: "./etc/", typ: tar.TypeDir, mode: 0755},
		{name: "etc/hosts", typ: tar.TypeReg, mode: 0644, size: 3},
		{name: "/usr/local/bin/tool", typ: tar.TypeReg, mode: 0755, size: 5}, // 隐式父目录
		{name: "./bin/sh", typ: tar.TypeSymlink, mode: 0777},
	})}
}

func TestListIndexesTarHeaders(t *testing.T) {
	m := New(sampleClient(t))
	root, err := m.List(context.Background(), imgID, "/")
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range root {
		names[e.Name] = e.IsDir
	}
	if len(root) != 3 || !names["etc"] || !names["usr"] || names["bin"] != true {
		t.Fatalf("root = %+v", root)
	}

	etc, err := m.List(context.Background(), imgID, "etc")
	if err != nil {
		t.Fatal(err)
	}
	if len(etc) != 1 || etc[0].Name != "hosts" || etc[0].Size != 3 || etc[0].Mode != "-rw-r--r--" ||
		etc[0].IsDir || etc[0].Uname != "root" || etc[0].ModTime != 1700000000 {
		t.Fatalf("etc = %+v", etc)
	}

	// 隐式目录：tar 里没有 usr/ 和 usr/local/ 的显式条目
	if usr, err := m.List(context.Background(), imgID, "/usr"); err != nil || len(usr) != 1 || usr[0].Name != "local" || !usr[0].IsDir {
		t.Fatalf("usr = %+v, %v", usr, err)
	}
	if binDir, err := m.List(context.Background(), imgID, "/usr/local/bin"); err != nil || len(binDir) != 1 || binDir[0].Name != "tool" {
		t.Fatalf("usr/local/bin = %+v, %v", binDir, err)
	}

	// symlink 记为文件，size 0
	sh, err := m.List(context.Background(), imgID, "//bin/../bin")
	if err != nil {
		t.Fatal(err)
	}
	if len(sh) != 1 || sh[0].IsDir || sh[0].Size != 0 || !strings.HasPrefix(sh[0].Mode, "l") {
		t.Fatalf("bin = %+v", sh)
	}

	if _, err := m.List(context.Background(), imgID, "/nope"); err == nil {
		t.Fatal("unknown dir must error")
	}
}

func TestListReturnsCopy(t *testing.T) {
	m := New(sampleClient(t))
	first, err := m.List(context.Background(), imgID, "/etc")
	if err != nil {
		t.Fatal(err)
	}
	first[0].Name = "mutated"
	second, _ := m.List(context.Background(), imgID, "/etc")
	if second[0].Name != "hosts" {
		t.Fatalf("index was mutated by caller: %+v", second)
	}
}

func TestListContainerUsesArchiveWithoutCreatingAHelper(t *testing.T) {
	c := sampleClient(t)
	m := New(c)
	root, err := m.ListContainer(context.Background(), "stopped", "/")
	if err != nil || len(root) != 3 {
		t.Fatalf("root=%+v err=%v", root, err)
	}
	if c.copyID != "stopped" || c.copyPath != "/" || c.creates != 0 || c.exports != 0 {
		t.Fatalf("copy=%s:%s creates=%d exports=%d", c.copyID, c.copyPath, c.creates, c.exports)
	}
	now := time.Now()
	m.now = func() time.Time { return now.Add(time.Hour) }
	m.gc(context.Background())
	if len(c.removed) != 0 {
		t.Fatalf("stopped container was removed: %v", c.removed)
	}
}

func TestCreatesHelperOnceAndNeverStarts(t *testing.T) {
	c := sampleClient(t)
	m := New(c)
	release := make(chan struct{})
	c.exportHook = func() { <-release }

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.List(context.Background(), "some/tag:latest", "/etc")
			errs <- err
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if c.creates != 1 || c.exports != 1 {
		t.Fatalf("creates=%d exports=%d, want one shared build", c.creates, c.exports)
	}
	if c.createdCfg.Image != imgID || c.createdCfg.Cmd[0] != "/" || !IsHelper(c.createdCfg.Labels) ||
		c.createdCfg.Labels[ImageLabel] != imgID || c.createdHost.NetworkMode != "none" ||
		c.createdName != "phyless-imgfs-abcdef012345" {
		t.Fatalf("helper config = %+v %+v %q", c.createdCfg, c.createdHost, c.createdName)
	}
}

func TestReusesExistingLabeledContainer(t *testing.T) {
	c := sampleClient(t)
	c.existing = []container.Summary{{ID: "leftover"}}
	m := New(c)
	if _, err := m.List(context.Background(), imgID, "/"); err != nil {
		t.Fatal(err)
	}
	if c.creates != 0 {
		t.Fatalf("creates = %d, want reuse of leftover container", c.creates)
	}
	if _, err := m.Open(context.Background(), imgID, "/etc/hosts"); err != nil {
		t.Fatal(err)
	}
}

func TestFailedBuildDoesNotPoisonLaterCalls(t *testing.T) {
	c := sampleClient(t)
	c.exportErr = errors.New("boom")
	m := New(c)
	if _, err := m.List(context.Background(), imgID, "/"); err == nil {
		t.Fatal("expected export failure")
	}
	c.exportErr = nil
	if _, err := m.List(context.Background(), imgID, "/etc"); err != nil {
		t.Fatalf("retry after failed build: %v", err)
	}
	if c.exports != 2 {
		t.Fatalf("exports = %d, want a retry", c.exports)
	}
}

func TestGCRemovesIdleButNotInflight(t *testing.T) {
	c := sampleClient(t)
	m := New(c)
	now := time.Unix(0, 0)
	m.now = func() time.Time { return now }

	rc, err := m.Open(context.Background(), imgID, "/etc/hosts")
	if err != nil {
		t.Fatal(err)
	}
	if c.copyPath != "/etc/hosts" {
		t.Fatalf("copy path = %q", c.copyPath)
	}
	now = now.Add(time.Hour)
	m.gc(context.Background())
	if len(c.removed) != 0 {
		t.Fatalf("session with an open reader was collected: %v", c.removed)
	}
	if body, _ := io.ReadAll(rc); string(body) != "payload" {
		t.Fatalf("body = %q", body)
	}
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
	m.gc(context.Background())
	if len(c.removed) != 0 {
		t.Fatalf("close refreshes lastUsed: %v", c.removed)
	}
	now = now.Add(time.Hour)
	m.gc(context.Background())
	if len(c.removed) != 1 || c.removed[0] != "helper" {
		t.Fatalf("removed = %v", c.removed)
	}
	if _, err := m.List(context.Background(), imgID, "/"); err != nil {
		t.Fatal(err)
	}
	if c.exports != 2 {
		t.Fatalf("session was not dropped after GC: exports=%d", c.exports)
	}
}

func TestRunCleansLeftoversAndStops(t *testing.T) {
	c := sampleClient(t)
	c.existing = []container.Summary{{ID: "old1"}, {ID: "old2"}}
	m := New(c)
	m.tick = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.removed) != 2 || c.removed[0] != "old1" || c.removed[1] != "old2" {
		t.Fatalf("startup cleanup removed = %v", c.removed)
	}
}

func TestRelease(t *testing.T) {
	c := sampleClient(t)
	m := New(c)
	if _, err := m.List(context.Background(), imgID, "/"); err != nil {
		t.Fatal(err)
	}
	if err := m.Release(context.Background(), imgID); err != nil {
		t.Fatal(err)
	}
	if len(c.removed) != 1 || c.removed[0] != "helper" {
		t.Fatalf("removed = %v", c.removed)
	}
	// 无会话时按 label 兜底
	c.removed = nil
	c.existing = []container.Summary{{ID: "leftover"}}
	if err := m.Release(context.Background(), imgID); err != nil {
		t.Fatal(err)
	}
	if len(c.removed) != 1 || c.removed[0] != "leftover" {
		t.Fatalf("label fallback removed = %v", c.removed)
	}
	// 什么都没有时也不报错
	c.removed, c.existing = nil, nil
	if err := m.Release(context.Background(), imgID); err != nil || len(c.removed) != 0 {
		t.Fatalf("release with nothing to do: %v %v", err, c.removed)
	}
}

func TestEvictsLeastRecentlyUsedAtCap(t *testing.T) {
	c := sampleClient(t)
	m := New(c)
	m.max = 2
	now := time.Unix(0, 0)
	m.now = func() time.Time { return now }
	for _, id := range []string{"c1", "c2"} {
		if _, err := m.ListContainer(context.Background(), id, "/"); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Minute)
	}
	// c1 is the oldest; a third session must push it out (containers are not owned, so no removal).
	if _, err := m.ListContainer(context.Background(), "c3", "/"); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	_, hasC1 := m.sessions["container:c1"]
	_, hasC2 := m.sessions["container:c2"]
	_, hasC3 := m.sessions["container:c3"]
	n := len(m.sessions)
	m.mu.Unlock()
	if hasC1 || !hasC2 || !hasC3 || n != 2 {
		t.Fatalf("sessions after eviction: c1=%v c2=%v c3=%v n=%d", hasC1, hasC2, hasC3, n)
	}
}
