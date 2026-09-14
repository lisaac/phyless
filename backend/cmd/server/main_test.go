package main

import "testing"

func TestConfigDir(t *testing.T) {
	if got, err := configDir(nil); err != nil || got != defaultDataDir {
		t.Fatalf("default directory = %q, %v", got, err)
	}
	if got, err := configDir([]string{"-C", "/tmp/phyless"}); err != nil || got != "/tmp/phyless" {
		t.Fatalf("configured directory = %q, %v", got, err)
	}
}
