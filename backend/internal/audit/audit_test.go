package audit_test

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"

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
