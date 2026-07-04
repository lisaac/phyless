package api

import (
	"strings"
	"testing"

	composetypes "github.com/compose-spec/compose-go/v2/types"
)

// Regression test for the bug found while adding this feature: docker compose
// config always emits ports/command in canonical long-form, which the
// previous JS-based (decomposerize) converter silently mishandled — port
// mappings were dropped entirely and array-form commands got comma-joined
// into a single invalid argument.
func TestServiceRunCommandLongFormPortsAndCommand(t *testing.T) {
	v := "123456"
	svc := composetypes.ServiceConfig{
		ContainerName: "tlbb-redis",
		Image:         "redis:7",
		Command:       composetypes.ShellCommand{"redis-server", "--requirepass", "123456"},
		Ports: []composetypes.ServicePortConfig{
			{Mode: "ingress", Target: 6379, Published: "6379", Protocol: "tcp"},
		},
		Environment: composetypes.MappingWithEquals{"FOO": &v},
	}

	got := serviceRunCommand("redis", svc)

	if !strings.Contains(got, "-p 6379:6379") {
		t.Errorf("expected port mapping -p 6379:6379 in output, got: %s", got)
	}
	if !strings.Contains(got, "redis-server --requirepass 123456") {
		t.Errorf("expected space-separated command args, got: %s", got)
	}
	if strings.Contains(got, "redis-server,--requirepass") {
		t.Errorf("command args must not be comma-joined, got: %s", got)
	}
	if !strings.Contains(got, "--name tlbb-redis") {
		t.Errorf("expected --name tlbb-redis, got: %s", got)
	}
	if !strings.Contains(got, "redis:7") {
		t.Errorf("expected image redis:7, got: %s", got)
	}
}
