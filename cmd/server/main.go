package main

import (
	"log"
	"net/http"
	"os"

	"phyless/internal/api"
	"phyless/internal/store"
)

func main() {
	dataDir := env("DATA_DIR", "/data")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatal(err)
	}
	jwtSecret := []byte(env("JWT_SECRET", "change-me-in-production"))
	s := store.New(dataDir + "/config.json")

	// Seed admin user if no users exist
	if err := seedAdmin(s, jwtSecret); err != nil {
		log.Fatal(err)
	}

	log.Println("infra-manager listening on :8080")
	if err := http.ListenAndServe(":8080", api.New(s, jwtSecret, dataDir)); err != nil {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
