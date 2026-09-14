package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ConsumeProgress forwards bounded Docker NDJSON messages and checks errors
// carried inside an otherwise successful HTTP response. It owns src.
func ConsumeProgress(ctx context.Context, dst io.Writer, src io.ReadCloser) error {
	defer src.Close()
	stop := context.AfterFunc(ctx, func() { _ = src.Close() })
	defer stop()
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if bytes.Equal(bytes.TrimSpace(line), []byte("null")) {
			return errors.New("invalid Docker progress response: expected an object")
		}
		var event struct {
			Error       string `json:"error"`
			ErrorDetail *struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			return fmt.Errorf("invalid Docker progress response: %w", err)
		}
		out := append(line, '\n')
		if n, err := dst.Write(out); err != nil {
			return err
		} else if n != len(out) {
			return io.ErrShortWrite
		}
		if f, ok := dst.(interface{ Flush() }); ok {
			f.Flush()
		}
		if event.ErrorDetail != nil {
			message := event.ErrorDetail.Message
			if message == "" {
				message = "Docker progress reported an error"
			}
			return errors.New(message)
		}
		if event.Error != "" {
			return errors.New(event.Error)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return scanner.Err()
}
