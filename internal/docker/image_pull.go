package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/containerd/platforms"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	dockerclient "github.com/docker/docker/client"
	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/google/go-containerregistry/pkg/v1/types"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	xproxy "golang.org/x/net/proxy"
)

// pullProxyContextKey is deliberately private so callers cannot accidentally
// collide with the request-scoped proxy setting.
type pullProxyContextKey struct{}

type pullProxyConfig struct {
	url url.URL
}

// WithPullProxy adds a request-scoped registry proxy. An empty value leaves
// the context untouched, which keeps callers able to make the proxy optional.
func WithPullProxy(ctx context.Context, raw string) (context.Context, error) {
	if strings.TrimSpace(raw) == "" {
		return ctx, nil
	}
	if ctx == nil {
		return nil, errors.New("nil context")
	}
	cfg, err := parsePullProxy(raw)
	if err != nil {
		return nil, err
	}
	return context.WithValue(ctx, pullProxyContextKey{}, cfg), nil
}

// HasPullProxy reports whether a request has an explicit proxy configured.
func HasPullProxy(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	_, ok := ctx.Value(pullProxyContextKey{}).(pullProxyConfig)
	return ok
}

func pullProxyFromContext(ctx context.Context) (pullProxyConfig, bool) {
	if ctx == nil {
		return pullProxyConfig{}, false
	}
	cfg, ok := ctx.Value(pullProxyContextKey{}).(pullProxyConfig)
	return cfg, ok
}

func parsePullProxy(raw string) (pullProxyConfig, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" || u.User == nil && strings.Contains(u.Host, "@") {
		return pullProxyConfig{}, errors.New("invalid pull proxy URL")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return pullProxyConfig{}, errors.New("unsupported pull proxy scheme")
	}
	if u.User != nil && u.User.Username() == "" {
		return pullProxyConfig{}, errors.New("invalid pull proxy credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return pullProxyConfig{}, errors.New("pull proxy URL must not contain a path or query")
	}
	if strings.HasSuffix(u.Host, ":") || u.Hostname() == "" {
		return pullProxyConfig{}, errors.New("pull proxy URL must contain a host and valid port")
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return pullProxyConfig{}, errors.New("invalid pull proxy port")
		}
	}
	if (u.Scheme == "socks5" || u.Scheme == "socks5h") && u.Port() == "" {
		return pullProxyConfig{}, errors.New("SOCKS5 proxy requires a port")
	}
	return pullProxyConfig{url: *u}, nil
}

func proxyTransport(cfg pullProxyConfig) (*http.Transport, error) {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport is not configurable")
	}
	t := base.Clone()
	// Never inherit HTTP_PROXY/HTTPS_PROXY/NO_PROXY for a request that has an
	// explicit proxy. SOCKS5 is installed at the dial layer, so Proxy must stay nil.
	t.Proxy = nil
	switch cfg.url.Scheme {
	case "http", "https":
		u := cfg.url
		t.Proxy = http.ProxyURL(&u)
	case "socks5", "socks5h":
		var auth *xproxy.Auth
		if cfg.url.User != nil {
			password, _ := cfg.url.User.Password()
			auth = &xproxy.Auth{User: cfg.url.User.Username(), Password: password}
		}
		dialer, err := xproxy.SOCKS5("tcp", cfg.url.Host, auth, xproxy.Direct)
		if err != nil {
			return nil, errors.New("invalid SOCKS5 proxy")
		}
		contextDialer, ok := dialer.(xproxy.ContextDialer)
		if !ok {
			return nil, errors.New("SOCKS5 proxy does not support context cancellation")
		}
		t.DialContext = contextDialer.DialContext
	}
	return t, nil
}

const maxMetadataSize = 16 << 20

var errMetadataTooLarge = errors.New("registry metadata is too large")

// metadataLimitTransport bounds manifest responses before go-containerregistry
// reads them into memory. Once the selected image manifest is known, its config
// blob is bounded too; layer responses remain intentionally streaming.
type metadataLimitTransport struct {
	inner        http.RoundTripper
	configDigest string
}

func (t *metadataLimitTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	configBlob := isConfigBlob(req, t.configDigest)
	var resp *http.Response
	var err error
	if configBlob {
		// Follow config redirects here so object-storage URLs remain bounded.
		// The standard client handles redirect limits and credential forwarding.
		resp, err = (&http.Client{Transport: t.inner}).Do(req)
	} else {
		resp, err = t.inner.RoundTrip(req)
	}
	if err != nil || resp == nil {
		return resp, err
	}
	if configBlob || isMetadataResponse(req, resp) {
		resp.Body = &limitedReadCloser{ReadCloser: resp.Body, remaining: maxMetadataSize}
	}
	return resp, nil
}

func isConfigBlob(req *http.Request, digest string) bool {
	return digest != "" && strings.HasSuffix(req.URL.Path, "/blobs/"+digest)
}

func isMetadataResponse(req *http.Request, resp *http.Response) bool {
	if strings.Contains(req.URL.Path, "/manifests/") {
		return true
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]))
	return contentType == "application/json" || strings.HasSuffix(contentType, "+json")
}

type limitedReadCloser struct {
	io.ReadCloser
	remaining int64
}

func (r *limitedReadCloser) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		var one [1]byte
		n, err := r.ReadCloser.Read(one[:])
		if n > 0 {
			return 0, errMetadataTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.ReadCloser.Read(p)
	r.remaining -= int64(n)
	return n, err
}

// ImagePull keeps the Docker SDK contract. Without a request proxy it is a
// transparent pass-through; with one it streams a Docker-load tarball from a
// registry into the daemon.
func (c *Client) ImagePull(ctx context.Context, ref string, options image.PullOptions) (io.ReadCloser, error) {
	proxyCfg, proxied := pullProxyFromContext(ctx)
	if !proxied {
		if c == nil || c.APIClient == nil {
			return nil, errors.New("Docker client is unavailable")
		}
		return c.APIClient.ImagePull(ctx, ref, options)
	}
	if c == nil || c.APIClient == nil {
		return nil, errors.New("Docker client is unavailable")
	}
	if ctx == nil {
		return nil, errors.New("nil context")
	}
	if options.All {
		return nil, errors.New("proxied image pull does not support pulling all tags")
	}
	if options.PrivilegeFunc != nil {
		return nil, errors.New("proxied image pull does not support privilege retry")
	}
	pullCtx, cancel := context.WithCancel(ctx)
	keepCancel := false
	defer func() {
		if !keepCancel {
			cancel()
		}
	}()

	parsed, err := name.ParseReference(ref)
	if err != nil {
		return nil, errors.New("invalid image reference")
	}
	tag, ok := parsed.(name.Tag)
	if !ok {
		// A digest needs a RepoDigest-preserving daemon pull path. A Docker load
		// tarball only carries tags, so refusing it is safer than inventing one.
		return nil, errors.New("proxied image pull requires a tag reference")
	}

	platform, err := c.pullPlatform(pullCtx, options.Platform)
	if err != nil {
		return nil, err
	}
	authnConfig, err := pullAuth(parsed, options.RegistryAuth)
	if err != nil {
		return nil, err
	}
	transport, err := proxyTransport(proxyCfg)
	if err != nil {
		return nil, err
	}
	metadataTransport := &metadataLimitTransport{inner: transport}
	remoteOpts := []remote.Option{
		remote.WithAuth(authnConfig),
		remote.WithContext(pullCtx),
		remote.WithPlatform(platform),
		remote.WithTransport(metadataTransport),
	}
	desc, err := remote.Get(parsed, remoteOpts...)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, safePullError("registry request failed", err)
	}
	if desc.Size < 0 || desc.Size > maxMetadataSize {
		transport.CloseIdleConnections()
		return nil, safePullError("registry request failed", errors.New("image manifest is too large"))
	}
	img, err := desc.Image()
	if err != nil {
		transport.CloseIdleConnections()
		return nil, safePullError("image platform selection failed", err)
	}
	manifest, err := img.Manifest()
	if err != nil {
		transport.CloseIdleConnections()
		return nil, safePullError("image validation failed", err)
	}
	if manifest == nil || manifest.Config.Size < 0 || manifest.Config.Size > maxMetadataSize || !manifest.Config.MediaType.IsConfig() {
		transport.CloseIdleConnections()
		return nil, safePullError("image validation failed", errors.New("invalid image config descriptor"))
	}
	// remote.Image reads config blobs as application/octet-stream on many
	// registries. Set the selected digest after the manifest is known so this
	// transport limits only config, never the potentially large layer stream.
	metadataTransport.configDigest = manifest.Config.Digest.String()
	expected, err := validateRemoteImage(img, platform)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, safePullError("image validation failed", err)
	}
	// The selected config digest is known before any layer is requested. If the
	// daemon already has this exact tag/config, return a normal progress stream
	// without starting ImageLoad; this is the proxy equivalent of Docker's
	// up-to-date check and avoids a needless import.
	if localImageMatches(pullCtx, c.APIClient, tarTag(tag), expected.config.String()) {
		transport.CloseIdleConnections()
		return io.NopCloser(strings.NewReader(`{"status":"Image is up to date"}` + "\n")), nil
	}

	keepCancel = true
	return startPullPipeline(ctx, pullCtx, cancel, c.APIClient, tag, img, expected, platform, transport)
}

func localImageMatches(ctx context.Context, apiClient dockerclient.APIClient, ref, expectedID string) bool {
	local, err := apiClient.ImageInspect(ctx, ref)
	return err == nil && strings.EqualFold(local.ID, expectedID)
}

func (c *Client) pullPlatform(ctx context.Context, raw string) (v1.Platform, error) {
	if strings.TrimSpace(raw) != "" {
		platform, err := v1.ParsePlatform(raw)
		if err != nil || platform.OS == "" || platform.Architecture == "" {
			return v1.Platform{}, errors.New("invalid image platform")
		}
		normalized := normalizePullPlatform(*platform)
		if normalized.OS != "linux" || normalized.Architecture == "" {
			return v1.Platform{}, errors.New("proxied image pull supports Linux platforms only")
		}
		return normalized, nil
	}
	info, err := c.APIClient.Info(ctx)
	if err != nil {
		return v1.Platform{}, errors.New("cannot determine Docker daemon platform")
	}
	if info.OSType == "" || info.Architecture == "" {
		return v1.Platform{}, errors.New("Docker daemon platform is unavailable")
	}
	p := normalizePullPlatform(v1.Platform{OS: strings.ToLower(info.OSType), Architecture: strings.ToLower(info.Architecture)})
	if p.OS != "linux" || p.Architecture == "" {
		return v1.Platform{}, errors.New("proxied image pull supports Linux daemon platforms only")
	}
	return p, nil
}

// normalizePullPlatform bridges go-containerregistry's platform type to the
// OCI platform type required by containerd/platforms. Docker commonly reports
// aliases such as x86_64 and aarch64; Normalize translates those to amd64 and
// arm64 before registry selection and post-load verification.
func normalizePullPlatform(platform v1.Platform) v1.Platform {
	normalized := platforms.Normalize(ocispec.Platform{
		OS:           platform.OS,
		Architecture: platform.Architecture,
		OSVersion:    platform.OSVersion,
		OSFeatures:   platform.OSFeatures,
		Variant:      platform.Variant,
	})
	return v1.Platform{
		OS:           normalized.OS,
		Architecture: normalized.Architecture,
		OSVersion:    normalized.OSVersion,
		OSFeatures:   normalized.OSFeatures,
		Variant:      normalized.Variant,
	}
}

func pullAuth(ref name.Reference, encoded string) (authn.Authenticator, error) {
	if encoded == "" {
		return authn.Anonymous, nil
	}
	cfg, err := registry.DecodeAuthConfig(encoded)
	if err != nil {
		return nil, errors.New("invalid registry authentication")
	}
	if cfg.ServerAddress != "" {
		want, err := RegistryHost(ref.Context().RegistryStr())
		if err != nil {
			return nil, errors.New("invalid image registry")
		}
		got, err := RegistryHost(cfg.ServerAddress)
		if err != nil || !strings.EqualFold(want, got) {
			return nil, errors.New("registry authentication does not match image registry")
		}
	}
	return authn.FromConfig(authn.AuthConfig{
		Username:      cfg.Username,
		Password:      cfg.Password,
		Auth:          cfg.Auth,
		IdentityToken: cfg.IdentityToken,
		RegistryToken: cfg.RegistryToken,
	}), nil
}

// RegistryHost normalizes an explicit registry address for credential scoping.
// Repository paths, credentials and malformed ports are not registry addresses.
func RegistryHost(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("empty registry")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Host == "" || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("invalid registry")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("invalid registry scheme")
	}
	if u.Path != "" && u.Path != "/" && u.Path != "/v1" && u.Path != "/v1/" && u.Path != "/v2" && u.Path != "/v2/" {
		return "", errors.New("invalid registry path")
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", errors.New("invalid registry port")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("invalid registry port")
		}
	}
	host := strings.ToLower(u.Hostname())
	if host == "docker.io" || host == "index.docker.io" || host == "registry-1.docker.io" {
		host = "docker.io"
	}
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" {
		host = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	return host, nil
}

type expectedImage struct {
	config v1.Hash
}

func validateRemoteImage(img v1.Image, platform v1.Platform) (expectedImage, error) {
	manifest, err := img.Manifest()
	if err != nil {
		return expectedImage{}, err
	}
	if manifest == nil || manifest.Config.Size > maxMetadataSize {
		return expectedImage{}, errors.New("image config is too large")
	}
	if !manifest.MediaType.IsImage() {
		return expectedImage{}, fmt.Errorf("unsupported image manifest media type %q", manifest.MediaType)
	}
	if !manifest.Config.MediaType.IsConfig() || manifest.Config.Size < 0 {
		return expectedImage{}, errors.New("invalid image config descriptor")
	}
	for _, layer := range manifest.Layers {
		if !supportedLayerMediaType(layer.MediaType) {
			return expectedImage{}, fmt.Errorf("unsupported image layer media type %q", layer.MediaType)
		}
		if layer.Size < 0 {
			return expectedImage{}, errors.New("invalid image layer size")
		}
	}
	rawConfig, err := img.RawConfigFile()
	if err != nil {
		return expectedImage{}, err
	}
	if int64(len(rawConfig)) != manifest.Config.Size {
		return expectedImage{}, errors.New("image config size mismatch")
	}
	configDigest, _, err := v1.SHA256(bytes.NewReader(rawConfig))
	if err != nil || configDigest != manifest.Config.Digest {
		return expectedImage{}, errors.New("image config digest mismatch")
	}
	configFile, err := v1.ParseConfigFile(bytes.NewReader(rawConfig))
	if err != nil {
		return expectedImage{}, errors.New("invalid image config")
	}
	actualPlatform := configFile.Platform()
	if actualPlatform == nil || !actualPlatform.Satisfies(platform) {
		return expectedImage{}, errors.New("image platform does not match requested platform")
	}
	configName, err := img.ConfigName()
	if err != nil || configName != configDigest {
		return expectedImage{}, errors.New("image config ID mismatch")
	}
	return expectedImage{config: configDigest}, nil
}

func supportedLayerMediaType(mt types.MediaType) bool {
	switch mt {
	case types.DockerLayer, types.DockerUncompressedLayer, types.OCILayer, types.OCIUncompressedLayer:
		return true
	default:
		return false
	}
}

type layerTracker struct {
	mu      sync.Mutex
	readers map[*trackedLayerReader]struct{}
}

func newLayerTracker() *layerTracker {
	return &layerTracker{readers: make(map[*trackedLayerReader]struct{})}
}

func (t *layerTracker) add(r *trackedLayerReader) {
	t.mu.Lock()
	t.readers[r] = struct{}{}
	t.mu.Unlock()
}

func (t *layerTracker) remove(r *trackedLayerReader) {
	t.mu.Lock()
	delete(t.readers, r)
	t.mu.Unlock()
}

func (t *layerTracker) closeAll() error {
	t.mu.Lock()
	readers := make([]*trackedLayerReader, 0, len(t.readers))
	for r := range t.readers {
		readers = append(readers, r)
	}
	t.mu.Unlock()
	var first error
	for _, r := range readers {
		if err := r.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

type trackedImage struct {
	v1.Image
	tracker    *layerTracker
	layerSizes []int64
}

func (i *trackedImage) Layers() ([]v1.Layer, error) {
	layers, err := i.Image.Layers()
	if err != nil {
		return nil, err
	}
	if len(layers) != len(i.layerSizes) {
		return nil, errors.New("image layer count changed during tar generation")
	}
	wrapped := make([]v1.Layer, len(layers))
	for n, layer := range layers {
		wrapped[n] = &trackedLayer{Layer: layer, tracker: i.tracker, size: i.layerSizes[n]}
	}
	return wrapped, nil
}

type trackedLayer struct {
	v1.Layer
	tracker *layerTracker
	size    int64
}

func (l *trackedLayer) Size() (int64, error) {
	return l.size, nil
}

func (l *trackedLayer) Compressed() (io.ReadCloser, error) {
	r, err := l.Layer.Compressed()
	if err != nil {
		return nil, err
	}
	tracked := &trackedLayerReader{ReadCloser: r, tracker: l.tracker}
	l.tracker.add(tracked)
	return tracked, nil
}

type trackedLayerReader struct {
	io.ReadCloser
	tracker *layerTracker
	once    sync.Once
	err     error
}

func (r *trackedLayerReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if err != nil {
		closeErr := r.Close()
		if err == io.EOF && closeErr != nil {
			return n, closeErr
		}
	}
	return n, err
}

func (r *trackedLayerReader) Close() error {
	r.once.Do(func() {
		r.err = r.ReadCloser.Close()
		r.tracker.remove(r)
	})
	return r.err
}

func writeImageTar(w io.Writer, tag name.Tag, img v1.Image) error {
	manifest, err := img.Manifest()
	if err != nil {
		return err
	}
	if manifest == nil {
		return errors.New("image manifest is unavailable")
	}
	layerSizes := make([]int64, len(manifest.Layers))
	for n, layer := range manifest.Layers {
		if layer.Size < 0 {
			return errors.New("invalid image layer size")
		}
		layerSizes[n] = layer.Size
	}
	tracker := newLayerTracker()
	wrapped := &trackedImage{Image: img, tracker: tracker, layerSizes: layerSizes}
	err = tarball.Write(tag, wrapped, w)
	if closeErr := tracker.closeAll(); err == nil {
		err = closeErr
	}
	return err
}

type pullPipeline struct {
	ctx       context.Context
	parentCtx context.Context
	cancel    context.CancelFunc
	inputR    *io.PipeReader
	inputW    *io.PipeWriter
	outputR   *io.PipeReader
	outputW   *io.PipeWriter
	transport *http.Transport
	closed    chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// startPullPipeline has one coordinator and one tar producer. All network and
// pipe work shares the same cancel function so Close/error cannot leave a
// registry request alive behind the Docker load.
func startPullPipeline(parentCtx, ctx context.Context, cancel context.CancelFunc, apiClient dockerclient.APIClient, tag name.Tag, img v1.Image, expected expectedImage, platform v1.Platform, transport *http.Transport) (io.ReadCloser, error) {
	inputR, inputW := io.Pipe()
	outputR, outputW := io.Pipe()
	p := &pullPipeline{
		ctx:       ctx,
		parentCtx: parentCtx,
		cancel:    cancel,
		inputR:    inputR,
		inputW:    inputW,
		outputR:   outputR,
		outputW:   outputW,
		transport: transport,
		closed:    make(chan struct{}),
		done:      make(chan struct{}),
	}
	producerDone := make(chan error, 1)
	go func() {
		err := writeImageTar(inputW, tag, img)
		if err != nil {
			_ = inputW.CloseWithError(err)
			cancel()
		} else {
			_ = inputW.Close()
		}
		producerDone <- err
	}()
	go p.coordinate(apiClient, tag, expected, platform, producerDone)
	return p, nil
}

func (p *pullPipeline) Read(b []byte) (int, error) { return p.outputR.Read(b) }

func (p *pullPipeline) Close() error {
	p.closeForAbort()
	<-p.done
	return nil
}

func (p *pullPipeline) closeForAbort() {
	p.closeOnce.Do(func() {
		close(p.closed)
		p.cancel()
		_ = p.inputR.Close()
		_ = p.inputW.CloseWithError(io.ErrClosedPipe)
		_ = p.outputR.Close()
	})
}

func (p *pullPipeline) aborted() bool {
	select {
	case <-p.closed:
		return true
	default:
		return false
	}
}

func (p *pullPipeline) abort(err error) {
	p.cancel()
	_ = p.inputR.CloseWithError(err)
	_ = p.inputW.CloseWithError(err)
}

func (p *pullPipeline) finish(err error) {
	if err != nil {
		if _, ok := err.(*redactedPullError); !ok {
			err = safePullError("", err)
		}
		_ = p.outputW.CloseWithError(err)
	} else {
		_ = p.outputW.Close()
	}
}

func (p *pullPipeline) emitError(err error) {
	if p.aborted() {
		return
	}
	_ = writeProgressError(p.outputW, safePullMessage)
	p.finish(err)
}

func (p *pullPipeline) coordinate(apiClient dockerclient.APIClient, tag name.Tag, expected expectedImage, platform v1.Platform, producerDone <-chan error) {
	defer close(p.done)
	defer p.transport.CloseIdleConnections()
	stopParentWatch := context.AfterFunc(p.parentCtx, p.closeForAbort)
	defer stopParentWatch()
	if _, err := p.outputW.Write([]byte(`{"status":"Downloading and importing via proxy"}` + "\n")); err != nil {
		p.abort(err)
		<-producerDone
		return
	}

	response, loadErr := apiClient.ImageLoad(p.ctx, p.inputR)
	if loadErr == nil && response.Body == nil {
		loadErr = errors.New("Docker ImageLoad returned no response body")
	}
	if loadErr != nil {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		p.abort(loadErr)
		producerErr := <-producerDone
		p.emitError(choosePullError(loadErr, producerErr))
		return
	}
	progress := &progressSink{dst: p.outputW}
	readErr := ConsumeProgress(p.ctx, progress, response.Body)
	if readErr != nil {
		p.abort(readErr)
		producerErr := <-producerDone
		if p.aborted() {
			return
		}
		root := choosePullError(readErr, producerErr)
		if progress.errorEvent {
			p.finish(root)
		} else {
			p.emitError(root)
		}
		return
	}
	// A successful load response must correspond to the complete tar request.
	// Closing the input now makes an eager/fake ImageLoad that returned before
	// consuming the request fail the producer instead of being accepted.
	p.cancel()
	_ = p.inputR.Close()
	if producerErr := <-producerDone; producerErr != nil {
		p.abort(producerErr)
		p.emitError(safePullError("image tarball generation failed", producerErr))
		return
	}
	if err := verifyLoaded(p.parentCtx, apiClient, tag, expected, platform); err != nil {
		p.abort(err)
		p.emitError(safePullError("loaded image verification failed", err))
		return
	}
	p.cancel()
	p.finish(nil)
}

// progressSink lets the coordinator distinguish a daemon error event (already
// delivered to the caller) from a transport/parse error that still needs one.
type progressSink struct {
	dst        io.Writer
	errorEvent bool
}

func (s *progressSink) Write(p []byte) (int, error) {
	var event struct {
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if json.Unmarshal(bytes.TrimSpace(p), &event) == nil &&
		(event.Error != "" || event.ErrorDetail != nil) {
		s.errorEvent = true
		// Do not forward daemon error JSON verbatim: it may contain a signed
		// registry URL or a bearer token that was not known at setup time.
		if err := writeProgressError(s.dst, safePullMessage); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return s.dst.Write(p)
}

func writeProgressError(dst io.Writer, message string) error {
	event := struct {
		Error       string `json:"error"`
		ErrorDetail struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}{Error: message}
	event.ErrorDetail.Message = message
	return json.NewEncoder(dst).Encode(event)
}

func choosePullError(loadErr, producerErr error) error {
	if producerErr != nil && !errors.Is(producerErr, io.ErrClosedPipe) && !errors.Is(producerErr, context.Canceled) {
		return producerErr
	}
	return loadErr
}

func verifyLoaded(ctx context.Context, apiClient dockerclient.APIClient, tag name.Tag, expected expectedImage, platform v1.Platform) error {
	loaded, err := apiClient.ImageInspect(ctx, tarTag(tag))
	if err != nil {
		return errors.New("cannot inspect loaded image")
	}
	if !strings.EqualFold(loaded.ID, expected.config.String()) {
		return errors.New("loaded image config ID does not match downloaded config")
	}
	if !hasLoadedTag(loaded.RepoTags, tag) {
		return errors.New("loaded image tag does not match requested tag")
	}
	if loaded.Os == "" {
		return errors.New("loaded image OS is unavailable")
	}
	loadedPlatform := normalizePullPlatform(v1.Platform{
		OS:           loaded.Os,
		Architecture: loaded.Architecture,
		Variant:      loaded.Variant,
	})
	if !strings.EqualFold(loadedPlatform.OS, platform.OS) {
		return errors.New("loaded image OS does not match requested platform")
	}
	if loaded.Architecture == "" {
		return errors.New("loaded image architecture is unavailable")
	}
	if !strings.EqualFold(loadedPlatform.Architecture, platform.Architecture) {
		return errors.New("loaded image architecture does not match requested platform")
	}
	if platform.Variant != "" && !strings.EqualFold(loadedPlatform.Variant, platform.Variant) {
		return errors.New("loaded image variant does not match requested platform")
	}
	return nil
}

func tarTag(tag name.Tag) string {
	s := tag.String()
	if tag.Identifier() == name.DefaultTag && !strings.HasSuffix(s, ":"+name.DefaultTag) {
		return s + ":" + name.DefaultTag
	}
	return s
}

func hasLoadedTag(tags []string, wanted name.Tag) bool {
	expected := tarTag(wanted)
	for _, got := range tags {
		if got == expected {
			return true
		}
		parsed, err := name.ParseReference(got)
		if err == nil {
			want, _ := name.ParseReference(expected)
			if want != nil && parsed.Name() == want.Name() {
				return true
			}
		}
	}
	return false
}

const safePullMessage = "proxied image pull failed"

type redactedPullError struct {
	message  string
	sentinel error
}

func (e *redactedPullError) Error() string { return e.message }

// Is preserves cancellation classification without retaining or unwrapping a
// sensitive registry/proxy error. Compose recursively unwraps errors before
// displaying them, so Unwrap here would defeat redaction.
func (e *redactedPullError) Is(target error) bool {
	return e.sentinel != nil && target == e.sentinel
}

func safePullError(prefix string, err error) error {
	message := prefix
	var sentinel error
	if err != nil {
		if message != "" {
			message += ": "
		}
		message += safePullMessage
		if errors.Is(err, context.Canceled) {
			sentinel = context.Canceled
		} else if errors.Is(err, context.DeadlineExceeded) {
			sentinel = context.DeadlineExceeded
		}
	}
	return &redactedPullError{message: message, sentinel: sentinel}
}
