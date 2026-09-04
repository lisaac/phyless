package docker

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

// TestImagePullProxyAcceptance is opt-in because it mutates a real Docker
// daemon. It starts both registry and HTTP-proxy fixtures in this process,
// generates a unique codex-* tag, checks that a direct daemon pull cannot
// reach the process-local registry, then verifies the proxy ImageLoad path.
// Set PHYLESS_IMAGE_PULL_ACCEPTANCE=1. PHYLESS_PROXY_TEST_PAYLOAD_BYTES may
// select a larger generated layer; its default is deliberately small.
func TestImagePullProxyAcceptance(t *testing.T) {
	if os.Getenv("PHYLESS_IMAGE_PULL_ACCEPTANCE") != "1" {
		t.Skip("set PHYLESS_IMAGE_PULL_ACCEPTANCE=1 to run Docker acceptance")
	}

	payloadSize := int64(1 << 20)
	if raw := strings.TrimSpace(os.Getenv("PHYLESS_PROXY_TEST_PAYLOAD_BYTES")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			t.Fatal("invalid PHYLESS_PROXY_TEST_PAYLOAD_BYTES")
		}
		payloadSize = parsed
	}
	layer, err := newGeneratedAcceptanceLayer(payloadSize)
	if err != nil {
		t.Fatal("generate acceptance layer:", err)
	}
	img, _ := newStaticTestImage(t, layer)

	var registryLayerBytes atomic.Int64
	registryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveAcceptanceRegistry(w, r, img, layer, &registryLayerBytes)
	}))
	proxyServer := newAcceptanceProxy(t, registryServer.URL)
	defer proxyServer.Close()
	defer registryServer.Close()

	ref, tag, err := acceptanceTag(registryServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	rawClient, err := dockerclient.NewClientWithOpts(dockerclient.FromEnv, dockerclient.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal("create Docker client:", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// Remove exactly the generated tag. Do not force-remove or prune
		// children, so the fixture cannot delete an unrelated image.
		if _, err := rawClient.ImageRemove(cleanupCtx, ref, image.RemoveOptions{Force: false, PruneChildren: false}); err != nil && !errdefs.IsNotFound(err) {
			t.Errorf("remove generated image tag: %v", err)
		}
		if err := rawClient.Close(); err != nil {
			t.Errorf("close Docker client: %v", err)
		}
	})
	infoCtx, infoCancel := context.WithTimeout(context.Background(), 30*time.Second)
	info, err := rawClient.Info(infoCtx)
	infoCancel()
	if err != nil {
		t.Fatal("inspect Docker daemon:", err)
	}
	t.Logf("acceptance daemon=%s os=%s arch=%s driver=%s payload_bytes=%d compressed_blob_bytes=%d registry_layer_bytes=%d", info.ServerVersion, info.OSType, info.Architecture, info.Driver, layer.payloadSize, layer.compressedSize, registryLayerBytes.Load())

	// The registry listens on the test process's loopback interface. In the
	// acceptance container the daemon is outside that network namespace, so a
	// native pull must fail; this guards against accidentally bypassing proxy.
	nativeCtx, nativeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	nativeStream, nativeErr := rawClient.ImagePull(nativeCtx, ref, image.PullOptions{})
	if nativeErr == nil {
		if nativeStream == nil {
			nativeErr = errors.New("native ImagePull returned no stream")
		} else {
			nativeErr = ConsumeProgress(nativeCtx, io.Discard, nativeStream)
		}
	} else if nativeStream != nil {
		_ = nativeStream.Close()
	}
	nativeCancel()
	if nativeErr == nil {
		t.Fatal("native ImagePull unexpectedly reached process-local registry")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	ctx, err = WithPullProxy(ctx, proxyServer.URL)
	if err != nil {
		t.Fatal("configure pull proxy:", err)
	}
	stream, err := (&Client{APIClient: rawClient}).ImagePull(ctx, ref, image.PullOptions{Platform: os.Getenv("PHYLESS_PROXY_TEST_PLATFORM")})
	if err != nil {
		t.Fatal("proxied ImagePull:", err)
	}
	if err := ConsumeProgress(ctx, io.Discard, stream); err != nil {
		t.Fatal("proxied ImagePull progress:", err)
	}

	loaded, err := rawClient.ImageInspect(ctx, ref)
	if err != nil {
		t.Fatal("inspect imported image:", err)
	}
	if loaded.ID == "" {
		t.Fatal("imported image has no config ID")
	}
	if !hasLoadedTag(loaded.RepoTags, tag) {
		t.Fatalf("imported image is missing generated tag %q", ref)
	}
	if registryLayerBytes.Load() < layer.compressedSize {
		t.Fatalf("registry streamed %d layer bytes, want at least %d", registryLayerBytes.Load(), layer.compressedSize)
	}
	t.Logf("acceptance loaded_id=%s tag=%s registry_layer_bytes=%d", loaded.ID, ref, registryLayerBytes.Load())
}

func acceptanceTag(registryURL string) (string, name.Tag, error) {
	host := strings.TrimPrefix(registryURL, "http://")
	identifier := "codex-" + strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
	tag, err := name.NewTag(host + "/fixture/image:" + identifier)
	if err != nil {
		return "", name.Tag{}, err
	}
	return tag.String(), tag, nil
}

type generatedAcceptanceLayer struct {
	payloadSize    int64
	compressedSize int64
	digest         v1.Hash
	diffID         v1.Hash
}

func newGeneratedAcceptanceLayer(payloadSize int64) (*generatedAcceptanceLayer, error) {
	diffID, _, err := digestGeneratedLayer(payloadSize, false)
	if err != nil {
		return nil, err
	}
	digest, compressedSize, err := digestGeneratedLayer(payloadSize, true)
	if err != nil {
		return nil, err
	}
	return &generatedAcceptanceLayer{payloadSize: payloadSize, compressedSize: compressedSize, digest: digest, diffID: diffID}, nil
}

func (l *generatedAcceptanceLayer) Digest() (v1.Hash, error) { return l.digest, nil }
func (l *generatedAcceptanceLayer) DiffID() (v1.Hash, error) { return l.diffID, nil }
func (l *generatedAcceptanceLayer) Size() (int64, error)     { return l.compressedSize, nil }
func (l *generatedAcceptanceLayer) MediaType() (types.MediaType, error) {
	return types.DockerLayer, nil
}
func (l *generatedAcceptanceLayer) Compressed() (io.ReadCloser, error) {
	return l.generatedReader(true), nil
}
func (l *generatedAcceptanceLayer) Uncompressed() (io.ReadCloser, error) {
	return l.generatedReader(false), nil
}

func (l *generatedAcceptanceLayer) generatedReader(compressed bool) io.ReadCloser {
	reader, writer := io.Pipe()
	go func() {
		var dst io.Writer = writer
		var compressedWriter *gzip.Writer
		if compressed {
			compressedWriter = gzip.NewWriter(writer)
			dst = compressedWriter
		}
		err := writeGeneratedLayer(dst, l.payloadSize)
		if compressedWriter != nil {
			if closeErr := compressedWriter.Close(); err == nil {
				err = closeErr
			}
		}
		if err != nil {
			_ = writer.CloseWithError(err)
		} else {
			_ = writer.Close()
		}
	}()
	return reader
}

func digestGeneratedLayer(payloadSize int64, compressed bool) (v1.Hash, int64, error) {
	hash := sha256.New()
	counted := &acceptanceCountWriter{writer: hash}
	var dst io.Writer = counted
	var compressedWriter *gzip.Writer
	if compressed {
		compressedWriter = gzip.NewWriter(counted)
		dst = compressedWriter
	}
	err := writeGeneratedLayer(dst, payloadSize)
	if compressedWriter != nil {
		if closeErr := compressedWriter.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		return v1.Hash{}, 0, err
	}
	return v1.Hash{Algorithm: "sha256", Hex: hex.EncodeToString(hash.Sum(nil))}, counted.n, nil
}

func writeGeneratedLayer(dst io.Writer, payloadSize int64) error {
	writer := tar.NewWriter(dst)
	if err := writer.WriteHeader(&tar.Header{Name: "payload.bin", Mode: 0600, Size: payloadSize}); err != nil {
		return err
	}
	if _, err := io.Copy(writer, &acceptancePatternReader{remaining: payloadSize, state: 0x9e3779b97f4a7c15}); err != nil {
		return err
	}
	return writer.Close()
}

type acceptancePatternReader struct {
	remaining int64
	state     uint64
}

func (r *acceptancePatternReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	for i := range p {
		r.state ^= r.state << 7
		r.state ^= r.state >> 9
		r.state ^= r.state << 8
		p[i] = byte(r.state >> 56)
	}
	r.remaining -= int64(len(p))
	return len(p), nil
}

type acceptanceCountWriter struct {
	writer io.Writer
	n      int64
}

func (w *acceptanceCountWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.n += int64(n)
	return n, err
}

func serveAcceptanceRegistry(w http.ResponseWriter, r *http.Request, img *staticTestImage, layer *generatedAcceptanceLayer, layerBytes *atomic.Int64) {
	if r.URL.Path == "/v2" || r.URL.Path == "/v2/" {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		w.WriteHeader(http.StatusOK)
		return
	}
	if idx := strings.Index(r.URL.Path, "/manifests/"); idx >= 0 {
		w.Header().Set("Content-Type", string(img.manifest.MediaType))
		w.Header().Set("Content-Length", strconv.Itoa(len(img.rawManifest)))
		if r.Method != http.MethodHead {
			_, _ = w.Write(img.rawManifest)
		}
		return
	}
	if idx := strings.Index(r.URL.Path, "/blobs/"); idx >= 0 {
		digest := r.URL.Path[idx+len("/blobs/"):]
		switch digest {
		case img.configHash.String():
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", strconv.Itoa(len(img.config)))
			if r.Method != http.MethodHead {
				_, _ = w.Write(img.config)
			}
			return
		case layer.digest.String():
			w.Header().Set("Content-Type", string(types.DockerLayer))
			w.Header().Set("Content-Length", strconv.FormatInt(layer.compressedSize, 10))
			if r.Method != http.MethodHead {
				_ = streamGeneratedLayer(w, layer, layerBytes)
			}
			return
		}
	}
	http.NotFound(w, r)
}

func streamGeneratedLayer(w http.ResponseWriter, layer *generatedAcceptanceLayer, layerBytes *atomic.Int64) error {
	var dst io.Writer = w
	if flusher, ok := w.(http.Flusher); ok {
		dst = &acceptanceFlushWriter{writer: w, flush: flusher.Flush, count: layerBytes}
	} else if layerBytes != nil {
		dst = &acceptanceByteCountWriter{writer: w, count: layerBytes}
	}
	compressed := gzip.NewWriter(dst)
	err := writeGeneratedLayer(compressed, layer.payloadSize)
	if closeErr := compressed.Close(); err == nil {
		err = closeErr
	}
	return err
}

type acceptanceFlushWriter struct {
	writer io.Writer
	flush  func()
	count  *atomic.Int64
}

type acceptanceByteCountWriter struct {
	writer io.Writer
	count  *atomic.Int64
}

func (w *acceptanceByteCountWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.count.Add(int64(n))
	return n, err
}

func (w *acceptanceFlushWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	if w.count != nil {
		w.count.Add(int64(n))
	}
	if n > 0 {
		w.flush()
	}
	return n, err
}

func newAcceptanceProxy(t *testing.T, registryURL string) *httptest.Server {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{}}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			http.Error(w, "CONNECT is not used by this HTTP fixture", http.StatusNotImplemented)
			return
		}
		target := registryURL + r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		request, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
		if err != nil {
			http.Error(w, "proxy request failed", http.StatusBadGateway)
			return
		}
		request.Host = r.Host
		for key, values := range r.Header {
			for _, value := range values {
				request.Header.Add(key, value)
			}
		}
		response, err := client.Do(request)
		if err != nil {
			http.Error(w, "proxy request failed", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for key, values := range response.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.CopyBuffer(w, response.Body, make([]byte, 32<<10))
	}))
}
