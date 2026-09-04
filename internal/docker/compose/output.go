package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sync"
)

const maxPendingOutput = 1 << 20

// NDJSONWriter adapts Compose's plain progress stream to the API's existing
// newline-delimited {stream: ...} contract. It serializes concurrent writes
// because Compose deliberately emits progress from multiple goroutines.
type NDJSONWriter struct {
	dst     io.Writer
	cancel  context.CancelFunc
	mu      sync.Mutex
	pending []byte
	err     error
}

func NewNDJSONWriter(dst io.Writer, cancel ...context.CancelFunc) *NDJSONWriter {
	var stop context.CancelFunc
	if len(cancel) > 0 {
		stop = cancel[0]
	}
	return &NDJSONWriter{dst: dst, cancel: stop}
}

func (w *NDJSONWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	total := len(p)

	if w.dst == nil {
		return total, nil
	}
	if w.err != nil {
		return 0, w.err
	}
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i >= 0 {
			if err := w.appendBounded(p[:i]); err != nil {
				return 0, err
			}
			if err := w.emitPending(); err != nil {
				return 0, err
			}
			p = p[i+1:]
			continue
		}
		if err := w.appendBounded(p); err != nil {
			return 0, err
		}
		break
	}
	return total, nil
}

// appendBounded appends data without allowing pending to exceed the memory
// bound. Full chunks are emitted immediately; the final partial chunk remains
// pending until a newline or Flush. Splitting a single very long line into
// multiple stream events is intentional and bounds progress buffering.
func (w *NDJSONWriter) appendBounded(p []byte) error {
	for len(p) > 0 {
		space := maxPendingOutput - len(w.pending)
		if space <= 0 {
			if err := w.emitPending(); err != nil {
				return err
			}
			continue
		}
		n := len(p)
		if n > space {
			n = space
		}
		w.pending = append(w.pending, p[:n]...)
		p = p[n:]
		if len(p) > 0 {
			if err := w.emitPending(); err != nil {
				return err
			}
		}
	}
	return nil
}

// Flush emits a final partial line and forwards Flush to HTTP writers.
func (w *NDJSONWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending) > 0 {
		_ = w.emitPending()
	}
	if f, ok := w.dst.(interface{ Flush() }); ok {
		f.Flush()
	}
}

// Err reports the first destination error seen by Write or Flush. Compose's
// progress renderer intentionally ignores io.Writer errors, so handlers must
// check this explicitly after the operation.
func (w *NDJSONWriter) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (w *NDJSONWriter) emitPending() error {
	line := w.pending
	w.pending = nil
	return w.emit(line)
}

func (w *NDJSONWriter) emit(line []byte) error {
	event := struct {
		Stream string `json:"stream,omitempty"`
	}{Stream: string(line)}
	if err := json.NewEncoder(w.dst).Encode(event); err != nil {
		return w.recordError(err)
	}
	if f, ok := w.dst.(interface{ Flush() }); ok {
		f.Flush()
	}
	return nil
}

func (w *NDJSONWriter) recordError(err error) error {
	if err == nil {
		return nil
	}
	if w.err == nil {
		w.err = err
		if w.cancel != nil {
			w.cancel()
		}
	}
	return w.err
}
