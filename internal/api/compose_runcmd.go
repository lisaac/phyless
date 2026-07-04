package api

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"

	"github.com/compose-spec/compose-go/v2/loader"
	composetypes "github.com/compose-spec/compose-go/v2/types"
	"phyless/internal/models"
)

// resolvedRunCommands shells out to `docker compose config` — the same
// fully-resolved, canonical config `up` would actually deploy, with env vars
// substituted and extends/overrides merged — and builds one `docker run`
// command per service directly from the structured result via compose-go's
// own loader.
//
// This builds the command from typed ServiceConfig fields instead of handing
// docker compose config's YAML to a JS compose->run converter (decomposerize)
// built for hand-written short-form files: docker compose config always
// emits canonical long-form ports/volumes and array-form command, which that
// converter silently mis-parses (dropped port mappings entirely, comma-joined
// command args) — verified against a real project's output during review.
func (s *Server) resolvedRunCommands(ctx context.Context, p models.ComposeProject) ([]string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-f", p.ComposeFile, "config")
	cmd.Dir = p.BaseDir
	if p.EnvFile != "" {
		cmd.Env = append(os.Environ(), "COMPOSE_ENV_FILES="+p.EnvFile)
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	// The config output is already fully resolved — skip re-interpolating
	// and re-resolving env, we just want it parsed into structured fields.
	proj, err := loader.LoadWithContext(ctx, composetypes.ConfigDetails{
		WorkingDir:  p.BaseDir,
		ConfigFiles: []composetypes.ConfigFile{{Filename: p.ComposeFile, Content: out}},
	}, func(o *loader.Options) { o.SkipValidation = true; o.SkipInterpolation = true; o.SkipResolveEnvironment = true })
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, len(proj.Services))
	for name := range proj.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	runs := make([]string, 0, len(names))
	for _, name := range names {
		runs = append(runs, serviceRunCommand(name, proj.Services[name]))
	}
	return runs, nil
}

func serviceRunCommand(name string, svc composetypes.ServiceConfig) string {
	var b strings.Builder
	b.WriteString("docker run -d")

	containerName := svc.ContainerName
	if containerName == "" {
		containerName = name
	}
	if containerName != "" {
		fmt.Fprintf(&b, " --name %s", containerName)
	}

	for _, port := range svc.Ports {
		if port.Published == "" {
			continue
		}
		spec := port.Published + ":" + strconv.FormatUint(uint64(port.Target), 10)
		if port.HostIP != "" {
			spec = port.HostIP + ":" + spec
		}
		if port.Protocol != "" && port.Protocol != "tcp" {
			spec += "/" + port.Protocol
		}
		fmt.Fprintf(&b, " -p %s", spec)
	}

	for _, vol := range svc.Volumes {
		if vol.Source == "" || vol.Target == "" {
			continue
		}
		spec := vol.Source + ":" + vol.Target
		if vol.ReadOnly {
			spec += ":ro"
		}
		fmt.Fprintf(&b, " -v %s", spec)
	}

	envKeys := make([]string, 0, len(svc.Environment))
	for k := range svc.Environment {
		envKeys = append(envKeys, k)
	}
	sort.Strings(envKeys)
	for _, k := range envKeys {
		v := svc.Environment[k]
		if v == nil {
			continue
		}
		fmt.Fprintf(&b, " -e %s=%s", k, shellQuote(*v))
	}

	if svc.Restart != "" {
		fmt.Fprintf(&b, " --restart %s", svc.Restart)
	}

	if svc.Image != "" {
		fmt.Fprintf(&b, " %s", svc.Image)
	}

	for _, arg := range svc.Command {
		fmt.Fprintf(&b, " %s", shellQuote(arg))
	}

	return b.String()
}

// shellQuote wraps a value in single quotes if it contains anything a shell
// would otherwise split on — good enough for a copy-pasteable preview
// command, not a full shell-escaping implementation.
func shellQuote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\"'$`\\") {
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}
