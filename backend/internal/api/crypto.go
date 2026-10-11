package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"

	"phyless/backend/internal/store"
)

// Registry passwords are sealed with AES-256-GCM under a key derived from the
// persisted JWT secret (data dir's jwt-secret), stored as "v1:" + base64(nonce|ciphertext).
// Values without the prefix are legacy plain base64 (':' is not in the base64
// alphabet, so the two never collide) and are re-sealed on the next registry write.
// ponytail: key is tied to jwt-secret; deleting that file orphans stored passwords (re-enter them).
const secretPrefix = "v1:"

var errSecretKey = errors.New("no secret key configured")

func (s *Server) secretAEAD() (cipher.AEAD, error) {
	if len(s.jwtSecret) == 0 {
		return nil, errSecretKey
	}
	key, err := hkdf.Key(sha256.New, s.jwtSecret, nil, "phyless registry password v1", 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *Server) encrypt(plaintext string) (string, error) {
	aead, err := s.secretAEAD()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return secretPrefix + base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(plaintext), nil)), nil
}

func (s *Server) decrypt(stored string) (string, error) {
	enc, ok := strings.CutPrefix(stored, secretPrefix)
	if !ok {
		b, err := base64.StdEncoding.DecodeString(stored)
		return string(b), err
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	aead, err := s.secretAEAD()
	if err != nil {
		return "", err
	}
	if len(raw) < aead.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	pt, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], nil)
	return string(pt), err
}

// upgradeLegacyPasswords re-seals any legacy base64 registry passwords in cfg.
// Call inside every store.Update that touches registries.
func (s *Server) upgradeLegacyPasswords(cfg *store.Config) error {
	for i := range cfg.Registries {
		p := &cfg.Registries[i].PasswordEnc
		if strings.HasPrefix(*p, secretPrefix) {
			continue
		}
		pt, err := s.decrypt(*p)
		if err != nil {
			return err
		}
		if *p, err = s.encrypt(pt); err != nil {
			return err
		}
	}
	return nil
}
