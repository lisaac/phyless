package api

import (
	"encoding/json"
	"log"
	"net/http"

	"phyless/backend/internal/auth"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func auditUser(r *http.Request) string {
	if claims := auth.FromContext(r.Context()); claims != nil {
		return claims.Username
	}
	return "anonymous"
}

func (s *Server) auditFromCtx(r *http.Request, action, target, result string) {
	if err := s.audit.Log(auditUser(r), action, target, result); err != nil {
		log.Printf("audit: write failed: %v", err)
	}
}
