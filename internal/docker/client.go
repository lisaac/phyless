package docker

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/docker/docker/client"
	"phyless/internal/models"
)

// Client keeps every Docker API operation native except request-scoped ImagePull.
type Client struct {
	client.APIClient
}

var _ client.APIClient = (*Client)(nil)

// NewClient creates either the configured remote client or preserves the
// existing Docker environment-variable behavior when no endpoint is saved.
func NewClient(endpoint models.DockerEndpoint) (*Client, error) {
	endpoint, err := NormalizeEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	if endpoint.Host == "" {
		c, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		if err != nil {
			return nil, err
		}
		return &Client{APIClient: c}, nil
	}

	opts := []client.Opt{client.WithHost(endpoint.Host), client.WithAPIVersionNegotiation()}
	if endpoint.TLS {
		config, err := tlsConfig(endpoint)
		if err != nil {
			return nil, err
		}
		// WithHost must configure this transport for the TCP endpoint.
		opts = append([]client.Opt{client.WithHTTPClient(&http.Client{Transport: &http.Transport{TLSClientConfig: config}})}, opts...)
	}
	c, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, err
	}
	return &Client{APIClient: c}, nil
}

// NormalizeEndpoint validates the persisted single-daemon configuration and
// returns its canonical form. Remote Docker API URLs are always tcp://; TLS is
// selected separately so HTTPS and plain HTTP cannot be confused.
func NormalizeEndpoint(endpoint models.DockerEndpoint) (models.DockerEndpoint, error) {
	endpoint.Host = strings.TrimSpace(endpoint.Host)
	if endpoint.Host == "" {
		if endpoint.TLS {
			return endpoint, fmt.Errorf("Docker TLS requires a remote tcp endpoint")
		}
		endpoint.CAPEM, endpoint.CertPEM, endpoint.KeyPEM = "", "", ""
		return endpoint, nil
	}

	u, err := url.Parse(endpoint.Host)
	if err != nil || u.Scheme != "tcp" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return endpoint, fmt.Errorf("Docker endpoint must be tcp://host:port")
	}
	if _, _, err := net.SplitHostPort(u.Host); err != nil {
		return endpoint, fmt.Errorf("Docker endpoint must include a valid host and port: %w", err)
	}
	endpoint.Host = "tcp://" + u.Host
	if !endpoint.TLS {
		endpoint.CAPEM, endpoint.CertPEM, endpoint.KeyPEM = "", "", ""
		return endpoint, nil
	}
	if _, err := tlsConfig(endpoint); err != nil {
		return endpoint, err
	}
	return endpoint, nil
}

func tlsConfig(endpoint models.DockerEndpoint) (*tls.Config, error) {
	if endpoint.CAPEM == "" || endpoint.CertPEM == "" || endpoint.KeyPEM == "" {
		return nil, fmt.Errorf("TLS requires CA, client certificate, and private key PEM text")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(endpoint.CAPEM)) {
		return nil, fmt.Errorf("invalid TLS CA certificate PEM")
	}
	cert, err := tls.X509KeyPair([]byte(endpoint.CertPEM), []byte(endpoint.KeyPEM))
	if err != nil {
		return nil, fmt.Errorf("invalid TLS client certificate or private key: %w", err)
	}
	return &tls.Config{RootCAs: roots, Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
}
