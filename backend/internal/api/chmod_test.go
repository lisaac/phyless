package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChmodHostNeverFollowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "sub")
	_ = os.Mkdir(sub, 0o700)
	_ = os.WriteFile(filepath.Join(sub, "f"), nil, 0o600)
	_ = os.Symlink(outside, filepath.Join(sub, "link"))

	if err := chmodHost(filepath.Join(sub, "link"), chmodBody{Mode: "777"}); err == nil {
		t.Fatal("chmod through a symlink accepted")
	}
	if err := chmodHost(sub, chmodBody{Mode: "2755", Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(filepath.Join(sub, "f")); st.Mode() != os.ModeSetgid|0o755 {
		t.Fatalf("f mode=%v", st.Mode())
	}
	if st, _ := os.Stat(outside); st.Mode().Perm() != 0o600 {
		t.Fatalf("symlink target changed: %v", st.Mode())
	}
}
