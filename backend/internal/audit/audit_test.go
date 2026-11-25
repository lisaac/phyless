package audit_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"phyless/backend/internal/audit"
)

func TestReadAllKeepsNewestBoundedEntries(t *testing.T) {
	logger := audit.New(filepath.Join(t.TempDir(), "audit.log"))
	for i := 0; i < audit.DefaultMaxEntries+5; i++ {
		if err := logger.Log("user", "action", "target", strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := logger.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != audit.DefaultMaxEntries || entries[0].Result != "5" {
		t.Fatalf("tail = %d entries, first result %q", len(entries), entries[0].Result)
	}
}

func TestLogReturnsOpenError(t *testing.T) {
	if err := audit.New(t.TempDir()).Log("user", "action", "target", "failed"); err == nil {
		t.Fatal("expected audit write error")
	}
}

func TestLogRejectsOversizeEntry(t *testing.T) {
	logger := audit.New(filepath.Join(t.TempDir(), "audit.log"))
	if err := logger.Log("user", "action", strings.Repeat("x", 70<<10), "result"); err == nil {
		t.Fatal("expected oversize audit entry error")
	}
}

func TestReadRangeFiltersAcrossRotatedFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audit.log")
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(h int) time.Time { return base.Add(time.Duration(h) * time.Hour) }
	// audit.log.2: hours 0-1, audit.log.1: hours 2-3, audit.log: hours 4-5.
	for i, hours := range [][]int{{4, 5}, {2, 3}, {0, 1}} {
		name := path
		if i > 0 {
			name += "." + strconv.Itoa(i)
		}
		var b strings.Builder
		for _, h := range hours {
			line, _ := json.Marshal(audit.Entry{Time: at(h).Format(time.RFC3339), Result: strconv.Itoa(h)})
			b.Write(append(line, '\n'))
		}
		if err := os.WriteFile(name, []byte(b.String()), 0600); err != nil {
			t.Fatal(err)
		}
		last := at(hours[len(hours)-1])
		if err := os.Chtimes(name, last, last); err != nil {
			t.Fatal(err)
		}
	}
	logger := audit.New(path)
	results := func(since, until time.Time) string {
		entries, err := logger.ReadRange(audit.DefaultMaxEntries, since, until)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, e := range entries {
			out = append(out, e.Result)
		}
		return strings.Join(out, ",")
	}
	for _, c := range []struct {
		since, until time.Time
		want         string
	}{
		{time.Time{}, time.Time{}, "0,1,2,3,4,5"},
		{at(3), time.Time{}, "3,4,5"},
		{time.Time{}, at(2), "0,1,2"},
		{at(1), at(4), "1,2,3,4"},
		{at(6), time.Time{}, ""},
	} {
		if got := results(c.since, c.until); got != c.want {
			t.Errorf("since %v until %v = %q, want %q", c.since, c.until, got, c.want)
		}
	}
}
