package api

import "encoding/base64"

// ponytail: base64 is obfuscation, not encryption; protect the registry store as plaintext credentials.
func encrypt(plaintext string) string { return base64.StdEncoding.EncodeToString([]byte(plaintext)) }
func decrypt(ciphertext string) string {
	b, _ := base64.StdEncoding.DecodeString(ciphertext)
	return string(b)
}
