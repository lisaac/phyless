package docker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestConsumeProgress(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"success", "{\"status\":\"done\"}", ""},
		{"error", "{\"error\":\"denied\"}\n", "denied"},
		{"detail", "{\"id\":\"abc\",\"status\":\"pull\",\"errorDetail\":{\"message\":\"denied\"}}\n", "denied"},
		{"malformed", "not json", "invalid Docker progress"},
		{"null", "null", "expected an object"},
		{"detail-without-message", `{"errorDetail":{"code":403}}`, "reported an error"},
		{"oversize", strings.Repeat("x", (1<<20)+1), "token too long"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := ConsumeProgress(context.Background(), &out, io.NopCloser(strings.NewReader(tc.input)))
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestConsumeProgressCancellationClosesReader(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r, w := io.Pipe()
	defer w.Close()
	done := make(chan error, 1)
	go func() { done <- ConsumeProgress(ctx, io.Discard, r) }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}

type shortProgressWriter struct{}

func (shortProgressWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestConsumeProgressRejectsShortWrites(t *testing.T) {
	err := ConsumeProgress(context.Background(), shortProgressWriter{}, io.NopCloser(strings.NewReader(`{"status":"done"}`)))
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("error = %v", err)
	}
}
