package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"phyless/backend/internal/audit"
	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

func composeFileServer(t *testing.T, dir string) *Server {
	t.Helper()
	s := store.New(filepath.Join(t.TempDir(), "config.json"))
	if err := s.Write(&store.Config{ComposeProjects: []models.ComposeProject{{ID: "files", Name: "files", BaseDir: dir}}}); err != nil {
		t.Fatal(err)
	}
	return &Server{store: s, audit: audit.New(filepath.Join(t.TempDir(), "audit.log"))}
}

func TestComposeOversizeWritePreservesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	s := composeFileServer(t, dir)
	r := httptest.NewRequest(http.MethodPut, "/api/compose/files/content?id=files&path=compose.yaml", strings.NewReader(strings.Repeat("x", (10<<20)+1)))
	w := httptest.NewRecorder()
	s.handleComposePutFileContent(w, r)
	data, err := os.ReadFile(path)
	if w.Code != http.StatusRequestEntityTooLarge || err != nil || string(data) != "original" {
		t.Fatalf("oversized upload: status=%d error=%v original_preserved=%v", w.Code, err, string(data) == "original")
	}
}

func TestComposeCannotDeleteNormalizedProjectRoot(t *testing.T) {
	dir := t.TempDir()
	s := composeFileServer(t, dir+string(os.PathSeparator))
	w := httptest.NewRecorder()
	s.handleComposeDeleteFile(w, httptest.NewRequest(http.MethodDelete, "/api/compose/files?id=files&path=.", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("root deletion status=%d", w.Code)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("root was removed: %v", err)
	}
}
