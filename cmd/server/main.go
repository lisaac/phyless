package main

import (
	"log"
	"net/http"
)

func main() {
	log.Println("starting infra-manager on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
