package ws

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

type fakeLoader struct {
	mu       sync.Mutex
	received bytes.Buffer
	progress string
}

func (f *fakeLoader) ImageLoad(_ context.Context, input io.Reader, _ ...dockerclient.ImageLoadOption) (image.LoadResponse, error) {
	if _, err := io.Copy(&f.received, input); err != nil {
		return image.LoadResponse{}, err
	}
	return image.LoadResponse{Body: io.NopCloser(strings.NewReader(f.progress))}, nil
}

func (f *fakeLoader) got() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.received.String()
}

// dialImageLoad starts the handler and returns a connected client plus a
// channel closed when the handler returns (to detect leaks/hangs).
func dialImageLoad(t *testing.T, cli imageLoader) (*websocket.Conn, chan struct{}) {
	t.Helper()
	handlerDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		ImageLoad(cli)(w, r)
	}))
	t.Cleanup(server.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, handlerDone
}

func readFrames(t *testing.T, conn *websocket.Conn) []string {
	t.Helper()
	var frames []string
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return frames
		}
		frames = append(frames, string(data))
	}
}

func TestImageLoadPipesFramesAndReportsDone(t *testing.T) {
	fake := &fakeLoader{progress: `{"stream":"Loaded image: nginx:latest\n"}` + "\n"}
	conn, handlerDone := dialImageLoad(t, fake)

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("hello-")); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("world")); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(imageLoadEOF)); err != nil {
		t.Fatal(err)
	}

	frames := readFrames(t, conn)
	if got := fake.got(); got != "hello-world" {
		t.Fatalf("daemon received %q, want %q", got, "hello-world")
	}
	joined := strings.Join(frames, "|")
	if !strings.Contains(joined, "Loaded image") {
		t.Fatalf("missing progress frame in %q", joined)
	}
	if !strings.Contains(joined, `{"status":"done"}`) {
		t.Fatalf("missing done frame in %q", joined)
	}
	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return")
	}
}

func TestImageLoadRedactsDaemonError(t *testing.T) {
	fake := &fakeLoader{progress: `{"errorDetail":{"message":"https://signed.example/secret?token=abc"},"error":"boom"}` + "\n"}
	conn, _ := dialImageLoad(t, fake)

	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("data"))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(imageLoadEOF))

	joined := strings.Join(readFrames(t, conn), "|")
	if strings.Contains(joined, "signed.example") || strings.Contains(joined, "token=abc") || strings.Contains(joined, "boom") {
		t.Fatalf("leaked daemon error detail: %q", joined)
	}
	if !strings.Contains(joined, safeLoadMessage) {
		t.Fatalf("missing redacted error in %q", joined)
	}
	if strings.Contains(joined, `"status":"done"`) {
		t.Fatalf("reported done despite error: %q", joined)
	}
}

func TestImageLoadAbortsOnClientCloseWithoutEOF(t *testing.T) {
	fake := &fakeLoader{progress: `{"status":"ignored"}` + "\n"}
	conn, handlerDone := dialImageLoad(t, fake)

	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("partial"))
	// Close without sending the EOF marker: a truncated upload must not import.
	_ = conn.Close()

	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("handler leaked after client abort")
	}
}
