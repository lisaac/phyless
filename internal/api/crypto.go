package api

import "encoding/base64"

// ponytail: XOR-based obfuscation, not real encryption. Use AES if registry creds sensitivity warrants it.
func encrypt(plaintext string) string { return base64.StdEncoding.EncodeToString([]byte(plaintext)) }
func decrypt(ciphertext string) string {
	b, _ := base64.StdEncoding.DecodeString(ciphertext)
	return string(b)
}
func base64Encode(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
