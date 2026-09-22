package imagefs

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"testing"
)

// A synthetic 10k-file tree measures local index cost, not daemon throughput.
func BenchmarkDiskIndex(b *testing.B) {
	var data bytes.Buffer
	tw := tar.NewWriter(&data)
	for i := range 10000 {
		if err := tw.WriteHeader(&tar.Header{Name: fmt.Sprintf("dir-%d/file-%d", i/100, i), Mode: 0644}); err != nil {
			b.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		b.Fatal(err)
	}
	b.Run("build", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(data.Len()))
		for range b.N {
			f, err := buildIndex(bytes.NewReader(data.Bytes()))
			if err != nil {
				b.Fatal(err)
			}
			f.Close()
		}
	})
	f, err := buildIndex(bytes.NewReader(data.Bytes()))
	if err != nil {
		b.Fatal(err)
	}
	defer f.Close()
	b.Run("list100", func(b *testing.B) {
		b.ReportAllocs()
		for range b.N {
			entries, err := listIndex(context.Background(), f, "/dir-50")
			if err != nil || len(entries) != 100 {
				b.Fatalf("entries=%d err=%v", len(entries), err)
			}
		}
	})
}
