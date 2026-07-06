package api

import (
	"archive/tar"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

// streamTar tars fullPath (a single file or a whole directory, walked
// recursively) straight to w as it reads — tar.Writer and io.Copy both write
// incrementally, so this never buffers the archive in memory regardless of
// how large the source is. Shared by the compose project file browser and
// the /etc config file browser's "下载 tar" action.
func streamTar(w http.ResponseWriter, fullPath string) {
	info, err := os.Stat(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	name := filepath.Base(fullPath)
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.tar"`)

	tw := tar.NewWriter(w)
	defer tw.Close() //nolint:errcheck

	if !info.IsDir() {
		writeTarFile(tw, fullPath, name, info)
		return
	}
	baseDir := filepath.Dir(fullPath)
	filepath.Walk(fullPath, func(p string, fi os.FileInfo, err error) error { //nolint:errcheck
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(baseDir, p)
		if err != nil {
			return err
		}
		if fi.IsDir() {
			hdr, err := tar.FileInfoHeader(fi, "")
			if err != nil {
				return err
			}
			hdr.Name = rel + "/"
			return tw.WriteHeader(hdr)
		}
		return writeTarFile(tw, p, rel, fi)
	})
}

func writeTarFile(tw *tar.Writer, fullPath, tarName string, info os.FileInfo) error {
	hdr, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	hdr.Name = tarName
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	f, err := os.Open(fullPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}
