package ws

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

const (
	// MaxMessageSize limits client-to-server control/input frames. Docker output
	// is streamed in bounded writes and is not subject to this client limit.
	MaxMessageSize    = 64 << 10
	MaxStatsFrameSize = 1 << 20
	writeWait         = 10 * time.Second
)

var upgrader = websocket.Upgrader{}

// ConfigureConnection applies the shared client-frame limit. Callers that
// own another WebSocket endpoint (for example Compose logs) can reuse it.
func ConfigureConnection(conn *websocket.Conn) {
	conn.SetReadLimit(MaxMessageSize)
}

// WriteMessage sets a bounded write deadline before sending one complete
// WebSocket frame. A slow client must not hold a Docker stream forever.
func WriteMessage(conn *websocket.Conn, messageType int, data []byte) error {
	if err := conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}
	return conn.WriteMessage(messageType, data)
}

// MonitorConnection consumes control frames so close/ping handling keeps
// working while the handler is blocked in an upstream Docker read. The
// returned stop function cancels the context and closes the socket.
func MonitorConnection(parent context.Context, conn *websocket.Conn) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			_ = conn.Close()
		})
	}
	ConfigureConnection(conn)
	go func() {
		defer stop()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	go func() {
		select {
		case <-parent.Done():
			stop()
		case <-ctx.Done():
		}
	}()
	return ctx, stop
}

// Logs streams container logs over WebSocket.
func Logs(cli client.APIClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ctx, stop := MonitorConnection(r.Context(), conn)
		defer stop()

		info, err := cli.ContainerInspect(ctx, id)
		if err != nil {
			_ = WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		rc, err := cli.ContainerLogs(ctx, id, container.LogsOptions{
			ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true,
			Since: r.URL.Query().Get("since"), Until: r.URL.Query().Get("until"),
		})
		if err != nil {
			_ = WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		defer rc.Close()
		go func() {
			<-ctx.Done()
			_ = rc.Close()
		}()

		out := wsWriter{conn: conn}
		_, _ = copyContainerLogs(out, rc, info.Config != nil && info.Config.Tty)
	}
}

func copyContainerLogs(dst io.Writer, src io.Reader, tty bool) (int64, error) {
	if tty {
		return io.Copy(dst, src)
	}
	// Docker multiplexes stdout/stderr for non-TTY containers. Decode the
	// 8-byte stream headers before forwarding payload bytes to the browser.
	return stdcopy.StdCopy(dst, dst, src)
}

// Terminal runs an exec session and pipes stdin/stdout over WebSocket.
// Query params: cmd (space-separated, default "/bin/sh"), user (default "")
func Terminal(cli client.APIClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		ConfigureConnection(conn)

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		cmdStr := r.URL.Query().Get("cmd")
		cmd := []string{"/bin/sh"}
		if cmdStr != "" {
			cmd = strings.Fields(cmdStr)
		}
		execID, err := cli.ContainerExecCreate(ctx, id, container.ExecOptions{
			AttachStdin: true, AttachStdout: true, AttachStderr: true,
			Tty: true, Cmd: cmd, User: r.URL.Query().Get("user"),
		})
		if err != nil {
			_ = WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}

		resp, err := cli.ContainerExecAttach(ctx, execID.ID, container.ExecAttachOptions{Tty: true})
		if err != nil {
			_ = WriteMessage(conn, websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		defer resp.Close()

		// Either side ending must close both blocking reads. In particular,
		// Docker EOF must wake conn.ReadMessage instead of leaving the handler
		// and exec process behind indefinitely.
		var closeOnce sync.Once
		closeSession := func() {
			closeOnce.Do(func() {
				cancel()
				_ = resp.Conn.Close()
				_ = conn.Close()
			})
		}
		go func() {
			select {
			case <-r.Context().Done():
				closeSession()
			case <-ctx.Done():
			}
		}()

		// docker -> websocket: this is the only goroutine that writes data
		// frames to the WebSocket.
		go func() {
			buf := make([]byte, 4096)
			for {
				n, readErr := resp.Reader.Read(buf)
				if n > 0 {
					if writeErr := WriteMessage(conn, websocket.BinaryMessage, buf[:n]); writeErr != nil {
						closeSession()
						return
					}
				}
				if readErr != nil {
					closeSession()
					return
				}
			}
		}()

		// websocket -> docker (handle resize messages too)
		for {
			_, msg, readErr := conn.ReadMessage()
			if readErr != nil {
				closeSession()
				return
			}
			var ctrl struct {
				Type string `json:"type"`
				Cols uint   `json:"cols"`
				Rows uint   `json:"rows"`
			}
			if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "resize" {
				if err := cli.ContainerExecResize(ctx, execID.ID, container.ResizeOptions{Height: ctrl.Rows, Width: ctrl.Cols}); err != nil {
					closeSession()
					return
				}
				continue
			}
			if err := resp.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				closeSession()
				return
			}
			if err := writeAll(resp.Conn, msg); err != nil {
				closeSession()
				return
			}
		}
	}
}

// Stats streams one complete JSON object per WebSocket message.
func Stats(cli client.APIClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ctx, stop := MonitorConnection(r.Context(), conn)
		defer stop()

		rc, err := cli.ContainerStats(ctx, id, true)
		if err != nil {
			return
		}
		defer rc.Body.Close()
		go func() {
			<-ctx.Done()
			_ = rc.Body.Close()
		}()
		_, _ = streamJSONFrames(conn, rc.Body)
	}
}

// streamJSONFrames decodes line-delimited JSON values and emits each value as
// exactly one WebSocket frame. Scanner carries partial network reads while its
// maximum token size prevents a malformed stats line from growing memory.
func streamJSONFrames(conn *websocket.Conn, src io.Reader) (int, error) {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 32<<10), MaxStatsFrameSize)
	count := 0
	for scanner.Scan() {
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		if !json.Valid(raw) {
			return count, fmt.Errorf("invalid stats JSON")
		}
		if err := WriteMessage(conn, websocket.BinaryMessage, raw); err != nil {
			return count, err
		}
		count++
	}
	return count, scanner.Err()
}

// formatEvent renders one docker event as a single readable log line instead
// of raw JSON — shared/LogsView.tsx (reused for the events page) just pipes
// through whatever text arrives, so the formatting has to happen here where
// the typed events.Message fields are actually available.
func formatEvent(e events.Message) string {
	ts := time.Unix(e.Time, 0).Format("2006-01-02 15:04:05")
	name := e.Actor.Attributes["name"]
	if name == "" {
		name = e.Actor.ID
		if len(name) > 12 {
			name = name[:12]
		}
	}
	line := fmt.Sprintf("%s  %-10s %-12s %s", ts, e.Type, e.Action, name)
	if e.Type == events.ContainerEventType {
		if image := e.Actor.Attributes["image"]; image != "" {
			line += "  (" + image + ")"
		}
	}
	return line
}

// Events streams Docker daemon events over WebSocket. since/until (unix
// seconds, query params) let the events page show a past time range instead
// of only live-tailing — Docker replays history up to until (or now, if
// omitted) and then keeps streaming live only when until is unset/future.
func Events(cli client.APIClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ctx, stop := MonitorConnection(r.Context(), conn)
		defer stop()

		opts := events.ListOptions{
			Since: r.URL.Query().Get("since"),
			Until: r.URL.Query().Get("until"),
		}
		eventCh, errCh := cli.Events(ctx, opts)
		for eventCh != nil || errCh != nil {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-eventCh:
				if !ok {
					eventCh = nil
					continue
				}
				if err := WriteMessage(conn, websocket.TextMessage, []byte(formatEvent(e)+"\n")); err != nil {
					return
				}
			case streamErr, ok := <-errCh:
				if !ok {
					errCh = nil
					continue
				}
				if streamErr != nil {
					return
				}
			}
		}
	}
}

// wsWriter adapts WebSocket conn to io.Writer (one message per Write call).
type wsWriter struct{ conn *websocket.Conn }

func (w wsWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := WriteMessage(w.conn, websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if n > 0 {
			p = p[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
