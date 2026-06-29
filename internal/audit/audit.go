package audit

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"
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

func (l *Logger) Log(user, action, target, result string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	e := Entry{Time: time.Now().UTC().Format(time.RFC3339), User: user, Action: action, Target: target, Result: result}
	line, _ := json.Marshal(e)
	f.Write(append(line, '\n'))
}

func (l *Logger) ReadAll() ([]Entry, error) {
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
	var entries []Entry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var e Entry
		if json.Unmarshal(scanner.Bytes(), &e) == nil {
			entries = append(entries, e)
		}
	}
	return entries, scanner.Err()
}
