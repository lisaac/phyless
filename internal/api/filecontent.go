package api

import (
	"io"
	"net/http"
	"os"
)

// maxFileContent caps how much of a file the editor ever loads — without it,
// opening something huge (a log file dropped in a project directory, say)
// would try to pull the whole thing into the browser. The frontend refuses
// to save back when X-Truncated is set, since writing a truncated buffer
// over the real file would destroy the rest of it. Shared by the compose
// project file browser and the /etc config file browser.
const maxFileContent = 2 << 20 // 2MB

func serveFileContent(w http.ResponseWriter, fullPath string) {
	f, err := os.Open(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileContent))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if info.Size() > maxFileContent {
		w.Header().Set("X-Truncated", "true")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data) //nolint:errcheck
}
