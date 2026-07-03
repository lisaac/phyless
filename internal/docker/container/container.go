package container

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

// streamEvent is one line of a newline-delimited JSON progress stream — the
// same {stream}/{error} shape docker load already uses, so a single frontend
// widget can render pull, load, create, and upgrade progress uniformly.
type streamEvent struct {
	Stream string `json:"stream,omitempty"`
	Error  string `json:"error,omitempty"`
}

// EmitStream writes one formatted status line to a progress stream.
func EmitStream(w io.Writer, format string, a ...any) {
	json.NewEncoder(w).Encode(streamEvent{Stream: fmt.Sprintf(format, a...)}) //nolint:errcheck
}

// EmitError writes a terminal error line to a progress stream.
func EmitError(w io.Writer, err error) {
	json.NewEncoder(w).Encode(streamEvent{Error: err.Error()}) //nolint:errcheck
}

// FileEntry is a directory listing entry returned by ExecListDir.
type FileEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	IsDir   bool   `json:"is_dir"`
	ModTime int64  `json:"mod_time"`
	Uname   string `json:"uname"`
	Uid     int    `json:"uid"`
	Gid     int    `json:"gid"`
}

// ExecListDir lists direct children of path by running ls inside the container.
// Only works for running containers; returns an error for stopped/distroless containers.
func ExecListDir(ctx context.Context, cli *client.Client, containerID, path string) ([]FileEntry, error) {
	return execLs(ctx, cli, containerID, path)
}

func execLs(ctx context.Context, cli *client.Client, containerID, path string) ([]FileEntry, error) {
	exec, err := cli.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		Cmd:          []string{"ls", "-la", path},
		AttachStdout: true,
		AttachStderr: true,
		Env:          []string{"LANG=C", "LC_ALL=C"},
	})
	if err != nil {
		return nil, err
	}
	resp, err := cli.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
	if err != nil {
		return nil, err
	}
	defer resp.Close()

	var stdout, stderr bytes.Buffer
	stdcopy.StdCopy(&stdout, &stderr, resp.Reader) //nolint:errcheck

	if stdout.Len() == 0 {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = "ls 无输出"
		}
		return nil, fmt.Errorf("%s", msg)
	}

	var out []FileEntry
	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		if e, ok := parseLsLine(scanner.Text()); ok {
			out = append(out, e)
		}
	}
	return out, nil
}

// lsMonths maps 3-letter English month abbreviations to month numbers.
var lsMonths = map[string]int{
	"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
	"Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

// parseLsDate converts the three date fields from standard ls -la output to a Unix timestamp.
// month is a 3-letter abbreviation, day is a decimal string, yearOrTime is either "2024" or "10:30".
func parseLsDate(month, day, yearOrTime string) int64 {
	m := lsMonths[month]
	if m == 0 {
		return 0
	}
	d, _ := strconv.Atoi(strings.TrimSpace(day))
	now := time.Now()
	if strings.Contains(yearOrTime, ":") {
		// Recent file — time given but no year; assume current year.
		parts := strings.SplitN(yearOrTime, ":", 2)
		h, _ := strconv.Atoi(parts[0])
		min, _ := strconv.Atoi(parts[1])
		t := time.Date(now.Year(), time.Month(m), d, h, min, 0, 0, now.Location())
		if t.After(now.Add(24 * time.Hour)) {
			t = t.AddDate(-1, 0, 0) // future date means last year
		}
		return t.Unix()
	}
	year, _ := strconv.Atoi(strings.TrimSpace(yearOrTime))
	if year == 0 {
		return 0
	}
	return time.Date(year, time.Month(m), d, 0, 0, 0, 0, time.UTC).Unix()
}

// parseLsLine parses one line of `ls -la` (standard) output.
// Fields: perms nlinks owner group size month day year/time name…
func parseLsLine(line string) (FileEntry, bool) {
	fields := strings.Fields(line)
	// Need at least: perms nlinks owner group size month day year/time name
	if len(fields) < 9 {
		return FileEntry{}, false
	}
	perms := fields[0]
	if perms == "total" || perms[0] == 't' {
		return FileEntry{}, false // "total N" line
	}

	// Reconstruct filename: scan past 8 whitespace-separated tokens.
	name := filenameAfterFields(line, 8)
	if name == "" || name == "." || name == ".." {
		return FileEntry{}, false
	}
	// Strip symlink target: "linkname -> /target"
	if idx := strings.Index(name, " -> "); idx >= 0 {
		name = name[:idx]
	}

	size, _ := strconv.ParseInt(fields[4], 10, 64)
	modTime := parseLsDate(fields[5], fields[6], fields[7])

	return FileEntry{
		Name:    name,
		Size:    size,
		Mode:    perms,
		IsDir:   perms[0] == 'd',
		ModTime: modTime,
		Uname:   fields[2],
	}, true
}

// filenameAfterFields returns the substring of line after the first n whitespace-separated fields.
func filenameAfterFields(line string, n int) string {
	i := 0
	for f := 0; f < n; f++ {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		for i < len(line) && line[i] != ' ' && line[i] != '\t' {
			i++
		}
	}
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	return strings.TrimRight(line[i:], "\r\n")
}

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

func shortID(s string) string {
	if len(s) > 19 {
		return s[:19]
	}
	return s
}

// Upgrade pulls the latest image, compares it with the running container's image,
// and recreates the container only when a newer image is available.
// Returns the new container ID, or "" if already up to date.
func Upgrade(ctx context.Context, cli *client.Client, containerID string, w io.Writer) (string, error) {
	info, err := cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return "", err
	}

	EmitStream(w, "正在拉取镜像 %s …", info.Config.Image)

	rc, err := cli.ImagePull(ctx, info.Config.Image, image.PullOptions{})
	if err != nil {
		return "", fmt.Errorf("pull 失败: %w", err)
	}
	io.Copy(w, rc) //nolint:errcheck
	rc.Close()

	newImg, _, err := cli.ImageInspectWithRaw(ctx, info.Config.Image)
	if err != nil {
		return "", fmt.Errorf("无法检查新镜像: %w", err)
	}

	EmitStream(w, "当前镜像 ID: %s ｜ 新镜像 ID: %s", shortID(info.Image), shortID(newImg.ID))

	if newImg.ID == info.Image {
		EmitStream(w, "✓ 已是最新版本，无需升级。")
		return "", nil
	}

	EmitStream(w, "检测到新版本，开始重建容器…")

	cli.ContainerStop(ctx, containerID, container.StopOptions{})               //nolint:errcheck
	cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}) //nolint:errcheck

	resp, err := cli.ContainerCreate(ctx, info.Config, info.HostConfig, nil, nil, info.Name)
	if err != nil {
		return "", fmt.Errorf("创建容器失败: %w", err)
	}
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("启动容器失败: %w", err)
	}

	EmitStream(w, "✓ 升级完成，新容器 ID: %s", shortID(resp.ID))
	return resp.ID, nil
}

// GetByFilters returns containers matching given label/name filters.
func GetByFilters(ctx context.Context, cli *client.Client, args filters.Args) ([]container.Summary, error) {
	return cli.ContainerList(ctx, container.ListOptions{All: true, Filters: args})
}
