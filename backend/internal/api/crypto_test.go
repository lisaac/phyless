package api

import (
	"encoding/base64"
	"strings"
	"testing"

	"phyless/backend/internal/models"
	"phyless/backend/internal/store"
)

var testSecret = []byte(strings.Repeat("s", 64))

func mustEncrypt(t *testing.T, s *Server, plaintext string) string {
	t.Helper()
	enc, err := s.encrypt(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	return enc
}

func mustDecrypt(t *testing.T, s *Server, stored string) string {
	t.Helper()
	pt, err := s.decrypt(stored)
	if err != nil {
		t.Fatal(err)
	}
	return pt
}

func TestSecretRoundTrip(t *testing.T) {
	s := &Server{jwtSecret: testSecret}
	for _, pt := range []string{"", "hunter2", "quote\"slash\\ünïcode"} {
		enc := mustEncrypt(t, s, pt)
		if !strings.HasPrefix(enc, secretPrefix) {
			t.Fatalf("not sealed: %q", enc)
		}
		if got := mustDecrypt(t, s, enc); got != pt {
			t.Fatalf("round trip %q -> %q", pt, got)
		}
	}
	if mustEncrypt(t, s, "x") == mustEncrypt(t, s, "x") {
		t.Fatal("nonce reused")
	}
	if _, err := (&Server{}).encrypt("x"); err == nil {
		t.Fatal("encrypt without key succeeded")
	}
}

func TestSecretLegacyReadAndUpgrade(t *testing.T) {
	s, h := registryRouter(t)
	legacy := base64.StdEncoding.EncodeToString([]byte("old-pass"))
	if got := mustDecrypt(t, s, legacy); got != "old-pass" {
		t.Fatalf("legacy read %q", got)
	}
	if err := s.store.Write(&store.Config{Registries: []models.Registry{
		{ID: "a", URL: "ghcr.io", PasswordEnc: legacy},
		{ID: "b", URL: "quay.io", PasswordEnc: mustEncrypt(t, s, "new-pass")},
	}}); err != nil {
		t.Fatal(err)
	}
	// Any registry write (here: deleting b) re-seals the remaining legacy value.
	if w := serve(h, "DELETE", "/api/registries/b", ""); w.Code != 204 {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	cfg, _ := s.store.Read()
	enc := cfg.Registries[0].PasswordEnc
	if !strings.HasPrefix(enc, secretPrefix) || mustDecrypt(t, s, enc) != "old-pass" {
		t.Fatalf("legacy not upgraded: %q", enc)
	}
}

func TestSecretTamperDetection(t *testing.T) {
	s := &Server{jwtSecret: testSecret}
	enc := mustEncrypt(t, s, "hunter2")
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(enc, secretPrefix))
	raw[len(raw)-1] ^= 1
	if _, err := s.decrypt(secretPrefix + base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	if _, err := s.decrypt(secretPrefix + "AAAA"); err == nil {
		t.Fatal("truncated ciphertext accepted")
	}
	other := &Server{jwtSecret: []byte(strings.Repeat("o", 64))}
	if _, err := other.decrypt(enc); err == nil {
		t.Fatal("decrypted with wrong key")
	}
}
