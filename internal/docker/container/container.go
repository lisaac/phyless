package container

import (
	"archive/tar"
	"bytes"
	"context"
	"io"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

// ListFiles lists files in a container at path by parsing a tar stream from docker cp.
func ListFiles(ctx context.Context, cli *client.Client, containerID, path string) ([]tar.Header, error) {
	rc, _, err := cli.CopyFromContainer(ctx, containerID, path)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var headers []tar.Header
	tr := tar.NewReader(rc)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		headers = append(headers, *hdr)
	}
	return headers, nil
}

// DownloadFile streams a single file from a container. Caller must close the returned ReadCloser.
func DownloadFile(ctx context.Context, cli *client.Client, containerID, path string) (io.ReadCloser, error) {
	rc, _, err := cli.CopyFromContainer(ctx, containerID, path)
	return rc, err
}

// UploadFile uploads content (as a tar stream) to destPath in the container.
func UploadFile(ctx context.Context, cli *client.Client, containerID, destPath string, content io.Reader) error {
	return cli.CopyToContainer(ctx, containerID, destPath, content, container.CopyToContainerOptions{})
}

// CreateTar wraps a single file into a tar stream for UploadFile.
func CreateTar(filename string, content []byte) io.Reader {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	tw.WriteHeader(&tar.Header{Name: filename, Size: int64(len(content)), Mode: 0644}) //nolint:errcheck
	tw.Write(content)                                                                   //nolint:errcheck
	tw.Close()
	return &buf
}

// Duplicate creates a new container using another as a config template.
func Duplicate(ctx context.Context, cli *client.Client, sourceID, newName string) (string, error) {
	info, err := cli.ContainerInspect(ctx, sourceID)
	if err != nil {
		return "", err
	}
	resp, err := cli.ContainerCreate(ctx, info.Config, info.HostConfig, nil, nil, newName)
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}

// Upgrade pulls the latest image and recreates the container with the same config.
func Upgrade(ctx context.Context, cli *client.Client, containerID string, pullOutput io.Writer) (string, error) {
	info, err := cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return "", err
	}
	rc, err := cli.ImagePull(ctx, info.Config.Image, image.PullOptions{})
	if err != nil {
		return "", err
	}
	io.Copy(pullOutput, rc) // ponytail: stream pull output to caller, not buffered
	rc.Close()

	// Stop and remove old container; ignore errors (may already be stopped/removed)
	cli.ContainerStop(ctx, containerID, container.StopOptions{})          //nolint:errcheck
	cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}) //nolint:errcheck

	resp, err := cli.ContainerCreate(ctx, info.Config, info.HostConfig, nil, nil, info.Name)
	if err != nil {
		return "", err
	}
	return resp.ID, cli.ContainerStart(ctx, resp.ID, container.StartOptions{})
}

// GetByFilters returns containers matching given label/name filters.
func GetByFilters(ctx context.Context, cli *client.Client, args filters.Args) ([]container.Summary, error) {
	return cli.ContainerList(ctx, container.ListOptions{All: true, Filters: args})
}
