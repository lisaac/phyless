package compose

// In-process BuildKit builds. Compose v5 only reaches BuildKit by shelling out
// to the `docker buildx` plugin, which would read the host's Docker config for
// registry credentials (not the request's accounts), ignore the request's pull
// proxy and need a ~60 MB plugin in the image. Instead phyless talks to the
// daemon's embedded BuildKit itself, exactly like buildx's "docker" driver
// (/grpc + /session over the API socket), and hands Compose ready images.

import (
	"context"
	"fmt"
	"io"
	"maps"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	cerrdefs "github.com/containerd/errdefs"
	"github.com/docker/cli/cli/config/configfile"
	composeapi "github.com/docker/compose/v5/pkg/api"
	bkclient "github.com/moby/buildkit/client"
	"github.com/moby/buildkit/session"
	"github.com/moby/buildkit/session/auth/authprovider"
	"github.com/moby/buildkit/session/secrets"
	"github.com/moby/buildkit/session/secrets/secretsprovider"
	"github.com/moby/buildkit/session/sshforward/sshprovider"
	"github.com/moby/buildkit/util/progress/progressui"
	"github.com/moby/moby/client"
	"github.com/tonistiigi/fsutil"
)

// buildKitServices builds the given services (in dependency order for
// `service:` additional contexts) and tags each as Compose expects. A nil
// progress writer builds quietly.
func (s *Service) buildKitServices(ctx context.Context, project *composetypes.Project, names []string, progress io.Writer) error {
	if len(names) == 0 {
		return nil
	}
	order, err := buildOrder(project, names)
	if err != nil {
		return err
	}
	api := s.cli.Client()
	c, err := bkclient.New(ctx, "",
		bkclient.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return api.DialHijack(ctx, "/grpc", "h2c", nil)
		}),
		bkclient.WithSessionDialer(func(ctx context.Context, proto string, meta map[string][]string) (net.Conn, error) {
			return api.DialHijack(ctx, "/session", proto, meta)
		}),
	)
	if err != nil {
		return fmt.Errorf("connect to Docker BuildKit: %w", err)
	}
	defer c.Close()
	// ponytail: one service at a time; BuildKit already parallelises inside a
	// build. Parallel solves only if multi-service builds prove slow.
	for _, name := range order {
		if err := s.buildKitService(ctx, c, project, project.Services[name], progress); err != nil {
			return fmt.Errorf("build service %q: %w", name, err)
		}
	}
	return nil
}

func (s *Service) buildKitService(ctx context.Context, c *bkclient.Client, project *composetypes.Project, service composetypes.ServiceConfig, progress io.Writer) error {
	opt, cleanup, err := solveOptions(project, service, s.cli.config)
	defer cleanup()
	if err != nil {
		return err
	}
	if progress == nil {
		_, err = c.Solve(ctx, nil, opt, nil)
		return err
	}
	display, err := progressui.NewDisplay(progress, progressui.PlainMode)
	if err != nil {
		return err
	}
	ch := make(chan *bkclient.SolveStatus)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = display.UpdateFrom(context.WithoutCancel(ctx), ch) // drains until Solve closes ch
	}()
	_, err = c.Solve(ctx, nil, opt, ch)
	<-done
	return err
}

// solveOptions maps one service's Compose build section to a dockerfile
// frontend solve exported into the daemon's image store. cleanup is always
// safe to call.
func solveOptions(project *composetypes.Project, service composetypes.ServiceConfig, config *configfile.ConfigFile) (bkclient.SolveOpt, func(), error) {
	cleanup := func() {}
	b := service.Build
	attrs := map[string]string{}
	mounts := map[string]fsutil.FS{}

	dockerfile := b.Dockerfile
	if dockerfile == "" {
		dockerfile = "Dockerfile"
	}
	if isRemoteContext(b.Context) {
		attrs["context"] = b.Context
		attrs["filename"] = dockerfile
	} else {
		ctxFS, err := fsutil.NewFS(b.Context)
		if err != nil {
			return bkclient.SolveOpt{}, cleanup, fmt.Errorf("build context: %w", err)
		}
		mounts["context"] = ctxFS
		dfPath := dockerfile
		if !filepath.IsAbs(dfPath) {
			dfPath = filepath.Join(b.Context, dfPath)
		}
		if b.DockerfileInline != "" {
			dir, err := os.MkdirTemp("", "phyless-dockerfile-")
			if err != nil {
				return bkclient.SolveOpt{}, cleanup, err
			}
			cleanup = func() { _ = os.RemoveAll(dir) }
			dfPath = filepath.Join(dir, "Dockerfile")
			if err := os.WriteFile(dfPath, []byte(b.DockerfileInline), 0o600); err != nil {
				return bkclient.SolveOpt{}, cleanup, err
			}
		}
		dfFS, err := fsutil.NewFS(filepath.Dir(dfPath))
		if err != nil {
			return bkclient.SolveOpt{}, cleanup, fmt.Errorf("dockerfile: %w", err)
		}
		mounts["dockerfile"] = dfFS
		attrs["filename"] = filepath.Base(dfPath)
	}

	for k, v := range b.AdditionalContexts {
		switch {
		case strings.HasPrefix(v, "service:"):
			dep, ok := project.Services[strings.TrimPrefix(v, "service:")]
			if !ok {
				return bkclient.SolveOpt{}, cleanup, fmt.Errorf("additional context %q: unknown service", k)
			}
			attrs["context:"+k] = "docker-image://" + composeapi.GetImageNameOrDefault(dep, project.Name)
		case isRemoteContext(v) || strings.HasPrefix(v, "docker-image://") || strings.HasPrefix(v, "target:"):
			attrs["context:"+k] = v
		default:
			fs, err := fsutil.NewFS(v)
			if err != nil {
				return bkclient.SolveOpt{}, cleanup, fmt.Errorf("additional context %q: %w", k, err)
			}
			local := "ctx-" + k // never collides with "context"/"dockerfile"
			mounts[local] = fs
			attrs["context:"+k] = "local:" + local
		}
	}

	args := b.Args.Resolve(func(k string) (string, bool) { v, ok := project.Environment[k]; return v, ok })
	for k, v := range args {
		if v != nil {
			attrs["build-arg:"+k] = *v
		}
	}
	for k, v := range imageLabels(project, service) {
		attrs["label:"+k] = v
	}
	if b.Target != "" {
		attrs["target"] = b.Target
	}
	if b.NoCache {
		attrs["no-cache"] = ""
	} else if len(b.NoCacheFilter) > 0 {
		attrs["no-cache"] = strings.Join(b.NoCacheFilter, ",")
	}
	if b.Pull {
		attrs["image-resolve-mode"] = "pull"
	}
	if platforms := b.Platforms; len(platforms) > 0 {
		attrs["platform"] = strings.Join(platforms, ",")
		if len(platforms) > 1 {
			attrs["multi-platform"] = "true"
		}
	} else if service.Platform != "" {
		attrs["platform"] = service.Platform
	}
	var entitlements []string
	switch b.Network {
	case "", "default":
	case "host":
		attrs["force-network-mode"] = "host"
		entitlements = append(entitlements, "network.host")
	default:
		attrs["force-network-mode"] = b.Network
	}
	if b.Privileged {
		entitlements = append(entitlements, "security.insecure")
	}
	entitlements = append(entitlements, b.Entitlements...)
	if hosts := b.ExtraHosts.AsList("="); len(hosts) > 0 {
		attrs["add-hosts"] = strings.Join(hosts, ",")
	}
	if b.ShmSize > 0 {
		attrs["shm-size"] = strconv.FormatInt(int64(b.ShmSize), 10)
	}
	if ulimits := ulimitAttr(b.Ulimits); ulimits != "" {
		attrs["ulimit"] = ulimits
	}

	cacheFrom, err := cacheEntries(b.CacheFrom)
	if err != nil {
		return bkclient.SolveOpt{}, cleanup, err
	}
	cacheTo, err := cacheEntries(b.CacheTo)
	if err != nil {
		return bkclient.SolveOpt{}, cleanup, err
	}

	attachables := []session.Attachable{
		// The request's isolated config: only the registry accounts chosen for
		// this request, never the host's Docker credentials.
		authprovider.NewDockerAuthProvider(authprovider.DockerAuthProviderConfig{
			AuthConfigProvider: authprovider.LoadAuthConfig(config),
		}),
	}
	if len(b.Secrets) > 0 {
		store, err := secretStore(project, b.Secrets)
		if err != nil {
			return bkclient.SolveOpt{}, cleanup, err
		}
		attachables = append(attachables, secretsprovider.NewSecretProvider(store))
	}
	if len(b.SSH) > 0 {
		confs := make([]sshprovider.AgentConfig, 0, len(b.SSH))
		for _, k := range b.SSH {
			conf := sshprovider.AgentConfig{ID: k.ID}
			if k.Path != "" {
				conf.Paths = []string{k.Path}
			}
			confs = append(confs, conf)
		}
		ssh, err := sshprovider.NewSSHAgentProvider(confs)
		if err != nil {
			return bkclient.SolveOpt{}, cleanup, fmt.Errorf("ssh: %w", err)
		}
		attachables = append(attachables, ssh)
	}

	tags := append([]string{composeapi.GetImageNameOrDefault(service, project.Name)}, b.Tags...)
	slices.Sort(tags)
	return bkclient.SolveOpt{
		Frontend:            "dockerfile.v0",
		FrontendAttrs:       attrs,
		LocalMounts:         mounts,
		Exports:             []bkclient.ExportEntry{{Type: "moby", Attrs: map[string]string{"name": strings.Join(slices.Compact(tags), ",")}}},
		CacheImports:        cacheFrom,
		CacheExports:        cacheTo,
		Session:             attachables,
		AllowedEntitlements: entitlements,
	}, cleanup, nil
}

// imageLabels mirrors the labels Compose's own builder sets.
func imageLabels(project *composetypes.Project, service composetypes.ServiceConfig) map[string]string {
	labels := maps.Clone(map[string]string(service.Build.Labels))
	if labels == nil {
		labels = map[string]string{}
	}
	labels[composeapi.VersionLabel] = composeapi.ComposeVersion
	labels[composeapi.ProjectLabel] = project.Name
	labels[composeapi.ServiceLabel] = service.Name
	return labels
}

func isRemoteContext(s string) bool {
	for _, p := range []string{"http://", "https://", "git://", "git@", "github.com/"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// cacheEntries parses cache_from/cache_to: "ref" or "type=registry,ref=...".
func cacheEntries(specs []string) ([]bkclient.CacheOptionsEntry, error) {
	var out []bkclient.CacheOptionsEntry
	for _, spec := range specs {
		if !strings.Contains(spec, "=") {
			out = append(out, bkclient.CacheOptionsEntry{Type: "registry", Attrs: map[string]string{"ref": spec}})
			continue
		}
		e := bkclient.CacheOptionsEntry{Attrs: map[string]string{}}
		for _, field := range strings.Split(spec, ",") {
			k, v, ok := strings.Cut(field, "=")
			if !ok {
				return nil, fmt.Errorf("invalid cache option %q", spec)
			}
			if k == "type" {
				e.Type = v
			} else {
				e.Attrs[k] = v
			}
		}
		if e.Type == "" {
			e.Type = "registry"
		}
		out = append(out, e)
	}
	return out, nil
}

func ulimitAttr(ulimits map[string]*composetypes.UlimitsConfig) string {
	var parts []string
	for name, u := range ulimits {
		if u == nil {
			continue
		}
		soft, hard := u.Soft, u.Hard
		if u.Single != 0 {
			soft, hard = u.Single, u.Single
		}
		parts = append(parts, fmt.Sprintf("%s=%d:%d", name, soft, hard))
	}
	slices.Sort(parts)
	return strings.Join(parts, ",")
}

// secretStore resolves build secrets from the project definition only:
// file, project environment or inline content — never phyless's own env.
func secretStore(project *composetypes.Project, refs []composetypes.ServiceSecretConfig) (secrets.SecretStore, error) {
	m := make(mapSecrets, len(refs))
	for _, ref := range refs {
		def, ok := project.Secrets[ref.Source]
		if !ok {
			return nil, fmt.Errorf("build secret %q is not defined in the project", ref.Source)
		}
		id := ref.Target
		if id == "" {
			id = ref.Source
		}
		switch {
		case def.File != "":
			file := def.File
			m[id] = func() ([]byte, error) { return os.ReadFile(file) }
		case def.Environment != "":
			v, ok := project.Environment[def.Environment]
			if !ok {
				return nil, fmt.Errorf("build secret %q: environment variable %s is not set", ref.Source, def.Environment)
			}
			m[id] = func() ([]byte, error) { return []byte(v), nil }
		case def.Content != "":
			content := def.Content
			m[id] = func() ([]byte, error) { return []byte(content), nil }
		default:
			return nil, fmt.Errorf("build secret %q has no file, environment or content", ref.Source)
		}
	}
	return m, nil
}

type mapSecrets map[string]func() ([]byte, error)

func (m mapSecrets) GetSecret(_ context.Context, id string) ([]byte, error) {
	if get, ok := m[id]; ok {
		return get()
	}
	return nil, fmt.Errorf("secret %s: %w", id, secrets.ErrNotFound)
}

// buildOrder returns names with every `service:` additional-context
// dependency that is also being built placed before its dependent.
func buildOrder(project *composetypes.Project, names []string) ([]string, error) {
	want := map[string]bool{}
	for _, n := range names {
		if _, ok := project.Services[n]; !ok {
			return nil, fmt.Errorf("unknown service %q", n)
		}
		want[n] = true
	}
	var order []string
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(string) error
	visit = func(n string) error {
		switch state[n] {
		case 1:
			return fmt.Errorf("additional_contexts cycle at service %q", n)
		case 2:
			return nil
		}
		state[n] = 1
		if b := project.Services[n].Build; b != nil {
			deps := make([]string, 0)
			for _, v := range b.AdditionalContexts {
				if dep, ok := strings.CutPrefix(v, "service:"); ok && want[dep] {
					deps = append(deps, dep)
				}
			}
			slices.Sort(deps)
			for _, dep := range deps {
				if err := visit(dep); err != nil {
					return err
				}
			}
		}
		state[n] = 2
		order = append(order, n)
		return nil
	}
	sorted := slices.Sorted(maps.Keys(want))
	for _, n := range sorted {
		if err := visit(n); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// servicesToBuild lists services with a build section whose image must be
// (re)built before `up`: pull_policy build, or the image is missing locally.
// A service that also names a pullable image keeps Compose's order: pull
// first, build only if that pull did not produce the image.
func (s *Service) servicesToBuild(ctx context.Context, project *composetypes.Project) ([]string, error) {
	api := s.cli.Client()
	var names, tryPull []string
	for name, svc := range project.Services {
		if svc.Build == nil {
			continue
		}
		if svc.PullPolicy == composetypes.PullPolicyBuild {
			names = append(names, name)
			continue
		}
		if exists, err := imageExists(ctx, api, composeapi.GetImageNameOrDefault(svc, project.Name)); err != nil {
			return nil, err
		} else if exists {
			continue
		}
		if svc.Image != "" && svc.PullPolicy != composetypes.PullPolicyNever {
			tryPull = append(tryPull, name)
		} else {
			names = append(names, name)
		}
	}
	if len(tryPull) > 0 {
		pullable, err := project.WithSelectedServices(tryPull)
		if err != nil {
			return nil, err
		}
		_ = s.compose.Pull(ctx, pullable, composeapi.PullOptions{IgnoreFailures: true, Quiet: true})
		for _, name := range tryPull {
			if exists, err := imageExists(ctx, api, project.Services[name].Image); err != nil {
				return nil, err
			} else if !exists {
				names = append(names, name)
			}
		}
	}
	slices.Sort(names)
	return names, nil
}

func imageExists(ctx context.Context, api client.APIClient, ref string) (bool, error) {
	_, err := api.ImageInspect(ctx, ref)
	if cerrdefs.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}
