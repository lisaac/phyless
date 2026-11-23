package container

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

type helperClient struct {
	client.APIClient
	copyCalls int
	copyData  bytes.Buffer
	execCmd   []string
	execUser  string
	execCode  int
	execRun   bool
}

func (c *helperClient) CopyToContainer(_ context.Context, _ string, opts client.CopyToContainerOptions) (client.CopyToContainerResult, error) {
	c.copyCalls++
	_, err := io.Copy(&c.copyData, opts.Content)
	return client.CopyToContainerResult{}, err
}

func (c *helperClient) ExecCreate(_ context.Context, _ string, opts client.ExecCreateOptions) (client.ExecCreateResult, error) {
	c.execCmd = append([]string(nil), opts.Cmd...)
	c.execUser = opts.User
	return client.ExecCreateResult{ID: "exec"}, nil
}

func (c *helperClient) ExecStart(context.Context, string, client.ExecStartOptions) (client.ExecStartResult, error) {
	return client.ExecStartResult{}, nil
}

func (c *helperClient) ExecInspect(context.Context, string, client.ExecInspectOptions) (client.ExecInspectResult, error) {
	return client.ExecInspectResult{Running: c.execRun, ExitCode: c.execCode}, nil
}

func TestUploadTarFileBoundsAndStreams(t *testing.T) {
	c := &helperClient{}
	if err := UploadTarFile(context.Background(), c, "id", "/", "hello.txt", bytes.NewBufferString("hello"), 5, nil); err != nil {
		t.Fatal(err)
	}
	archive := append([]byte(nil), c.copyData.Bytes()...)
	hdr, err := tar.NewReader(bytes.NewReader(archive)).Next()
	if err != nil || hdr.Name != "hello.txt" || hdr.Size != 5 {
		t.Fatalf("header=%#v err=%v", hdr, err)
	}
	tr := tar.NewReader(bytes.NewReader(archive))
	if _, err := tr.Next(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(tr)
	if err != nil || string(data) != "hello" {
		t.Fatalf("content=%q err=%v", data, err)
	}
	if c.copyCalls != 1 {
		t.Fatalf("copy calls=%d", c.copyCalls)
	}
}

// An editor save keeps the overwritten file's mode and owner.
func TestUploadTarFileKeepsMeta(t *testing.T) {
	c := &helperClient{}
	meta := &tar.Header{Mode: 0o755, Uid: 1000, Gid: 33}
	if err := UploadTarFile(context.Background(), c, "id", "/", "run.sh", bytes.NewBufferString("hi"), 5, meta); err != nil {
		t.Fatal(err)
	}
	hdr, err := tar.NewReader(&c.copyData).Next()
	if err != nil || hdr.Name != "run.sh" || hdr.Size != 2 || hdr.Mode != 0o755 || hdr.Uid != 1000 || hdr.Gid != 33 {
		t.Fatalf("header=%#v err=%v", hdr, err)
	}
}

func TestUploadTarFileOverflowAndFilenameDoNotCallDocker(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want error
	}{
		{name: "hello.txt", body: "123456", want: ErrUploadTooLarge},
		{name: "../escape", body: "ok", want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &helperClient{}
			err := UploadTarFile(context.Background(), c, "id", "/", tc.name, bytes.NewBufferString(tc.body), 5, nil)
			if tc.want == ErrUploadTooLarge {
				if !errors.Is(err, ErrUploadTooLarge) {
					t.Fatalf("error=%v", err)
				}
			} else if err == nil {
				t.Fatal("expected invalid filename")
			}
			if c.copyCalls != 0 {
				t.Fatalf("Docker called %d times", c.copyCalls)
			}
		})
	}
}

func TestUploadTarFileRejectsEarlySuccessfulConsumer(t *testing.T) {
	// The helper client consumes the pipe in CopyToContainer; an immediate
	// success is modeled below to verify the producer cannot remain blocked.
	client := &earlyReturnClient{}
	if err := UploadTarFile(context.Background(), client, "id", "/", "hello.txt", bytes.NewBufferString("hello"), 10, nil); err == nil {
		t.Fatal("expected producer error when Docker stops reading early")
	}
}

type earlyReturnClient struct{ client.APIClient }

func (*earlyReturnClient) CopyToContainer(context.Context, string, client.CopyToContainerOptions) (client.CopyToContainerResult, error) {
	return client.CopyToContainerResult{}, nil
}

type lsClient struct {
	helperClient
	output []byte
}

func (c *lsClient) ExecAttach(context.Context, string, client.ExecAttachOptions) (client.ExecAttachResult, error) {
	server, conn := net.Pipe()
	go func() {
		_, _ = server.Write(c.output)
		_ = server.Close()
	}()
	return client.ExecAttachResult{HijackedResponse: client.HijackedResponse{Conn: conn, Reader: bufio.NewReader(conn)}}, nil
}

func TestExecListDirChecksStreamAndExit(t *testing.T) {
	payload := []byte("-rw-r--r-- 1 root root 4 Jan  2 2026 file\n")
	frame := make([]byte, 8+len(payload))
	frame[0] = 1 // stdout
	frame[4] = byte(len(payload) >> 24)
	frame[5] = byte(len(payload) >> 16)
	frame[6] = byte(len(payload) >> 8)
	frame[7] = byte(len(payload))
	copy(frame[8:], payload)
	c := &lsClient{output: frame}
	entries, err := ExecLs(context.Background(), c, "id", "/")
	if err != nil || len(entries) != 1 || entries[0].Name != "file" {
		t.Fatalf("entries=%v err=%v", entries, err)
	}

	c = &lsClient{output: frame}
	c.execCode = 3
	if _, err := ExecLs(context.Background(), c, "id", "/"); err == nil {
		t.Fatal("nonzero ls exit was accepted")
	}

	c = &lsClient{output: frame}
	c.execCode = 1 // some entries unreadable: the rest still lists
	if entries, err := ExecLs(context.Background(), c, "id", "/"); err != nil || len(entries) != 1 {
		t.Fatalf("partial ls rejected: entries=%v err=%v", entries, err)
	}

	c = &lsClient{output: frame}
	c.execCode = 127
	if _, err := ExecLs(context.Background(), c, "id", "/"); !errors.Is(err, ErrExecNotFound) {
		t.Fatalf("missing ls not reported as ErrExecNotFound: %v", err)
	}
}

func TestExecRootRunsAsRootAndReportsStderr(t *testing.T) {
	msg := []byte("mv: can't rename '-danger': Permission denied\n")
	frame := append([]byte{2, 0, 0, 0, 0, 0, 0, byte(len(msg))}, msg...) // stderr
	c := &lsClient{output: frame}
	c.execCode = 1
	err := ExecRoot(context.Background(), c, "id", []string{"mv", "--", "-danger", "/b"})
	if c.execUser != "0" || c.execCmd[2] != "-danger" {
		t.Fatalf("user=%q cmd=%v", c.execUser, c.execCmd)
	}
	if err == nil || !strings.Contains(err.Error(), "Permission denied") {
		t.Fatalf("error=%v", err)
	}
	c = &lsClient{}
	c.execCode = 127
	if err := ExecRoot(context.Background(), c, "id", []string{"chown"}); !errors.Is(err, ErrExecNotFound) {
		t.Fatalf("missing tool: %v", err)
	}
	c = &lsClient{}
	if err := ExecRoot(context.Background(), c, "id", []string{"rm"}); err != nil {
		t.Fatal(err)
	}
}

// An empty directory (only . and ..) must encode as [], not null: the
// frontend decorates the listing array and choked on null (empty volumes
// spun forever).
func TestParseLsEmptyDirIsEmptySlice(t *testing.T) {
	out, err := ParseLs(strings.NewReader("total 8\ndrwxr-xr-x    2 999      999           4096 Jul  2 02:30 .\ndrwxr-xr-x    1 0        0             4096 Oct 27 02:39 ..\n"))
	if err != nil || out == nil || len(out) != 0 {
		t.Fatalf("got %#v, %v; want empty non-nil slice", out, err)
	}
}
