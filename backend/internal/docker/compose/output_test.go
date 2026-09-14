package compose

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
)

func TestNDJSONWriterSerializesConcurrentComposeOutput(t *testing.T) {
	var output bytes.Buffer
	writer := NewNDJSONWriter(&output)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = writer.Write([]byte("service output\n"))
		}(i)
	}
	wg.Wait()
	writer.Flush()

	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != 8 {
		t.Fatalf("got %d output lines, want 8", len(lines))
	}
	for _, line := range lines {
		var event struct {
			Stream string `json:"stream"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatalf("invalid NDJSON: %v", err)
		}
		if event.Stream != "service output" {
			t.Fatalf("stream = %q", event.Stream)
		}
	}
}

func TestNDJSONWriterBoundsLongLineWrites(t *testing.T) {
	var output bytes.Buffer
	writer := NewNDJSONWriter(&output)
	input := bytes.Repeat([]byte{'x'}, 2*maxPendingOutput+17)
	if _, err := writer.Write(append(input, '\n')); err != nil {
		t.Fatal(err)
	}
	writer.Flush()

	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != 3 {
		t.Fatalf("got %d output chunks, want 3", len(lines))
	}
	var reconstructed bytes.Buffer
	for _, line := range lines {
		var event struct {
			Stream string `json:"stream"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatalf("invalid NDJSON: %v", err)
		}
		if len(event.Stream) > maxPendingOutput {
			t.Fatalf("stream chunk has %d bytes, want <= %d", len(event.Stream), maxPendingOutput)
		}
		reconstructed.WriteString(event.Stream)
	}
	if !bytes.Equal(reconstructed.Bytes(), input) {
		t.Fatalf("reconstructed stream differs from input")
	}
}
