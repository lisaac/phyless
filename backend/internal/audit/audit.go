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
)

type Entry struct {
	Time   string `json:"time"`
	User   string `json:"user"`
	Action string `json:"action"`
	Target string `json:"target"`
	Result string `json:"result"`
}

type Logger struct {
	path string
	mu   sync.Mutex
}

func New(path string) *Logger { return &Logger{path: path} }

func (l *Logger) Log(user, action, target, result string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	e := Entry{Time: time.Now().UTC().Format(time.RFC3339), User: user, Action: action, Target: target, Result: result}
	line, err := json.Marshal(e)
	if err == nil && len(line)+1 > maxAuditLine {
		err = fmt.Errorf("audit entry exceeds %d bytes", maxAuditLine)
	}
	if err == nil {
		line = append(line, '\n')
		_, err = f.Write(line)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (l *Logger) ReadAll() ([]Entry, error) {
	return l.ReadTail(DefaultMaxEntries)
}

// ReadTail returns only the newest entries, keeping audit responses bounded as
// the append-only log grows.
func (l *Logger) ReadTail(maxEntries int) ([]Entry, error) {
	if maxEntries <= 0 {
		return nil, fmt.Errorf("max entries must be positive")
	}
	if maxEntries > DefaultMaxEntries {
		maxEntries = DefaultMaxEntries
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.Open(l.path)
	if os.IsNotExist(err) {
		return []Entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > maxTailBytes {
		if _, err := f.Seek(-maxTailBytes, io.SeekEnd); err != nil {
			return nil, err
		}
		// The first bytes may be the tail of a JSON line; discard it.
		reader := bufio.NewReader(f)
		if _, err := reader.ReadString('\n'); err != nil && err != io.EOF {
			return nil, err
		}
		return scanTail(reader, maxEntries)
	}
	return scanTail(f, maxEntries)
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
