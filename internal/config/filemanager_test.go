package config

import (
	"os/user"
	"testing"
)

func TestCachedUsernameReusesLookupForSameUID(t *testing.T) {
	cache := make(map[int]string)
	calls := 0
	lookup := func(string) (*user.User, error) {
		calls++
		return &user.User{Username: "owner"}, nil
	}
	if first, second := cachedUsername(cache, 42, lookup), cachedUsername(cache, 42, lookup); first != "owner" || second != first || calls != 1 {
		t.Fatalf("first=%q second=%q calls=%d", first, second, calls)
	}
}
