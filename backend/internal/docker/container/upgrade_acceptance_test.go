package container

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	phyDocker "phyless/backend/internal/docker"
)

// Opt-in: pulls a base image and creates uniquely labelled temporary images and
// containers. It never prunes or removes the base image, which may predate the test.
func TestUpgradeRealAcceptance(t *testing.T) {
	if os.Getenv("PHYLESS_UPGRADE_ACCEPTANCE") != "1" {
		t.Skip("set PHYLESS_UPGRADE_ACCEPTANCE=1 to run Docker acceptance")
	}
	cli, meter := meteredAcceptanceClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if _, err := cli.Info(ctx, client.InfoOptions{}); err != nil {
		t.Fatal("Docker daemon is unavailable:", err)
	}
	var before, after syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &before); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	defer func() {
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &after); err != nil {
			t.Error(err)
			return
		}
		cpu := func(r syscall.Rusage) float64 {
			return float64(r.Utime.Sec+r.Stime.Sec) + float64(r.Utime.Usec+r.Stime.Usec)/1e6
		}
		rss := after.Maxrss
		if runtime.GOOS != "darwin" {
			rss *= 1024
		}
		t.Logf("scope=test_process elapsed=%s cpu_seconds=%.3f process_peak_rss_bytes=%d docker_requests=%d docker_request_body_bytes=%d docker_response_body_bytes=%d", time.Since(started), cpu(after)-cpu(before), rss, meter.calls.Load(), meter.sent.Load(), meter.received.Load())
	}()
	fixture := fmt.Sprintf("phyless-acceptance-%d", time.Now().UnixNano())
	ref := fixture + ":current"
	var images []string
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 45*time.Second)
		defer stop()
		cs, err := cli.ContainerList(cleanup, client.ContainerListOptions{All: true, Filters: make(client.Filters).Add("label", "phyless.acceptance="+fixture)})
		if err != nil {
			t.Error("list fixture containers:", err)
			return
		}
		for _, c := range cs.Items {
			if _, err := cli.ContainerRemove(cleanup, c.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !cerrdefs.IsNotFound(err) {
				t.Error(err)
			}
		}
		for _, id := range append([]string{ref}, images...) {
			if _, err := cli.ImageRemove(cleanup, id, client.ImageRemoveOptions{PruneChildren: false}); err != nil && !cerrdefs.IsNotFound(err) {
				t.Error(err)
			}
		}
	})
	base := os.Getenv("PHYLESS_ACCEPTANCE_IMAGE")
	if base == "" {
		base = "busybox@sha256:fd8d9aa63ba2f0982b5304e1ee8d3b90a210bc1ffb5314d980eb6962f1a9715d"
	}
	pull, err := cli.ImagePull(ctx, base, client.ImagePullOptions{})
	if err != nil {
		t.Fatal("pull fixture base:", err)
	}
	if err := phyDocker.ConsumeProgress(ctx, io.Discard, pull); err != nil {
		t.Fatal(err)
	}
	labels := map[string]string{"phyless.acceptance": fixture}
	seed, err := cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: fixture + "-seed", Config: &container.Config{Image: base, Labels: labels}, HostConfig: &container.HostConfig{NetworkMode: "none"}})
	if err != nil {
		t.Fatal(err)
	}
	makeImage := func(version string, cmd []string) string {
		t.Helper()
		committed, err := cli.ContainerCommit(ctx, seed.ID, client.ContainerCommitOptions{Config: &container.Config{
			Cmd: cmd, Labels: map[string]string{"phyless.acceptance": fixture, "phyless.version": version},
		}})
		if err != nil {
			t.Fatal(err)
		}
		images = append(images, committed.ID)
		return committed.ID
	}
	oldImage := makeImage("old", []string{"sh", "-c", "sleep 600"})
	newImage := makeImage("new", []string{"sh", "-c", "sleep 600"})
	badImage := makeImage("bad", []string{"/phyless-acceptance-nonexistent"})
	if _, err := cli.ImageTag(ctx, client.ImageTagOptions{Source: oldImage, Target: ref}); err != nil {
		t.Fatal(err)
	}
	original, err := cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: fixture, Config: &container.Config{Image: ref, Labels: labels}, HostConfig: &container.HostConfig{NetworkMode: "none"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cli.ContainerStart(ctx, original.ID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := cli.ImageTag(ctx, client.ImageTagOptions{Source: newImage, Target: ref}); err != nil {
		t.Fatal(err)
	}
	replacement, err := UpgradeWithoutPull(ctx, cli, original.ID, io.Discard, UpgradeOptions{})
	if err != nil {
		t.Fatal("upgrade:", err)
	}
	currentRes, err := cli.ContainerInspect(ctx, replacement, client.ContainerInspectOptions{})
	current := currentRes.Container
	if err != nil || current.State == nil || !current.State.Running || current.Image != newImage || strings.TrimPrefix(current.Name, "/") != fixture {
		t.Fatalf("upgrade state=%+v err=%v", current, err)
	}
	if _, err := cli.ContainerInspect(ctx, original.ID, client.ContainerInspectOptions{}); !cerrdefs.IsNotFound(err) {
		t.Fatalf("old container not removed: %v", err)
	}
	if _, err := cli.ImageTag(ctx, client.ImageTagOptions{Source: badImage, Target: ref}); err != nil {
		t.Fatal(err)
	}
	if _, err := UpgradeWithoutPull(ctx, cli, replacement, io.Discard, UpgradeOptions{}); err == nil {
		t.Fatal("expected invalid replacement startup to fail")
	}
	restoredRes, err := cli.ContainerInspect(ctx, replacement, client.ContainerInspectOptions{})
	restored := restoredRes.Container
	if err != nil || restored.State == nil || !restored.State.Running || restored.Image != newImage || strings.TrimPrefix(restored.Name, "/") != fixture {
		t.Fatalf("rollback state=%+v err=%v", restored, err)
	}
}

type acceptanceTransport struct {
	base                  http.RoundTripper
	calls, sent, received atomic.Int64
}

func (m *acceptanceTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	m.calls.Add(1)
	if r.Body != nil {
		r = r.Clone(r.Context())
		r.Body = &acceptanceReader{ReadCloser: r.Body, bytes: &m.sent}
	}
	response, err := m.base.RoundTrip(r)
	if response != nil && response.Body != nil {
		response.Body = &acceptanceReader{ReadCloser: response.Body, bytes: &m.received}
	}
	return response, err
}

type acceptanceReader struct {
	io.ReadCloser
	bytes *atomic.Int64
}

func (r *acceptanceReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	r.bytes.Add(int64(n))
	return n, err
}

// meteredAcceptanceClient talks to the daemon from the environment through a
// metering transport. The SDK no longer exposes or rewraps a client's HTTP
// client, so a probe client resolves host/TLS and supplies the dialer.
func meteredAcceptanceClient(t *testing.T) (*client.Client, *acceptanceTransport) {
	t.Helper()
	probe, err := client.New(client.FromEnv)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { probe.Close() })
	dial := probe.Dialer()
	meter := &acceptanceTransport{base: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) }}}
	cli, err := client.New(client.WithHTTPClient(&http.Client{Transport: meter}), client.WithAPIVersionFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cli.Close() })
	return cli, meter
}

func TestAcceptanceMeterCountsTransferredBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		io.WriteString(w, "response")
	}))
	defer server.Close()
	meter := &acceptanceTransport{base: http.DefaultTransport}
	response, err := (&http.Client{Transport: meter}).Post(server.URL, "text/plain", strings.NewReader("request"))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if meter.calls.Load() != 1 || meter.sent.Load() != 7 || meter.received.Load() != 8 {
		t.Fatalf("calls=%d sent=%d received=%d", meter.calls.Load(), meter.sent.Load(), meter.received.Load())
	}
}
