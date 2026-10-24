package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"phyless/backend/internal/docker/fsbrowse"
)

// chmodBody is one permission change, shared by every writable file source.
type chmodBody struct {
	Path      string `json:"path"`
	Mode      string `json:"mode,omitempty"`  // octal, "" keeps it
	Owner     string `json:"owner,omitempty"` // "uid[:gid]", "" keeps it
	Recursive bool   `json:"recursive,omitempty"`
}

func (b chmodBody) String() string {
	return fmt.Sprintf("%s mode=%s owner=%s recursive=%t", b.Path, b.Mode, b.Owner, b.Recursive)
}

func decodeChmod(w http.ResponseWriter, r *http.Request) (chmodBody, bool) {
	var b chmodBody
	switch err := json.NewDecoder(r.Body).Decode(&b); {
	case err != nil || b.Path == "" || b.Mode == "" && b.Owner == "":
		writeError(w, http.StatusBadRequest, "path and mode or owner required")
	case b.Mode != "" && !fsbrowse.ValidMode(b.Mode):
		writeError(w, http.StatusBadRequest, "mode must be 3 or 4 octal digits")
	case b.Owner != "" && !fsbrowse.ValidOwner(b.Owner):
		writeError(w, http.StatusBadRequest, "owner must be numeric uid or uid:gid")
	default:
		return b, true
	}
	return b, false
}

// chmodHost applies b to full, a checked path on phyless's own filesystem.
// Symlinks are never followed: one could lead out of the browsed root.
func chmodHost(full string, b chmodBody) error {
	if info, err := os.Lstat(full); err != nil {
		return err
	} else if info.Mode()&fs.ModeSymlink != 0 {
		return errors.New("不能修改符号链接的权限")
	}
	mode, uid, gid := fileMode(b.Mode), -1, -1
	if b.Owner != "" {
		u, g, _ := strings.Cut(b.Owner, ":")
		uid, _ = strconv.Atoi(u) // validated digits
		if g != "" {
			gid, _ = strconv.Atoi(g)
		}
	}
	apply := func(p string) error {
		if uid >= 0 { // before chmod: chown clears setuid/setgid
			if err := os.Lchown(p, uid, gid); err != nil {
				return err
			}
		}
		if b.Mode != "" {
			return os.Chmod(p, mode)
		}
		return nil
	}
	if !b.Recursive {
		return apply(full)
	}
	return filepath.WalkDir(full, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.Type()&fs.ModeSymlink != 0 {
			return err
		}
		return apply(p)
	})
}

// fileMode converts octal "4755" to os.FileMode, whose special bits differ.
func fileMode(s string) os.FileMode {
	n, _ := strconv.ParseUint(s, 8, 32)
	m := os.FileMode(n & 0o777)
	for bit, fm := range map[uint64]os.FileMode{0o4000: os.ModeSetuid, 0o2000: os.ModeSetgid, 0o1000: os.ModeSticky} {
		if n&bit != 0 {
			m |= fm
		}
	}
	return m
}
