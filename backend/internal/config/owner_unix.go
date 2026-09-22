//go:build !windows

package config

import (
	"os"
	"syscall"
)

// FileOwner returns the uid/gid behind info; ok is false where the platform has none.
func FileOwner(info os.FileInfo) (uid, gid int, ok bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}
