package api

import "net/http"

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	entries, err := s.audit.ReadAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
