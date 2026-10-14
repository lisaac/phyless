package debugshell

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// HelperName names a helper container so anyone reading `docker ps` can tell
// what it is, what it serves and that it removes itself:
// phyless-autoremove-<purpose>[-<target>]-<random>.
func HelperName(purpose, target string) string {
	var suffix [3]byte
	_, _ = rand.Read(suffix[:])
	parts := []string{"phyless-autoremove", purpose}
	if t := nameSafe(target); t != "" {
		parts = append(parts, t)
	}
	return strings.Join(append(parts, hex.EncodeToString(suffix[:])), "-")
}

// nameSafe fits a container/image name or ID into Docker's container-name
// charset [a-zA-Z0-9_.-], short enough to keep the whole name readable.
func nameSafe(s string) string {
	s = strings.TrimPrefix(s, "/")
	if id, ok := strings.CutPrefix(s, "sha256:"); ok && len(id) > 12 {
		s = id[:12]
	}
	s = strings.Map(func(r rune) rune {
		if r == '_' || r == '.' || r == '-' || 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' {
			return r
		}
		return '-'
	}, s)
	if len(s) > 40 {
		s = s[:40]
	}
	return strings.Trim(s, "-.")
}
