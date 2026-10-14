package main

import (
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"

	"phyless/backend/internal/api"
	"phyless/backend/internal/docker/self"
	"phyless/backend/internal/store"

	// Bundled Mozilla roots, used only when the system has none (scratch image).
	_ "golang.org/x/crypto/x509roots/fallback"
)

const defaultDataDir = "./data"

func main() {
	dataDir, rest, err := configDir(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	if len(rest) > 0 && rest[0] == "helper" {
		os.Exit(api.RunHelper(dataDir, rest[1:]))
	}

	// ponytail: soft heap ceiling for small hosts (routers); GOMEMLIMIT/GOGC env override.
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(128 << 20)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(50)
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatal(err)
	}
	jwtSecret, err := loadJWTSecret(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	s := store.New(filepath.Join(dataDir, "config.json"))
	self.Init(dataDir)

	log.Println("phyless listening on :8080")
	server := &http.Server{
		Addr:              ":8080",
		Handler:           api.New(s, jwtSecret, dataDir),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func configDir(args []string) (string, []string, error) {
	flags := flag.NewFlagSet("phyless", flag.ContinueOnError)
	dir := flags.String("C", defaultDataDir, "configuration directory")
	if err := flags.Parse(args); err != nil {
		return "", nil, err
	}
	return *dir, flags.Args(), nil
}
