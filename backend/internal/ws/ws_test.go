package ws

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/moby/moby/api/pkg/stdcopy"
)

func TestCopyContainerLogsDemuxesNonTTYFrames(t *testing.T) {
	var source bytes.Buffer
	writeStdFrame(&source, stdcopy.Stdout, "out\n")
	writeStdFrame(&source, stdcopy.Stderr, "err\n")
	var out bytes.Buffer
	if _, err := copyContainerLogs(&out, &source, false); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "out\nerr\n" {
		t.Fatalf("demuxed logs = %q", got)
	}

	out.Reset()
	if _, err := copyContainerLogs(&out, strings.NewReader("raw tty\n"), true); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "raw tty\n" {
		t.Fatalf("tty logs = %q", got)
	}
}

// writeStdFrame writes one Docker multiplexed-stream frame (the SDK no longer
// exports NewStdWriter): [stream, 0, 0, 0, big-endian uint32 length] + payload.
func writeStdFrame(w *bytes.Buffer, stream stdcopy.StdType, payload string) {
	header := [8]byte{byte(stream)}
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	w.Write(header[:])
	w.WriteString(payload)
}

func TestStreamJSONFramesKeepsOneStatsObjectPerMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err := streamJSONFrames(conn, &oneByteReader{data: []byte("{\"cpu\":1}\n{\"cpu\":2}\n")}); err != nil {
			t.Errorf("stream stats: %v", err)
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for i, want := range []string{`{"cpu":1}`, `{"cpu":2}`} {
		kind, got, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind != websocket.BinaryMessage || string(got) != want {
			t.Fatalf("frame %d = (%d, %q)", i, kind, got)
		}
	}
}

func TestMonitorConnectionCancelsOnClientClose(t *testing.T) {
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ctx, stop := MonitorConnection(context.Background(), conn)
		defer stop()
		<-ctx.Done()
		close(done)
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor did not cancel after client close")
	}
}

type oneByteReader struct{ data []byte }

func (r *oneByteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	p[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}
