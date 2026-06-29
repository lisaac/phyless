package config

import (
	"os"
	"path/filepath"
)

type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

func ListDir(root, subPath string) ([]FileEntry, error) {
	dir := filepath.Join(root, subPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, _ := e.Info()
		size := int64(0)
		if info != nil && !e.IsDir() {
			size = info.Size()
		}
		out = append(out, FileEntry{
			Name:  e.Name(),
			Path:  filepath.Join(subPath, e.Name()),
			IsDir: e.IsDir(),
			Size:  size,
		})
	}
	return out, nil
}
