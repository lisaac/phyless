package main

import (
	"slices"
	"testing"
)

func TestConfigDir(t *testing.T) {
	if got, rest, err := configDir(nil); err != nil || got != defaultDataDir || len(rest) != 0 {
		t.Fatalf("default directory = %q, %v, %v", got, rest, err)
	}
	if got, _, err := configDir([]string{"-C", "/tmp/phyless"}); err != nil || got != "/tmp/phyless" {
		t.Fatalf("configured directory = %q, %v", got, err)
	}
	if _, rest, err := configDir([]string{"-C", "/data", "helper", "compose", "up", "x"}); err != nil || !slices.Equal(rest, []string{"helper", "compose", "up", "x"}) {
		t.Fatalf("helper args = %v, %v", rest, err)
	}
}
