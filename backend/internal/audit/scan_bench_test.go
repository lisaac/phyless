package audit

import (
	"fmt"
	"strings"
	"testing"
)

func TestScanTailWrapsInChronologicalOrder(t *testing.T) {
	entries, err := scanTail(strings.NewReader("{\"result\":\"0\"}\ninvalid\n{\"result\":\"1\"}\n{\"result\":\"2\"}\n{\"result\":\"3\"}\n{\"result\":\"4\"}\n"), 2)
	if err != nil || len(entries) != 2 || entries[0].Result != "3" || entries[1].Result != "4" {
		t.Fatalf("entries=%+v err=%v", entries, err)
	}
}

func BenchmarkScanTail(b *testing.B) {
	var input strings.Builder
	for i := range 8000 {
		fmt.Fprintf(&input, "{\"time\":\"2026-09-22T00:00:00Z\",\"user\":\"admin\",\"action\":\"container.start\",\"target\":\"%d\",\"result\":\"ok\"}\n", i)
	}
	data := input.String()
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := scanTail(strings.NewReader(data), DefaultMaxEntries); err != nil {
			b.Fatal(err)
		}
	}
}
