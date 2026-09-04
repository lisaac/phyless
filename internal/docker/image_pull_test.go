package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

type pipelineAPIClient struct {
	dockerclient.APIClient
	load    func(context.Context, io.Reader) (image.LoadResponse, error)
	pull    func(context.Context, string, image.PullOptions) (io.ReadCloser, error)
	inspect func(context.Context, string) (image.InspectResponse, error)
}

func (c *pipelineAPIClient) ImageLoad(ctx context.Context, input io.Reader, _ ...dockerclient.ImageLoadOption) (image.LoadResponse, error) {
	return c.load(ctx, input)
}

func (c *pipelineAPIClient) ImagePull(ctx context.Context, ref string, options image.PullOptions) (io.ReadCloser, error) {
	if c.pull == nil {
		return nil, errors.New("test native ImagePull was not configured")
	}
	return c.pull(ctx, ref, options)
}

func (c *pipelineAPIClient) ImageInspect(ctx context.Context, ref string, _ ...dockerclient.ImageInspectOption) (image.InspectResponse, error) {
	if c.inspect == nil {
		return image.InspectResponse{}, errors.New("test ImageInspect was not configured")
	}
	return c.inspect(ctx, ref)
}

type staticTestImage struct {
	config       []byte
	configHash   v1.Hash
	manifest     *v1.Manifest
	rawManifest  []byte
	manifestHash v1.Hash
	layer        v1.Layer
}

func newStaticTestImage(t *testing.T, layer v1.Layer) (*staticTestImage, v1.Hash) {
	t.Helper()
	cfg := &v1.ConfigFile{
		Architecture: "amd64",
		OS:           "linux",
		RootFS:       v1.RootFS{Type: "layers"},
	}
	if layer != nil {
		diffID, err := layer.DiffID()
		if err != nil {
			t.Fatal(err)
		}
		cfg.RootFS.DiffIDs = []v1.Hash{diffID}
	}
	rawConfig, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	configHash, _, err := v1.SHA256(bytes.NewReader(rawConfig))
	if err != nil {
		t.Fatal(err)
	}
	manifest := &v1.Manifest{
		SchemaVersion: 2,
		MediaType:     types.DockerManifestSchema2,
		Config: v1.Descriptor{
			MediaType: types.DockerConfigJSON,
			Size:      int64(len(rawConfig)),
			Digest:    configHash,
		},
	}
	if layer != nil {
		digest, err := layer.Digest()
		if err != nil {
			t.Fatal(err)
		}
		size, err := layer.Size()
		if err != nil {
			t.Fatal(err)
		}
		mediaType, err := layer.MediaType()
		if err != nil {
			t.Fatal(err)
		}
		manifest.Layers = []v1.Descriptor{{MediaType: mediaType, Size: size, Digest: digest}}
	}
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestHash, _, err := v1.SHA256(bytes.NewReader(rawManifest))
	if err != nil {
		t.Fatal(err)
	}
	return &staticTestImage{
		config:       rawConfig,
		configHash:   configHash,
		manifest:     manifest,
		rawManifest:  rawManifest,
		manifestHash: manifestHash,
		layer:        layer,
	}, configHash
}

func (i *staticTestImage) Layers() ([]v1.Layer, error) {
	if i.layer == nil {
		return nil, nil
	}
	return []v1.Layer{i.layer}, nil
}

func (i *staticTestImage) MediaType() (types.MediaType, error) { return i.manifest.MediaType, nil }
func (i *staticTestImage) Size() (int64, error)                { return int64(len(i.rawManifest)), nil }
func (i *staticTestImage) ConfigName() (v1.Hash, error)        { return i.configHash, nil }

func (i *staticTestImage) ConfigFile() (*v1.ConfigFile, error) {
	return v1.ParseConfigFile(bytes.NewReader(i.config))
}

func (i *staticTestImage) RawConfigFile() ([]byte, error) {
	return append([]byte(nil), i.config...), nil
}
func (i *staticTestImage) Digest() (v1.Hash, error)        { return i.manifestHash, nil }
func (i *staticTestImage) Manifest() (*v1.Manifest, error) { return i.manifest, nil }
func (i *staticTestImage) RawManifest() ([]byte, error) {
	return append([]byte(nil), i.rawManifest...), nil
}

func (i *staticTestImage) LayerByDigest(want v1.Hash) (v1.Layer, error) {
	if i.layer != nil {
		digest, _ := i.layer.Digest()
		if digest == want {
			return i.layer, nil
		}
	}
	return nil, errors.New("test layer not found")
}

func (i *staticTestImage) LayerByDiffID(want v1.Hash) (v1.Layer, error) {
	if i.layer != nil {
		diffID, _ := i.layer.DiffID()
		if diffID == want {
			return i.layer, nil
		}
	}
	return nil, errors.New("test layer not found")
}

type hangingHTTPTestLayer struct {
	ctx context.Context
	url string

	client  *http.Client
	digest  v1.Hash
	diffID  v1.Hash
	started chan<- struct{}
}

type closeAwareTestLayer struct {
	body   []byte
	digest v1.Hash
	closed bool
}

func newCloseAwareTestLayer(t *testing.T) *closeAwareTestLayer {
	t.Helper()
	body := []byte("compressed layer bytes")
	digest, _, err := v1.SHA256(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return &closeAwareTestLayer{body: body, digest: digest}
}

func (l *closeAwareTestLayer) Digest() (v1.Hash, error) { return l.digest, nil }
func (l *closeAwareTestLayer) DiffID() (v1.Hash, error) { return l.digest, nil }
func (l *closeAwareTestLayer) Size() (int64, error)     { return int64(len(l.body)), nil }
func (l *closeAwareTestLayer) MediaType() (types.MediaType, error) {
	return types.DockerLayer, nil
}
func (l *closeAwareTestLayer) Compressed() (io.ReadCloser, error) {
	return &closeAwareTestReader{Reader: bytes.NewReader(l.body), owner: l}, nil
}
func (l *closeAwareTestLayer) Uncompressed() (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(l.body)), nil
}

type closeAwareTestReader struct {
	io.Reader
	owner *closeAwareTestLayer
}

func (r *closeAwareTestReader) Close() error {
	r.owner.closed = true
	return nil
}

func TestWriteImageTarClosesLayerReaders(t *testing.T) {
	layer := newCloseAwareTestLayer(t)
	img, _ := newStaticTestImage(t, layer)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeImageTar(io.Discard, tag, img); err != nil {
		t.Fatal(err)
	}
	if !layer.closed {
		t.Fatal("tarball writer left the layer reader open")
	}
}

func (l *hangingHTTPTestLayer) Digest() (v1.Hash, error) { return l.digest, nil }
func (l *hangingHTTPTestLayer) DiffID() (v1.Hash, error) { return l.diffID, nil }
func (l *hangingHTTPTestLayer) Size() (int64, error)     { return 1, nil }
func (l *hangingHTTPTestLayer) MediaType() (types.MediaType, error) {
	return types.DockerLayer, nil
}

func (l *hangingHTTPTestLayer) Compressed() (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(l.ctx, http.MethodGet, l.url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func (l *hangingHTTPTestLayer) Uncompressed() (io.ReadCloser, error) {
	return nil, errors.New("uncompressed test layer is unavailable")
}

func TestWithPullProxyAndRedaction(t *testing.T) {
	base := context.Background()
	without, err := WithPullProxy(base, "")
	if err != nil || without != base || HasPullProxy(without) {
		t.Fatalf("empty proxy = (%v, %v), want original context without proxy", without, err)
	}
	ctx, err := WithPullProxy(base, "http://user:password@example.test:3128")
	if err != nil {
		t.Fatal(err)
	}
	if !HasPullProxy(ctx) {
		t.Fatal("proxy context was not marked")
	}

	raw := errors.New(`GET "https://user:password@example.test/v2/repo/blobs?token=dynamic-token" denied`)
	wrapped := safePullError("registry request failed", raw)
	if strings.Contains(wrapped.Error(), "password") || strings.Contains(wrapped.Error(), "dynamic-token") || strings.Contains(wrapped.Error(), "encoded-secret") {
		t.Fatalf("sensitive error was not redacted: %v", wrapped)
	}
	if errors.Unwrap(wrapped) != nil {
		t.Fatal("redacted error must not unwrap its sensitive cause")
	}
}

func TestImagePullWithoutProxyPassesSDKArgumentsUnchanged(t *testing.T) {
	ctx := context.WithValue(context.Background(), struct{}{}, "request")
	privilegeCalled := false
	options := image.PullOptions{
		RegistryAuth: "encoded",
		Platform:     "linux/amd64",
		All:          true,
		PrivilegeFunc: func(_ context.Context) (string, error) {
			privilegeCalled = true
			return "", nil
		},
	}
	called := false
	api := &pipelineAPIClient{pull: func(gotCtx context.Context, gotRef string, gotOptions image.PullOptions) (io.ReadCloser, error) {
		called = true
		if gotCtx != ctx || gotRef != "example.test/repo:tag" || gotOptions.RegistryAuth != options.RegistryAuth || gotOptions.Platform != options.Platform || !gotOptions.All || gotOptions.PrivilegeFunc == nil {
			t.Fatalf("native ImagePull arguments changed: ctx=%v ref=%q options=%+v", gotCtx, gotRef, gotOptions)
		}
		return io.NopCloser(strings.NewReader("ok")), nil
	}}
	rc, err := (&Client{APIClient: api}).ImagePull(ctx, "example.test/repo:tag", options)
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("native ImagePull was not called")
	}
	if _, err := io.ReadAll(rc); err != nil {
		t.Fatal(err)
	}
	if privilegeCalled {
		t.Fatal("native test should not invoke privilege callback")
	}
}

func TestProxyImagePullRejectsDigestReference(t *testing.T) {
	ctx, err := WithPullProxy(context.Background(), "http://proxy.example:3128")
	if err != nil {
		t.Fatal(err)
	}
	api := &pipelineAPIClient{}
	_, err = (&Client{APIClient: api}).ImagePull(ctx, "example.test/repo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", image.PullOptions{Platform: "linux/amd64"})
	if err == nil || !strings.Contains(err.Error(), "requires a tag") {
		t.Fatalf("digest ImagePull error = %v", err)
	}
}

func TestPullProxyRejectsInvalidPorts(t *testing.T) {
	for _, raw := range []string{"http://proxy.example:0", "http://proxy.example:65536", "socks5://proxy.example"} {
		if _, err := WithPullProxy(context.Background(), raw); err == nil {
			t.Errorf("WithPullProxy(%q) accepted invalid port", raw)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestMetadataLimitTransportBoundsJSONResponses(t *testing.T) {
	body := io.NopCloser(strings.NewReader(strings.Repeat("x", maxMetadataSize+1)))
	transport := &metadataLimitTransport{inner: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body, Request: request}, nil
	})}
	response, err := transport.RoundTrip(mustRequest(t, "https://registry.example/token"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(response.Body)
	if !errors.Is(err, errMetadataTooLarge) {
		t.Fatalf("JSON response read error = %v, want metadata limit", err)
	}
}

func TestMetadataLimitTransportBoundsConfigBlobOnly(t *testing.T) {
	configDigest := "sha256:" + strings.Repeat("c", 64)
	body := strings.Repeat("x", maxMetadataSize+1)
	transport := &metadataLimitTransport{
		configDigest: configDigest,
		inner: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/octet-stream"}},
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    request,
			}, nil
		}),
	}
	configResponse, err := transport.RoundTrip(mustRequest(t, "https://registry.example/v2/repo/blobs/"+configDigest))
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(configResponse.Body)
	if !errors.Is(err, errMetadataTooLarge) {
		t.Fatalf("config blob read error = %v, want metadata limit", err)
	}

	layerResponse, err := transport.RoundTrip(mustRequest(t, "https://registry.example/v2/repo/blobs/sha256:"+strings.Repeat("l", 64)))
	if err != nil {
		t.Fatal(err)
	}
	layer, err := io.ReadAll(layerResponse.Body)
	if err != nil {
		t.Fatalf("layer read error = %v, want streaming body", err)
	}
	if len(layer) != len(body) {
		t.Fatalf("layer length = %d, want %d; layer responses must remain unbounded", len(layer), len(body))
	}
}

func TestMetadataLimitTransportBoundsConfigRedirect(t *testing.T) {
	configDigest := "sha256:" + strings.Repeat("d", 64)
	body := strings.Repeat("x", maxMetadataSize+1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/object/config" {
			http.Error(w, "unexpected redirect target", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.WriteString(w, body)
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/repo/blobs/"+configDigest {
			http.Error(w, "unexpected redirect source", http.StatusNotFound)
			return
		}
		http.Redirect(w, r, target.URL+"/object/config", http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("default transport is not configurable")
	}
	inner := base.Clone()
	inner.Proxy = nil
	defer inner.CloseIdleConnections()
	client := &http.Client{Transport: &metadataLimitTransport{inner: inner, configDigest: configDigest}}
	response, err := client.Get(source.URL + "/v2/repo/blobs/" + configDigest)
	if err != nil {
		t.Fatal("config redirect request:", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("config redirect status = %d", response.StatusCode)
	}
	_, err = io.ReadAll(response.Body)
	if !errors.Is(err, errMetadataTooLarge) {
		t.Fatalf("redirected config read error = %v, want metadata limit", err)
	}
}

func mustRequest(t *testing.T, raw string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func TestPullProxyHTTPConnect(t *testing.T) {
	registryServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "through-connect")
	}))
	defer registryServer.Close()
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
			return
		}
		target, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, "dial failed", http.StatusBadGateway)
			return
		}
		clientConn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			_ = target.Close()
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = rw.Flush()
		go func() {
			_, _ = io.Copy(target, clientConn)
			_ = target.Close()
		}()
		_, _ = io.Copy(clientConn, target)
		_ = clientConn.Close()
	}))
	defer proxyServer.Close()

	proxyURL, err := url.Parse(proxyServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport, err := proxyTransport(pullProxyConfig{url: *proxyURL})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	serverTransport, ok := registryServer.Client().Transport.(*http.Transport)
	if !ok || serverTransport.TLSClientConfig == nil {
		t.Fatal("TLS fixture did not expose a client TLS configuration")
	}
	transport.TLSClientConfig = serverTransport.TLSClientConfig.Clone()
	response, err := (&http.Client{Transport: transport}).Get(registryServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "through-connect" {
		t.Fatalf("CONNECT response = %q, err=%v", body, err)
	}
}

func TestPullProxySOCKS5(t *testing.T) {
	registryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "through-socks5")
	}))
	defer registryServer.Close()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go serveTestSOCKS5(listener)
	proxyURL, err := url.Parse("socks5://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	transport, err := proxyTransport(pullProxyConfig{url: *proxyURL})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Get(registryServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "through-socks5" {
		t.Fatalf("SOCKS5 response = %q, err=%v", body, err)
	}
}

func serveTestSOCKS5(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go handleTestSOCKS5(conn)
	}
}

func handleTestSOCKS5(conn net.Conn) {
	defer conn.Close()
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 5 {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		return
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(conn, request); err != nil || request[0] != 5 || request[1] != 1 {
		return
	}
	var host string
	switch request[3] {
	case 1:
		address := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(conn, address); err != nil {
			return
		}
		host = net.IP(address).String()
	case 3:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			return
		}
		address := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, address); err != nil {
			return
		}
		host = string(address)
	case 4:
		address := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(conn, address); err != nil {
			return
		}
		host = net.IP(address).String()
	default:
		return
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBytes); err != nil {
		return
	}
	target, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes)))))
	if err != nil {
		_, _ = conn.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer target.Close()
	if _, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	go func() {
		_, _ = io.Copy(target, conn)
		_ = target.Close()
	}()
	_, _ = io.Copy(conn, target)
}

func TestRedactedPullErrorDoesNotExposeUnderlyingCause(t *testing.T) {
	redacted := safePullError("registry request failed", fmt.Errorf("outer: %w", errors.New("https://proxy.example/path?access_token=secret bearer-secret")))
	if errors.Unwrap(redacted) != nil || strings.Contains(redacted.Error(), "access_token") || strings.Contains(redacted.Error(), "bearer-secret") {
		t.Fatalf("redacted error leaked cause: %v", redacted)
	}
}

func TestValidateRemoteImageChecksPlatformAndConfigDigest(t *testing.T) {
	img, _ := newStaticTestImage(t, nil)
	if _, err := validateRemoteImage(img, v1.Platform{OS: "linux", Architecture: "arm64"}); err == nil || !strings.Contains(err.Error(), "platform") {
		t.Fatalf("platform mismatch error = %v", err)
	}
	bad := *img
	badManifest := *img.manifest
	badManifest.Config.Digest = v1.Hash{Algorithm: "sha256", Hex: strings.Repeat("a", 64)}
	bad.manifest = &badManifest
	if _, err := validateRemoteImage(&bad, v1.Platform{OS: "linux", Architecture: "amd64"}); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("config digest mismatch error = %v", err)
	}
}

func TestVerifyLoadedRequiresNormalizedPlatformMetadata(t *testing.T) {
	_, expected := newStaticTestImage(t, nil)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	base := image.InspectResponse{
		ID:           expected.String(),
		RepoTags:     []string{tag.String()},
		Os:           "linux",
		Architecture: "aarch64",
		Variant:      "v8",
	}
	platform := normalizePullPlatform(v1.Platform{OS: "linux", Architecture: "arm64", Variant: "v8"})
	for _, tc := range []struct {
		name     string
		platform v1.Platform
		edit     func(*image.InspectResponse)
		want     string
	}{
		{name: "missing os", platform: platform, edit: func(got *image.InspectResponse) { got.Os = "" }, want: "OS is unavailable"},
		{name: "missing architecture", platform: platform, edit: func(got *image.InspectResponse) { got.Architecture = "" }, want: "architecture is unavailable"},
		{name: "variant mismatch", platform: normalizePullPlatform(v1.Platform{OS: "linux", Architecture: "arm64", Variant: "v7"}), edit: func(got *image.InspectResponse) { got.Variant = "v8" }, want: "variant does not match"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := base
			tc.edit(&got)
			api := &pipelineAPIClient{inspect: func(_ context.Context, _ string) (image.InspectResponse, error) {
				return got, nil
			}}
			if err := verifyLoaded(context.Background(), api, tag, expectedImage{config: expected}, tc.platform); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("verifyLoaded error = %v, want %q", err, tc.want)
			}
		})
	}

	// A daemon's x86_64/aarch64 aliases and ARM v8 spelling normalize to the
	// same registry platform. Keep one positive case so the strict checks do
	// not reject equivalent daemon metadata.
	api := &pipelineAPIClient{inspect: func(_ context.Context, _ string) (image.InspectResponse, error) {
		return base, nil
	}}
	if err := verifyLoaded(context.Background(), api, tag, expectedImage{config: expected}, platform); err != nil {
		t.Fatalf("normalized equivalent platform rejected: %v", err)
	}
}

func TestNormalizePullPlatformAliases(t *testing.T) {
	for _, tc := range []struct{ raw, arch string }{{"linux/x86_64", "amd64"}, {"linux/aarch64", "arm64"}} {
		parsed, err := v1.ParsePlatform(tc.raw)
		if err != nil {
			t.Fatal(err)
		}
		got := normalizePullPlatform(*parsed)
		if got.OS != "linux" || got.Architecture != tc.arch {
			t.Errorf("normalize(%q) = %#v", tc.raw, got)
		}
	}
}

func TestProgressErrorDetailIsSanitizedAndReaderClosed(t *testing.T) {
	line := `{"errorDetail":{"message":"GET https://registry.example/v2/repo/blobs?token=dynamic-token denied"}}` + "\n"
	var output bytes.Buffer
	sink := &progressSink{dst: &output}
	err := ConsumeProgress(context.Background(), sink, io.NopCloser(strings.NewReader(line)))
	if err == nil || !strings.Contains(err.Error(), "dynamic-token") {
		t.Fatalf("ConsumeProgress error = %v, want source error for coordinator", err)
	}
	if strings.Contains(output.String(), "dynamic-token") {
		t.Fatalf("forwarded progress leaked dynamic token: %s", output.String())
	}
	var event struct {
		Error       string `json:"error"`
		ErrorDetail struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.Error == "" || event.ErrorDetail.Message == "" {
		t.Fatalf("sanitized event = %#v", event)
	}
}

func TestProgressErrorDetailWithoutMessageIsSanitized(t *testing.T) {
	line := `{"errorDetail":{"code":403,"token":"unknown-token"}}` + "\n"
	var output bytes.Buffer
	err := ConsumeProgress(context.Background(), &progressSink{dst: &output}, io.NopCloser(strings.NewReader(line)))
	if err == nil {
		t.Fatal("detail without message was accepted as successful progress")
	}
	if strings.Contains(output.String(), "unknown-token") || !strings.Contains(output.String(), safePullMessage) {
		t.Fatalf("sanitized detail leaked or omitted stable error: %s", output.String())
	}
}

func TestPullPipelineDaemonErrorFinishesAfterErrorEvent(t *testing.T) {
	ctx := context.Background()
	pullCtx, pullCancel := context.WithCancel(ctx)
	defer pullCancel()
	img, expected := newStaticTestImage(t, nil)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	api := &pipelineAPIClient{load: func(_ context.Context, input io.Reader) (image.LoadResponse, error) {
		if _, err := io.Copy(io.Discard, input); err != nil {
			return image.LoadResponse{}, err
		}
		return image.LoadResponse{
			Body: io.NopCloser(strings.NewReader(`{"errorDetail":{"message":"denied"}}` + "\n")),
			JSON: true,
		}, nil
	}}
	transport := (&http.Transport{}).Clone()
	rc, err := startPullPipeline(ctx, pullCtx, pullCancel, api, tag, img, expectedImage{config: expected}, v1.Platform{OS: "linux", Architecture: "amd64"}, transport)
	if err != nil {
		t.Fatal(err)
	}
	pipeline := rc.(*pullPipeline)
	scanner := bufio.NewScanner(rc)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), "Downloading and importing") {
		t.Fatalf("first progress = %q", scanner.Text())
	}
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"errorDetail"`) {
		t.Fatalf("error progress = %q", scanner.Text())
	}
	select {
	case <-pipeline.done:
	case <-time.After(2 * time.Second):
		t.Fatal("pipeline did not finish after daemon error event")
	}
	if scanner.Scan() {
		t.Fatalf("unexpected progress after terminal error: %q", scanner.Text())
	}
	if err := scanner.Err(); err == nil || !strings.Contains(err.Error(), "proxied image pull failed") {
		t.Fatalf("scanner error = %v, want terminal read error", err)
	}
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPullPipelineCloseCancelsHangingHTTPBlob(t *testing.T) {
	ctx := context.Background()
	pullCtx, pullCancel := context.WithCancel(ctx)
	defer pullCancel()
	started := make(chan struct{})
	serverDone := make(chan struct{})
	var startOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() { close(started) })
		<-r.Context().Done()
		close(serverDone)
	}))
	defer server.Close()

	layerDigest, _, err := v1.SHA256(strings.NewReader("layer"))
	if err != nil {
		t.Fatal(err)
	}
	layer := &hangingHTTPTestLayer{
		ctx:     pullCtx,
		url:     server.URL + "/blob",
		client:  server.Client(),
		digest:  layerDigest,
		diffID:  layerDigest,
		started: started,
	}
	img, expected := newStaticTestImage(t, layer)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	copyDone := make(chan struct{})
	api := &pipelineAPIClient{load: func(_ context.Context, input io.Reader) (image.LoadResponse, error) {
		go func() {
			_, _ = io.Copy(io.Discard, input)
			close(copyDone)
		}()
		return image.LoadResponse{Body: io.NopCloser(strings.NewReader(`{"status":"loaded"}` + "\n"))}, nil
	}}
	transport := (&http.Transport{}).Clone()
	rc, err := startPullPipeline(ctx, pullCtx, pullCancel, api, tag, img, expectedImage{config: expected}, v1.Platform{OS: "linux", Architecture: "amd64"}, transport)
	if err != nil {
		t.Fatal(err)
	}
	pipeline := rc.(*pullPipeline)
	scanner := bufio.NewScanner(rc)
	if !scanner.Scan() {
		t.Fatal("pipeline did not emit initial progress")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("test blob request did not start")
	}
	closeDone := make(chan error, 1)
	go func() { closeDone <- rc.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reader Close did not converge")
	}
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("hanging blob request was not canceled")
	}
	select {
	case <-copyDone:
	case <-time.After(2 * time.Second):
		t.Fatal("ImageLoad input consumer did not exit")
	}
	select {
	case <-pipeline.done:
	default:
		t.Fatal("pipeline done was not closed")
	}
}

func TestPullPipelineEarlyLoadEOFCancelsProducer(t *testing.T) {
	ctx := context.Background()
	pullCtx, pullCancel := context.WithCancel(ctx)
	defer pullCancel()
	started := make(chan struct{})
	serverDone := make(chan struct{})
	var startOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startOnce.Do(func() { close(started) })
		<-r.Context().Done()
		close(serverDone)
	}))
	defer server.Close()

	layerDigest, _, err := v1.SHA256(strings.NewReader("layer"))
	if err != nil {
		t.Fatal(err)
	}
	layer := &hangingHTTPTestLayer{ctx: pullCtx, url: server.URL + "/blob", client: server.Client(), digest: layerDigest, diffID: layerDigest, started: started}
	img, expected := newStaticTestImage(t, layer)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	copyDone := make(chan struct{})
	api := &pipelineAPIClient{load: func(_ context.Context, input io.Reader) (image.LoadResponse, error) {
		go func() {
			_, _ = io.Copy(io.Discard, input)
			close(copyDone)
		}()
		// This response is intentionally returned before the tar producer has
		// fetched the blob; the coordinator must reject that early EOF itself.
		return image.LoadResponse{Body: io.NopCloser(strings.NewReader(`{"status":"loaded"}` + "\n"))}, nil
	}}
	transport := (&http.Transport{}).Clone()
	rc, err := startPullPipeline(ctx, pullCtx, pullCancel, api, tag, img, expectedImage{config: expected}, v1.Platform{OS: "linux", Architecture: "amd64"}, transport)
	if err != nil {
		t.Fatal(err)
	}
	pipeline := rc.(*pullPipeline)
	scanner := bufio.NewScanner(rc)
	if !scanner.Scan() {
		t.Fatal("pipeline did not emit initial progress")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("test blob request did not start")
	}
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"status":"loaded"`) {
		t.Fatalf("load progress = %q", scanner.Text())
	}
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"errorDetail"`) {
		t.Fatalf("early EOF error progress = %q", scanner.Text())
	}
	select {
	case <-pipeline.done:
	case <-time.After(2 * time.Second):
		t.Fatal("early load EOF left pipeline running")
	}
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("early load EOF did not cancel blob request")
	}
	select {
	case <-copyDone:
	case <-time.After(2 * time.Second):
		t.Fatal("ImageLoad input consumer did not exit")
	}
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPullPipelineParentCancelWithoutReaderCloseConverges(t *testing.T) {
	parent, parentCancel := context.WithCancel(context.Background())
	defer parentCancel()
	pullCtx, pullCancel := context.WithCancel(parent)
	img, expected := newStaticTestImage(t, nil)
	tag, err := name.NewTag("registry.example/repo:test")
	if err != nil {
		t.Fatal(err)
	}
	api := &pipelineAPIClient{load: func(ctx context.Context, _ io.Reader) (image.LoadResponse, error) {
		<-ctx.Done()
		return image.LoadResponse{}, ctx.Err()
	}}
	transport := (&http.Transport{}).Clone()
	rc, err := startPullPipeline(parent, pullCtx, pullCancel, api, tag, img, expectedImage{config: expected}, v1.Platform{OS: "linux", Architecture: "amd64"}, transport)
	if err != nil {
		t.Fatal(err)
	}
	pipeline := rc.(*pullPipeline)
	// Deliberately do not read or close rc: the request context itself must
	// release both the initial progress write and the blocked tar producer.
	parentCancel()
	select {
	case <-pipeline.done:
	case <-time.After(2 * time.Second):
		t.Fatal("parent cancellation left pipeline goroutines blocked")
	}
	if err := rc.Close(); err != nil {
		t.Fatal(err)
	}
}

func mustURL(t *testing.T, raw string) url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return *u
}
