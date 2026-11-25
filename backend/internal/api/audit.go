package api

import (
	"net/http"
	"strconv"
	"time"

	"phyless/backend/internal/audit"
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
	var bounds [2]time.Time
	for i, name := range []string{"since", "until"} {
		if raw := r.URL.Query().Get(name); raw != "" {
			unix, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				writeError(w, http.StatusBadRequest, name+" must be unix seconds")
				return
			}
			bounds[i] = time.Unix(unix, 0)
		}
	}
	entries, err := s.audit.ReadRange(limit, bounds[0], bounds[1])
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
