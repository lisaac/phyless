package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"phyless/internal/docker"

	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

const (
	// imageLoadEOF is the text frame a client sends after the final tar byte.
	// Only this marker completes the input; any earlier read error aborts, so a
	// dropped connection can never be mistaken for a complete archive.
	imageLoadEOF = "__eof__"
	// maxImageLoadFrame bounds a single client tar frame. The browser chunks the
	// stream well below this; the pipe below provides real backpressure.
	maxImageLoadFrame = 8 << 20
	// imageLoadIdleTimeout bounds the gap between client frames so an idle or
	// stalled connection cannot pin the goroutine and its pending ImageLoad.
	imageLoadIdleTimeout = 2 * time.Minute
	safeLoadMessage      = "镜像导入失败"
)

// imageLoader is the only Docker method this endpoint needs. Narrowing the
// dependency keeps the handler testable with a tiny fake while *docker.Client
// (which embeds client.APIClient) still satisfies it.
type imageLoader interface {
	ImageLoad(ctx context.Context, input io.Reader, opts ...dockerclient.ImageLoadOption) (image.LoadResponse, error)
}

// ImageLoad streams a browser-assembled docker-load tar into the daemon over a
// WebSocket: binary frames are piped straight into ImageLoad with no buffering
// or disk, and daemon progress is forwarded back (with error events redacted).
func ImageLoad(cli imageLoader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetReadLimit(maxImageLoadFrame)

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		pr, pw := io.Pipe()
		sink := &loadProgressSink{conn: conn}
		var loadErr error
		done := make(chan struct{})
		go func() {
			defer close(done)
			resp, err := cli.ImageLoad(ctx, pr)
			if err != nil {
				loadErr = err
				// Unblock the frame reader if ImageLoad fails before draining.
				_ = pr.CloseWithError(err)
				return
			}
			defer resp.Body.Close()
			loadErr = docker.ConsumeProgress(ctx, sink, resp.Body)
		}()

		readErr := readFramesToPipe(conn, pw)
		if readErr != nil {
			cancel()
			_ = pw.CloseWithError(readErr)
		} else {
			_ = pw.Close()
		}
		<-done

		// Only one goroutine writes to the socket at a time: the load goroutine
		// during streaming, then this line after <-done. Never concurrently.
		switch {
		case readErr == nil && loadErr == nil:
			_ = WriteMessage(conn, websocket.TextMessage, []byte(`{"status":"done"}`))
		case !sink.errored:
			_ = WriteMessage(conn, websocket.TextMessage, redactedError())
		}
	}
}

// readFramesToPipe copies client binary frames into the pipe until the explicit
// EOF marker. Any read error before the marker is returned so a partial upload
// aborts the load instead of importing a truncated archive.
func readFramesToPipe(conn *websocket.Conn, pw *io.PipeWriter) error {
	for {
		// Refresh the idle deadline before each frame: a client that stops
		// sending (or never starts) trips this instead of pinning the handler.
		if err := conn.SetReadDeadline(time.Now().Add(imageLoadIdleTimeout)); err != nil {
			return err
		}
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		switch mt {
		case websocket.BinaryMessage:
			if _, werr := pw.Write(data); werr != nil {
				return werr
			}
		case websocket.TextMessage:
			if string(data) == imageLoadEOF {
				return nil
			}
		}
	}
}

// loadProgressSink forwards daemon progress frames but never leaks a daemon
// error message verbatim: an error event may carry a signed registry URL or a
// token, so it is replaced with a fixed safe message.
type loadProgressSink struct {
	conn    *websocket.Conn
	errored bool
}

func (s *loadProgressSink) Write(p []byte) (int, error) {
	line := bytes.TrimSpace(p)
	var event struct {
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if json.Unmarshal(line, &event) == nil && (event.Error != "" || event.ErrorDetail != nil) {
		s.errored = true
		if err := WriteMessage(s.conn, websocket.TextMessage, redactedError()); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	if err := WriteMessage(s.conn, websocket.TextMessage, line); err != nil {
		return 0, err
	}
	return len(p), nil
}

func redactedError() []byte {
	b, _ := json.Marshal(struct {
		Error string `json:"error"`
	}{Error: safeLoadMessage})
	return b
}
