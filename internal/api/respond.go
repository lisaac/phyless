package api

import (
	"encoding/json"
	"net/http"

	"phyless/internal/auth"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) auditFromCtx(r *http.Request, action, target, result string) {
	claims := auth.FromContext(r.Context())
	user := "anonymous"
	if claims != nil {
		user = claims.Username
	}
	s.audit.Log(user, action, target, result)
}
