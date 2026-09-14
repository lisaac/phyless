package container

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"testing"

	types "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

type helperClient struct {
	client.APIClient
	copyCalls int
	copyData  bytes.Buffer
	execCmd   []string
	execCode  int
	execRun   bool
}

func (c *helperClient) CopyToContainer(_ context.Context, _ string, _ string, content io.Reader, _ container.CopyToContainerOptions) error {
	c.copyCalls++
	_, err := io.Copy(&c.copyData, content)
	return err
}

func (c *helperClient) ContainerExecCreate(_ context.Context, _ string, opts container.ExecOptions) (container.ExecCreateResponse, error) {
	c.execCmd = append([]string(nil), opts.Cmd...)
	return container.ExecCreateResponse{ID: "exec"}, nil
}

func (c *helperClient) ContainerExecStart(context.Context, string, container.ExecStartOptions) error {
	return nil
}

func (c *helperClient) ContainerExecInspect(context.Context, string) (container.ExecInspect, error) {
	return container.ExecInspect{Running: c.execRun, ExitCode: c.execCode}, nil
}

func TestUploadTarFileBoundsAndStreams(t *testing.T) {
	c := &helperClient{}
	if err := UploadTarFile(context.Background(), c, "id", "/", "hello.txt", bytes.NewBufferString("hello"), 5); err != nil {
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
			err := UploadTarFile(context.Background(), c, "id", "/", tc.name, bytes.NewBufferString(tc.body), 5)
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
	if err := UploadTarFile(context.Background(), client, "id", "/", "hello.txt", bytes.NewBufferString("hello"), 10); err == nil {
		t.Fatal("expected producer error when Docker stops reading early")
	}
}

type earlyReturnClient struct{ client.APIClient }

func (*earlyReturnClient) CopyToContainer(context.Context, string, string, io.Reader, container.CopyToContainerOptions) error {
	return nil
}

func TestExecCheckedReturnsExitCodeAndPreservesArgv(t *testing.T) {
	c := &helperClient{execCode: 7}
	err := ExecChecked(context.Background(), c, "id", []string{"rm", "-rf", "--", "-danger"})
	if err == nil || c.execCmd[len(c.execCmd)-1] != "-danger" {
		t.Fatalf("error=%v cmd=%v", err, c.execCmd)
	}
	if got := err.Error(); got != "exec exited with status 7" {
		t.Fatalf("error=%q", got)
	}
}

type lsClient struct {
	helperClient
	output []byte
}

func (c *lsClient) ContainerExecAttach(context.Context, string, container.ExecAttachOptions) (types.HijackedResponse, error) {
	server, client := net.Pipe()
	go func() {
		_, _ = server.Write(c.output)
		_ = server.Close()
	}()
	return types.HijackedResponse{Conn: client, Reader: bufio.NewReader(client)}, nil
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
	entries, err := ExecListDir(context.Background(), c, "id", "/")
	if err != nil || len(entries) != 1 || entries[0].Name != "file" {
		t.Fatalf("entries=%v err=%v", entries, err)
	}

	c = &lsClient{output: frame}
	c.execCode = 3
	if _, err := ExecListDir(context.Background(), c, "id", "/"); err == nil {
		t.Fatal("nonzero ls exit was accepted")
	}
}
