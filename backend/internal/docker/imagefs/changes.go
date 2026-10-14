package imagefs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sync"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"

	ctr "phyless/backend/internal/docker/container"
)

// maxStat caps per-listing stat calls for entries the changes list has no
// metadata for. ponytail: past it entries show without size/mode; page the
// stats if huge new directories need them.
const maxStat = 256

// changesIndex writes a container's changes in the image index format, so
// listIndex walks both alike. Deletions are tombstones (Size -1). Changes carry
// paths only: a path is a directory when another change lies beneath it; leaf
// metadata is fetched per listing.
func changesIndex(changes []container.FilesystemChange) (_ *os.File, err error) {
	if len(changes) > 4*maxIndexEntries {
		return nil, fmt.Errorf("container has too many filesystem changes (%d)", len(changes))
	}
	dirs := map[string]bool{}
	for _, c := range changes {
		for d := path.Dir(normPath(c.Path)); d != "/" && !dirs[d]; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	f, err := os.CreateTemp("", "phyless-imagefs-*")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(f.Name()); err != nil {
		f.Close()
		return nil, err
	}
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	w := bufio.NewWriterSize(f, 64<<10)
	total := 0
	for _, c := range changes {
		p := normPath(c.Path)
		if p == "/" {
			continue
		}
		e := ctr.FileEntry{Name: path.Base(p), Mode: "-?????????"}
		switch {
		case c.Kind == container.ChangeDelete:
			e.Size = -1
		case dirs[p]:
			e.IsDir, e.Mode = true, "drwxr-xr-x"
		}
		data, err := json.Marshal(indexEntry{Path: p, Entry: e})
		if err != nil {
			return nil, err
		}
		if total += len(data) + 1; total > maxIndexBytes {
			return nil, fmt.Errorf("filesystem changes index exceeds %d bytes", maxIndexBytes)
		}
		if _, err := w.Write(append(data, '\n')); err != nil {
			return nil, err
		}
	}
	return f, w.Flush()
}

// listMerged lists dir as the container sees it: image entries, minus
// deletions, plus added/modified entries (stat'ed for real metadata).
func listMerged(ctx context.Context, cli client.APIClient, id string, image, changes *os.File, dir string) ([]ctr.FileEntry, error) {
	gone, err := deleted(changes, dir)
	if err != nil {
		return nil, err
	}
	if gone {
		return nil, fmt.Errorf("目录不存在: %s", dir)
	}
	out, baseErr := listIndex(ctx, image, dir)
	changed, err := listIndex(ctx, changes, dir)
	if baseErr != nil && err != nil {
		return nil, baseErr
	}
	pos := map[string]int{}
	for i, e := range out {
		pos[e.Name] = i
	}
	removed := map[string]bool{}
	var stat []int
	for _, c := range changed {
		i, ok := pos[c.Name]
		switch {
		case c.Size < 0:
			removed[c.Name] = true
		case ok && c.IsDir && out[i].IsDir: // children changed; image metadata stands
		case ok:
			out[i] = c
			stat = append(stat, i)
		default:
			pos[c.Name] = len(out)
			out = append(out, c)
			stat = append(stat, len(out)-1)
		}
	}
	if len(stat) > maxStat {
		stat = stat[:maxStat]
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, i := range stat {
		wg.Add(1)
		sem <- struct{}{}
		go func(e *ctr.FileEntry) {
			defer func() { <-sem; wg.Done() }()
			if st, err := cli.ContainerStatPath(ctx, id, path.Join(dir, e.Name)); err == nil {
				*e = ctr.FileEntry{Name: e.Name, Size: st.Size, Mode: fileModeString(st.Mode), IsDir: st.Mode.IsDir()}
				if !st.Mtime.IsZero() {
					e.ModTime = st.Mtime.Unix()
				}
				if st.Mode&fs.ModeSymlink != 0 {
					e.Size = 0
				}
			}
		}(&out[i])
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	kept := out[:0]
	for _, e := range out {
		if !removed[e.Name] {
			kept = append(kept, e)
		}
	}
	return kept, nil
}

// deleted reports whether dir or one of its ancestors has a tombstone.
func deleted(changes *os.File, dir string) (bool, error) {
	var exact [][]byte
	for a := dir; a != "/"; a = path.Dir(a) {
		enc, _ := json.Marshal(a)
		exact = append(exact, append(append([]byte(`{"Path":`), enc...), ','))
	}
	if len(exact) == 0 {
		return false, nil
	}
	sc := bufio.NewScanner(io.NewSectionReader(changes, 0, maxIndexBytes))
	sc.Buffer(make([]byte, 4096), 64<<10)
	for sc.Scan() {
		line := sc.Bytes()
		for _, p := range exact {
			if bytes.HasPrefix(line, p) {
				var r indexEntry
				if err := json.Unmarshal(line, &r); err != nil {
					return false, err
				}
				if r.Entry.Size < 0 {
					return true, nil
				}
			}
		}
	}
	return false, sc.Err()
}

func fileModeString(m fs.FileMode) string {
	s := m.String()
	if m&fs.ModeSymlink != 0 {
		return "l" + s[1:]
	}
	return s
}
