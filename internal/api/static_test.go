package api

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"phyless/web"
)

// The frontend is embedded at compile time, so this can only run against a
// binary built after `cd web && npm run build`.
func TestEmbeddedSPAServesIndexWithNoStore(t *testing.T) {
	if _, err := fs.Stat(web.Dist, "dist/index.html"); err != nil {
		t.Skip("web/dist/index.html not embedded — run `cd web && npm run build`")
	}
	_, handler, _, _ := routeTestServer(t)
	for _, path := range []string{"/", "/containers/abc"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), "<div id=\"root\">") {
			t.Fatalf("GET %s: status=%d cache-control=%q index_html=%v", path, w.Code, w.Header().Get("Cache-Control"), strings.Contains(w.Body.String(), "<div id=\"root\">"))
		}
	}
}
