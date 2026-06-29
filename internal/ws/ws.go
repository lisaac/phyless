package ws

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

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
func Terminal(cli *client.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		ctx := context.Background()
		execID, err := cli.ContainerExecCreate(ctx, id, container.ExecOptions{
			AttachStdin: true, AttachStdout: true, AttachStderr: true,
			Tty: true, Cmd: []string{"/bin/sh"},
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
		defer resp.Close()

		// docker → websocket
		go func() {
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
				conn.WriteMessage(websocket.TextMessage, data)
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
