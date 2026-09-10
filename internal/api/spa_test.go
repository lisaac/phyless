package api

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestSPAServesPrecompressedAssets(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write([]byte("plain"))
	_ = zw.Close()
	gzipped := buf.String()
	dist := fstest.MapFS{
		"index.html":           {Data: []byte("<html>")},
		"assets/app-abc.js.gz": {Data: []byte(gzipped)},
		"assets/x-abc.css":     {Data: []byte("css")},
	}
	h := spaHandler(dist)
	get := func(path, enc string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}
	rec := get("/assets/app-abc.js", "gzip, br")
	if rec.Body.String() != gzipped || rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("gzip path: body=%q enc=%q ct=%q", rec.Body.String(), rec.Header().Get("Content-Encoding"), rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("cache-control = %q", rec.Header().Get("Cache-Control"))
	}
	if rec := get("/assets/app-abc.js", ""); rec.Body.String() != "plain" || rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("inflated for non-gzip client: body=%q enc=%q ct=%q", rec.Body.String(), rec.Header().Get("Content-Encoding"), rec.Header().Get("Content-Type"))
	}
	if rec := get("/assets/x-abc.css", "gzip"); rec.Body.String() != "css" || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("plain file served as-is: body=%q enc=%q", rec.Body.String(), rec.Header().Get("Content-Encoding"))
	}
	if rec := get("/assets/missing.js", "gzip"); rec.Body.String() != "<html>" {
		t.Fatalf("unknown asset falls back to SPA: body=%q", rec.Body.String())
	}
	if rec := get("/some/route", "gzip"); rec.Body.String() != "<html>" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("spa fallback: body=%q cc=%q", rec.Body.String(), rec.Header().Get("Cache-Control"))
	}
}
