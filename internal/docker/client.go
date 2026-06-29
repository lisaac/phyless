package docker

import (
	"github.com/docker/docker/client"
)

func NewClient() (*client.Client, error) {
	return client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	)
}
