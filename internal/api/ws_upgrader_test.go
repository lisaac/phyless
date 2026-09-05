package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestComposeWebSocketRejectsCrossOrigin(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://phyless.test/ws/compose/logs", nil)
	r.Header.Set("Origin", "http://untrusted.test")
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	w := httptest.NewRecorder()
	if _, err := upgrader.Upgrade(w, r, nil); err == nil || w.Code != http.StatusForbidden {
		t.Fatalf("status=%d error=%v", w.Code, err)
	}
}
