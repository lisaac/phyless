package audit

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"sync"
	"time"
)

const (
	DefaultMaxEntries = 1000
	maxTailBytes      = 1 << 20
	maxAuditLine      = 64 << 10
	defaultMaxBytes   = 10 << 20
	defaultBackups    = 5
)

type Entry struct {
	Time   string `json:"time"`
	User   string `json:"user"`
	Action string `json:"action"`
	Target string `json:"target"`
	Result string `json:"result"`
}

type Logger struct {
	path     string
	mu       sync.Mutex
	maxBytes int64
	backups  int
}

func New(path string) *Logger {
	return &Logger{path: path, maxBytes: defaultMaxBytes, backups: defaultBackups}
}

func (l *Logger) Log(user, action, target, result string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := Entry{Time: time.Now().UTC().Format(time.RFC3339), User: user, Action: action, Target: target, Result: result}
	line, err := json.Marshal(e)
	if err == nil && len(line)+1 > maxAuditLine {
		err = fmt.Errorf("audit entry exceeds %d bytes", maxAuditLine)
	}
	if err != nil {
		return err
	}
	line = append(line, '\n')
	if info, statErr := os.Stat(l.path); statErr == nil {
		if info.Size()+int64(len(line)) > l.maxBytes {
			if err := l.rotate(); err != nil {
				return err
			}
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(line)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

// rotate keeps five completed files plus the active log (at most 60 MiB by default).
// Rename preserves the active file if rotation fails; never truncate it in place.
func (l *Logger) rotate() error {
	for i := l.backups; i > 0; i-- {
		src := l.path
		if i > 1 {
			src = fmt.Sprintf("%s.%d", l.path, i-1)
		}
		if err := os.Rename(src, fmt.Sprintf("%s.%d", l.path, i)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (l *Logger) ReadAll() ([]Entry, error) {
	return l.ReadTail(DefaultMaxEntries)
}

// ReadTail returns only the newest entries, keeping audit responses bounded as
// the log rotates, with one shared byte budget across all retained files.
func (l *Logger) ReadTail(maxEntries int) ([]Entry, error) {
	if maxEntries <= 0 {
		return nil, fmt.Errorf("max entries must be positive")
	}
	if maxEntries > DefaultMaxEntries {
		maxEntries = DefaultMaxEntries
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := []Entry{}
	remainingBytes := int64(maxTailBytes)
	for i := 0; i <= l.backups && len(entries) < maxEntries && remainingBytes > 0; i++ {
		file := l.path
		if i > 0 {
			file = fmt.Sprintf("%s.%d", l.path, i)
		}
		tail, consumed, err := readFileTail(file, maxEntries-len(entries), remainingBytes)
		if err != nil {
			return nil, err
		}
		remainingBytes -= consumed
		entries = append(tail, entries...)
	}
	return entries, nil
}

func readFileTail(path string, maxEntries int, maxBytes int64) ([]Entry, int64, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	var reader io.Reader = f
	consumed := min(info.Size(), maxBytes)
	if info.Size() > maxBytes {
		if _, err := f.Seek(-maxBytes, io.SeekEnd); err != nil {
			return nil, 0, err
		}
		buffered := bufio.NewReader(f)
		if _, err := buffered.ReadString('\n'); err != nil && err != io.EOF {
			return nil, 0, err
		}
		reader = buffered
	}
	entries, err := scanTail(reader, maxEntries)
	return entries, consumed, err
}

func scanTail(r io.Reader, maxEntries int) ([]Entry, error) {
	entries := make([]Entry, 0, maxEntries)
	next := 0
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), maxAuditLine+1)
	for scanner.Scan() {
		var e Entry
		if json.Unmarshal(scanner.Bytes(), &e) == nil {
			if len(entries) == maxEntries {
				entries[next] = e
				next = (next + 1) % maxEntries
			} else {
				entries = append(entries, e)
			}
		}
	}
	// Restore chronological order once, instead of shifting the tail for every entry.
	slices.Reverse(entries[:next])
	slices.Reverse(entries[next:])
	slices.Reverse(entries)
	return entries, scanner.Err()
}
