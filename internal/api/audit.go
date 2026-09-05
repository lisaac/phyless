package api

import (
	"net/http"
	"strconv"

	"phyless/internal/audit"
)

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	limit := audit.DefaultMaxEntries
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}
	entries, err := s.audit.ReadTail(limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
