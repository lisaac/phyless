package api

import (
	"archive/tar"
	"bytes"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"phyless/backend/internal/audit"
)

func TestReadBoundedRejectsOverflow(t *testing.T) {
	data, err := readBounded(strings.NewReader("abcd"), 4)
	if err != nil || string(data) != "abcd" {
		t.Fatalf("exact limit: data=%q err=%v", data, err)
	}
	data, err = readBounded(strings.NewReader("abcde"), 4)
	if !errors.Is(err, errRequestBodyTooLarge) || data != nil {
		t.Fatalf("overflow: data=%q err=%v", data, err)
	}
}

func TestAtomicWriteFileReplacesAndPreservesMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "existing.txt")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(path, []byte("new"), 0644); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "new" {
		t.Fatalf("content=%q err=%v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("mode=%#o, want 0600", got)
	}
	beforeStat, beforeOK := before.Sys().(*syscall.Stat_t)
	afterStat, afterOK := info.Sys().(*syscall.Stat_t)
	if beforeOK && afterOK && (beforeStat.Uid != afterStat.Uid || beforeStat.Gid != afterStat.Gid) {
		t.Fatalf("owner changed from %d:%d to %d:%d", beforeStat.Uid, beforeStat.Gid, afterStat.Uid, afterStat.Gid)
	}

	newPath := filepath.Join(dir, "new.txt")
	if err := atomicWriteFile(newPath, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0644 {
		t.Fatalf("new mode=%#o, want 0644", got)
	}
}

func TestFsPutFileOverflowLeavesOldFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.txt")
	const old = "keep me"
	if err := os.WriteFile(path, []byte(old), 0644); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("PUT", "/api/fs/file?path="+path, strings.NewReader(strings.Repeat("x", maxUploadSize+1)))
	w := httptest.NewRecorder()
	(&Server{}).handleFsPutFile(w, r)
	if w.Code != 413 {
		t.Fatalf("status = %d, want 413", w.Code)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != old {
		t.Fatalf("old file changed: %q err=%v", got, err)
	}
}

func TestFsPutNewEnvFileUsesPrivateMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	r := httptest.NewRequest("PUT", "/api/fs/file?path="+path, strings.NewReader("TOKEN=secret\n"))
	w := httptest.NewRecorder()
	(&Server{audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}).handleFsPutFile(w, r)
	info, err := os.Stat(path)
	if w.Code != 204 || err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("write status=%d mode=%v err=%v", w.Code, info, err)
	}
}

func TestStreamTarPreservesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	link := filepath.Join(dir, "link")
	if err := os.WriteFile(target, []byte("target"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target", link); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err := streamTar(&archive, link); err != nil {
		t.Fatal(err)
	}
	hdr, err := tar.NewReader(&archive).Next()
	if err != nil {
		t.Fatal(err)
	}
	if hdr.Typeflag != tar.TypeSymlink || hdr.Linkname != "target" {
		t.Fatalf("header = type %d link %q", hdr.Typeflag, hdr.Linkname)
	}
}

func TestStreamTarRejectsSpecialFile(t *testing.T) {
	var archive bytes.Buffer
	if err := writeTarFile(tar.NewWriter(&archive), "pipe", "pipe", specialFileInfo{}); err == nil {
		t.Fatal("expected special file error")
	}
}

type specialFileInfo struct{}

func (specialFileInfo) Name() string       { return "pipe" }
func (specialFileInfo) Size() int64        { return 0 }
func (specialFileInfo) Mode() os.FileMode  { return os.ModeNamedPipe }
func (specialFileInfo) ModTime() time.Time { return time.Time{} }
func (specialFileInfo) IsDir() bool        { return false }
func (specialFileInfo) Sys() any           { return nil }

func TestIsSubPathRejectsSymlinkComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if isSubPath(root, filepath.Join(root, "escape", "file")) {
		t.Fatal("symlink component accepted")
	}
	if !isSubPath(root, filepath.Join(root, "new", "file")) {
		t.Fatal("normal missing path rejected")
	}
}

func TestIsSubPathRejectsSymlinkRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root-link")
	if err := os.Symlink(t.TempDir(), root); err != nil {
		t.Fatal(err)
	}
	if isSubPath(root, filepath.Join(root, "file")) {
		t.Fatal("symlink root accepted")
	}
}

func TestFsFileRequiresAbsolutePath(t *testing.T) {
	r := httptest.NewRequest("PUT", "/api/fs/file?path=relative.txt", strings.NewReader("data"))
	w := httptest.NewRecorder()
	(&Server{}).handleFsPutFile(w, r)
	if w.Code != 403 {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestConfigRenameRejectsRoot(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/config/files/rename", strings.NewReader(`{"old_path":".","new_path":"moved"}`))
	w := httptest.NewRecorder()
	(&Server{}).handleConfigRenameFile(w, r)
	if w.Code != 403 {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestContainerMutationPathRejectsRootAliases(t *testing.T) {
	for _, raw := range []string{"", ".", "..", "/", "//", "/tmp/..", "relative"} {
		if validContainerMutationPath(raw) {
			t.Fatalf("path %q accepted", raw)
		}
	}
	for _, raw := range []string{"/tmp/file", "/tmp/..hidden"} {
		if !validContainerMutationPath(raw) {
			t.Fatalf("path %q rejected", raw)
		}
	}
}
