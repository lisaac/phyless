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
	"phyless/backend/internal/store"
)

const defaultDataDir = "./data"

func main() {
	dataDir, err := configDir(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatal(err)
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
	jwtSecret, err := loadJWTSecret(dataDir, os.Getenv("JWT_SECRET"))
	if err != nil {
		log.Fatal(err)
	}
	s := store.New(filepath.Join(dataDir, "config.json"))

	// Seed admin user if no users exist
	if err := seedAdmin(s, os.Getenv("ADMIN_PASSWORD")); err != nil {
		log.Fatal(err)
	}

	log.Println("infra-manager listening on :8080")
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

func configDir(args []string) (string, error) {
	flags := flag.NewFlagSet("infra-manager", flag.ContinueOnError)
	dir := flags.String("C", defaultDataDir, "configuration directory")
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	return *dir, nil
}
