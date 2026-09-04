package docker

import (
	"github.com/docker/docker/client"
)

// Client keeps every Docker API operation native except request-scoped ImagePull.
type Client struct {
	client.APIClient
}

var _ client.APIClient = (*Client)(nil)

func NewClient() (*Client, error) {
	c, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, err
	}
	return &Client{APIClient: c}, nil
}
