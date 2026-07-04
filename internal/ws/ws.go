package ws

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // ponytail: lock down with allowed origins in prod
}

// Logs streams container logs over WebSocket.
func Logs(cli *client.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		rc, err := cli.ContainerLogs(r.Context(), id, container.LogsOptions{
			ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true,
		})
		if err != nil {
			conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		defer rc.Close()

		buf := make([]byte, 4096)
		for {
			n, err := rc.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
			if err != nil {
				return
			}
		}
	}
}

// Terminal runs an exec session and pipes stdin/stdout over WebSocket.
// Query params: cmd (space-separated, default "/bin/sh"), user (default "")
func Terminal(cli *client.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

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
			conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}

		resp, err := cli.ContainerExecAttach(ctx, execID.ID, container.ExecAttachOptions{Tty: true})
		if err != nil {
			conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		// Close the full underlying conn (not just write side) so Docker detects
		// the disconnect and sends SIGHUP to the exec process, killing it.
		defer resp.Conn.Close()

		// docker → websocket
		go func() {
			defer cancel() // unblock ReadMessage if docker side dies first
			buf := make([]byte, 4096)
			for {
				n, err := resp.Reader.Read(buf)
				if n > 0 {
					conn.WriteMessage(websocket.BinaryMessage, buf[:n])
				}
				if err != nil {
					return
				}
			}
		}()

		// websocket → docker (handle resize messages too)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				// WebSocket closed — send Ctrl-C + exit to terminate the shell process.
				resp.Conn.Write([]byte{3})
				resp.Conn.Write([]byte("exit\n"))
				return
			}
			// Check if it's a resize control message: {"type":"resize","cols":80,"rows":24}
			var ctrl struct {
				Type string `json:"type"`
				Cols uint   `json:"cols"`
				Rows uint   `json:"rows"`
			}
			if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "resize" {
				cli.ContainerExecResize(ctx, execID.ID, container.ResizeOptions{Height: ctrl.Rows, Width: ctrl.Cols})
				continue
			}
			resp.Conn.Write(msg)
		}
	}
}

// Stats streams container resource stats over WebSocket.
func Stats(cli *client.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		rc, err := cli.ContainerStats(r.Context(), id, true)
		if err != nil {
			return
		}
		defer rc.Body.Close()

		io.Copy(wsWriter{conn}, rc.Body) // ponytail: stream JSON stats lines directly
	}
}

// Events streams Docker daemon events over WebSocket.
func Events(cli *client.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		eventCh, errCh := cli.Events(r.Context(), events.ListOptions{})
		for {
			select {
			case e := <-eventCh:
				data, _ := json.Marshal(e)
				// Trailing newline so each event lands on its own line for
				// consumers that just concatenate raw text across messages
				// (shared/LogsView.tsx, reused by the events page) — without
				// it, back-to-back events would run together unreadably.
				conn.WriteMessage(websocket.TextMessage, append(data, '\n'))
			case <-errCh:
				return
			}
		}
	}
}

// wsWriter adapts WebSocket conn to io.Writer (one message per Write call).
type wsWriter struct{ conn *websocket.Conn }

func (w wsWriter) Write(p []byte) (int, error) {
	err := w.conn.WriteMessage(websocket.BinaryMessage, p)
	return len(p), err
}
