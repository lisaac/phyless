package config

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode,omitempty"`
	ModTime int64  `json:"mod_time,omitempty"`
	Uname   string `json:"uname,omitempty"`
	Uid     int    `json:"uid,omitempty"`
	Gid     int    `json:"gid,omitempty"`
}

func ListDir(root, subPath string) ([]FileEntry, error) {
	dir := filepath.Join(root, subPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		fe := FileEntry{
			Name:  e.Name(),
			Path:  filepath.Join(subPath, e.Name()),
			IsDir: e.IsDir(),
		}
		if info, err := e.Info(); err == nil {
			if !e.IsDir() {
				fe.Size = info.Size()
			}
			fe.Mode = info.Mode().String()
			fe.ModTime = info.ModTime().Unix()
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				fe.Uid = int(st.Uid)
				fe.Gid = int(st.Gid)
				if u, err := user.LookupId(strconv.Itoa(fe.Uid)); err == nil {
					fe.Uname = u.Username
				}
			}
		}
		out = append(out, fe)
	}
	return out, nil
}
