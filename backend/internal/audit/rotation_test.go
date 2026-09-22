package audit

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestRotationRetainsNewestEntriesAcrossFiles(t *testing.T) {
	l := New(filepath.Join(t.TempDir(), "audit.log"))
	l.maxBytes = 150 // one entry per file
	l.backups = 2
	for i := 0; i < 6; i++ {
		if err := l.Log("user", "action", "target", strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := l.ReadTail(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[0].Result != "3" || entries[2].Result != "5" {
		t.Fatalf("tail=%+v", entries)
	}
	for _, suffix := range []string{"", ".1", ".2"} {
		info, err := os.Stat(l.path + suffix)
		if err != nil || info.Size() > l.maxBytes {
			t.Fatalf("size limit: %v, %v", info, err)
		}
	}
	if _, err := os.Stat(l.path + ".3"); !os.IsNotExist(err) {
		t.Fatalf("unexpected third backup: %v", err)
	}
	// A blocked rotation must leave the active file intact.
	if err := os.Remove(l.path + ".2"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(l.path+".2", 0700); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(l.path)
	if err := l.Log("user", "action", "target", "blocked"); err == nil {
		t.Fatal("expected rotation error")
	}
	after, _ := os.ReadFile(l.path)
	if string(before) != string(after) {
		t.Fatal("failed rotation lost active log")
	}
}
