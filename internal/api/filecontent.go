package api

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
)

// maxFileContent caps how much of a file the editor ever loads — without it,
// opening something huge (a log file dropped in a project directory, say)
// would try to pull the whole thing into the browser. The frontend refuses
// to save back when X-Truncated is set, since writing a truncated buffer
// over the real file would destroy the rest of it. Shared by the compose
// project file browser and the /etc config file browser.
const maxFileContent = 2 << 20 // 2MB

const maxUploadSize = 50 << 20
const maxInt64 = int64(^uint64(0) >> 1)

var errRequestBodyTooLarge = errors.New("request body exceeds size limit")

func readBounded(src io.Reader, limit int64) ([]byte, error) {
	if limit < 0 {
		return nil, fmt.Errorf("invalid read limit")
	}
	readLimit := limit
	if limit < maxInt64 {
		readLimit++
	}
	data, err := io.ReadAll(io.LimitReader(src, readLimit))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errRequestBodyTooLarge
	}
	return data, nil
}

// atomicWriteFile keeps the previous file until the complete replacement is
// durable in a same-directory temporary file. Callers perform their rooted
// path checks before invoking this helper.
func atomicWriteFile(path string, data []byte, defaultMode os.FileMode) error {
	mode := defaultMode.Perm()
	uid, gid := -1, -1
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("target is not a regular file")
		}
		mode = info.Mode()
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			uid, gid = int(stat.Uid), int(stat.Gid)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if uid >= 0 && gid >= 0 {
		if err := tmp.Chown(uid, gid); err != nil {
			return err
		}
		// Chown may clear setuid/setgid bits.
		if err := tmp.Chmod(mode); err != nil {
			return err
		}
	}
	n, err := tmp.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return err
	}
	closed = true
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	return errors.Join(syncErr, closeErr)
}

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
func streamTar(w io.Writer, fullPath string) error {
	info, err := os.Lstat(fullPath)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(w)
	var streamErr error
	if !info.IsDir() {
		streamErr = writeTarFile(tw, fullPath, filepath.Base(fullPath), info)
	} else {
		baseDir := filepath.Dir(fullPath)
		streamErr = filepath.Walk(fullPath, func(p string, fi os.FileInfo, err error) error {
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
	if streamErr != nil {
		return streamErr
	}
	return tw.Close()
}

// serveTar commits the response only after the requested root is available.
// Once streaming has started, HTTP cannot carry a second status; abort the
// response on a later filesystem or writer error instead of appending JSON to
// a partial archive.
func serveTar(w http.ResponseWriter, fullPath string) {
	info, err := os.Lstat(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unsupported special file %q", fullPath))
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(fullPath)+`.tar"`)
	if err := streamTar(w, fullPath); err != nil {
		panic(http.ErrAbortHandler)
	}
}

func writeTarFile(tw *tar.Writer, fullPath, tarName string, info os.FileInfo) error {
	if !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("unsupported special file %q", fullPath)
	}
	linkname := ""
	if info.Mode()&os.ModeSymlink != 0 {
		var err error
		linkname, err = os.Readlink(fullPath)
		if err != nil {
			return err
		}
	}
	hdr, err := tar.FileInfoHeader(info, linkname)
	if err != nil {
		return err
	}
	hdr.Name = tarName
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	f, err := os.Open(fullPath)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}
