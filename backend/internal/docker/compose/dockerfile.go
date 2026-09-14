package compose

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	"github.com/moby/buildkit/frontend/dockerfile/instructions"
	"github.com/moby/buildkit/frontend/dockerfile/parser"
	"github.com/moby/buildkit/frontend/dockerfile/shell"
)

// BuildBaseImages returns the external base images a service's Dockerfile pulls
// via FROM, with global-ARG interpolation applied (compose build args override
// ARG defaults). References to earlier build stages and "scratch" are excluded.
//
// It exists so the API can pre-pull these through the request proxy before an
// offline build: buildkit performs its own FROM pulls inside the daemon, which
// never pass through phyless's userspace registry proxy.
//
// ponytail: FROM lines whose image can't be resolved statically (build args we
// aren't given, COPY --from=<external image>) are not returned; those builds
// still hit the network. Extend if that gap ever bites.
func BuildBaseImages(service composetypes.ServiceConfig, workingDir string) ([]string, error) {
	build := service.Build
	if build == nil {
		return nil, nil
	}
	content, err := dockerfileContent(build, workingDir)
	if err != nil {
		return nil, err
	}
	res, err := parser.Parse(bytes.NewReader(content))
	if err != nil {
		return nil, fmt.Errorf("parse Dockerfile: %w", err)
	}
	stages, metaArgs, err := instructions.Parse(res.AST, nil)
	if err != nil {
		return nil, fmt.Errorf("parse Dockerfile instructions: %w", err)
	}

	lex := shell.NewLex(res.EscapeToken)
	env := shell.EnvsFromSlice(buildArgEnv(metaArgs, build.Args))

	stageNames := make(map[string]struct{}, len(stages))
	seen := make(map[string]struct{})
	var bases []string
	for _, stage := range stages {
		base := strings.TrimSpace(stage.BaseName)
		if expanded, _, err := lex.ProcessWord(base, env); err == nil {
			base = strings.TrimSpace(expanded)
		}
		if base != "" && !strings.EqualFold(base, "scratch") {
			if _, isStage := stageNames[strings.ToLower(base)]; !isStage {
				if _, dup := seen[base]; !dup {
					seen[base] = struct{}{}
					bases = append(bases, base)
				}
			}
		}
		// Register only after checking the base: a stage may reference earlier
		// stages, never itself or later ones.
		if stage.Name != "" {
			stageNames[strings.ToLower(stage.Name)] = struct{}{}
		}
	}
	return bases, nil
}

func dockerfileContent(build *composetypes.BuildConfig, workingDir string) ([]byte, error) {
	if strings.TrimSpace(build.DockerfileInline) != "" {
		return []byte(build.DockerfileInline), nil
	}
	context := build.Context
	if context == "" {
		context = workingDir
	}
	if !filepath.IsAbs(context) {
		context = filepath.Join(workingDir, context)
	}
	dockerfile := build.Dockerfile
	if dockerfile == "" {
		dockerfile = "Dockerfile"
	}
	path := dockerfile
	if !filepath.IsAbs(path) {
		path = filepath.Join(context, dockerfile)
	}
	return os.ReadFile(path)
}

// buildArgEnv builds the KEY=value environment used to interpolate FROM lines:
// only global ARGs (declared before the first FROM) are in scope for FROM, and
// compose build args override their defaults.
func buildArgEnv(metaArgs []instructions.ArgCommand, buildArgs composetypes.MappingWithEquals) []string {
	values := map[string]string{}
	for _, arg := range metaArgs {
		for _, kv := range arg.Args {
			if kv.Value != nil {
				values[kv.Key] = *kv.Value
			} else if _, ok := values[kv.Key]; !ok {
				values[kv.Key] = ""
			}
		}
	}
	for k, v := range buildArgs {
		if v != nil {
			values[k] = *v
		}
	}
	env := make([]string, 0, len(values))
	for k, v := range values {
		env = append(env, k+"="+v)
	}
	return env
}
