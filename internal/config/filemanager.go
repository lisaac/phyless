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
	usernames := make(map[int]string)
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
				fe.Uname = cachedUsername(usernames, fe.Uid, user.LookupId)
			}
		}
		out = append(out, fe)
	}
	return out, nil
}

func cachedUsername(cache map[int]string, uid int, lookup func(string) (*user.User, error)) string {
	if username, ok := cache[uid]; ok {
		return username
	}
	u, err := lookup(strconv.Itoa(uid))
	if err == nil {
		cache[uid] = u.Username
	} else {
		cache[uid] = ""
	}
	return cache[uid]
}
