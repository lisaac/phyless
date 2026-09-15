package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const jwtSecretFile = "jwt-secret"

func loadJWTSecret(dataDir string) ([]byte, error) {
	path := filepath.Join(dataDir, jwtSecretFile)
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("JWT secret path %s is not a regular file", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		secret := string(data)
		if len(secret) > 0 && secret[len(secret)-1] == '\n' {
			secret = secret[:len(secret)-1]
		}
		if len(secret) < 32 {
			return nil, fmt.Errorf("persisted JWT secret in %s is too short", path)
		}
		if err := os.Chmod(path, 0600); err != nil {
			return nil, err
		}
		return []byte(secret), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	secret := hex.EncodeToString(raw[:])
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	written, writeErr := io.WriteString(f, secret+"\n")
	if writeErr == nil && written != len(secret)+1 {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = f.Sync()
	}
	if closeErr := f.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = os.Remove(path)
		return nil, writeErr
	}
	dir, err := os.Open(dataDir)
	if err != nil {
		return nil, err
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	if err := errors.Join(syncErr, closeErr); err != nil {
		return nil, err
	}
	return []byte(secret), nil
}
