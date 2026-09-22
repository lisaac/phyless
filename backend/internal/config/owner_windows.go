package config

import "os"

// FileOwner has no uid/gid to report on Windows.
func FileOwner(os.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
