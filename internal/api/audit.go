package api

import "net/http"

// ponytail: stub — audit log implemented in Task 5
func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []any{})
}
