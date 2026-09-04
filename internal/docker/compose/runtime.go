// Package compose embeds the official Docker Compose service API.
package compose

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	composecli "github.com/compose-spec/compose-go/v2/cli"
	composetypes "github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/cli/cli/command"
	"github.com/docker/cli/cli/config/configfile"
	configtypes "github.com/docker/cli/cli/config/types"
	dockercontext "github.com/docker/cli/cli/context/docker"
	"github.com/docker/cli/cli/context/store"
	"github.com/docker/cli/cli/flags"
	"github.com/docker/cli/cli/streams"
	composeapi "github.com/docker/compose/v2/pkg/api"
	composeimpl "github.com/docker/compose/v2/pkg/compose"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	dockerregistry "github.com/docker/docker/registry"
	"github.com/spf13/pflag"
)

// Runtime owns the process-scoped Docker CLI state needed by Compose and
// creates request-scoped adapters around the shared Docker API client.
//
// Docker Compose's build path uses buildx, whose builder store requires a
// non-nil context store and a resolved default endpoint. Initializing those
// pieces once here avoids calling DockerCli.Initialize for every HTTP request
// (which also changes process-global CLI state).
type Runtime struct {
	base         *command.DockerCli
	client       client.APIClient
	contextStore store.Store
	currentCtx   string
	endpoint     dockercontext.Endpoint
	serverInfo   command.ServerInfo
	baseConfig   *configfile.ConfigFile
}

// NewRuntime initializes the official Docker CLI once against the already
// connected API client. The default context is deliberately resolved from the
// client's daemon endpoint, so Compose and the rest of the application cannot
// silently select another Docker context.
func NewRuntime(dc client.APIClient) (*Runtime, error) {
	if dc == nil {
		return nil, fmt.Errorf("docker client is nil")
	}
	if err := configureComposeBuildEnvironment(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(os.Getenv(configfile.DockerEnvConfigKey)) != "" {
		return nil, fmt.Errorf("%s is not supported by Compose API requests; select registry accounts per request instead", configfile.DockerEnvConfigKey)
	}

	sink := io.Discard
	base, err := command.NewDockerCli(
		command.WithAPIClient(dc),
		command.WithOutputStream(sink),
		command.WithErrorStream(sink),
		command.WithInputStream(io.NopCloser(strings.NewReader(""))),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize compose Docker CLI: %w", err)
	}

	options := newClientOptions()
	// Supplying the same endpoint as an explicit host makes the CLI use its
	// virtual "default" context while retaining the endpoint selected by the
	// application's APIClient (normally DOCKER_HOST or the Unix socket).
	if host := dc.DaemonHost(); host != "" {
		options.Hosts = []string{host}
	}
	if err := base.Initialize(options); err != nil {
		return nil, fmt.Errorf("initialize compose Docker CLI options: %w", err)
	}

	// Resolve endpoint and server capabilities during process setup. The
	// request adapter below only reads these cached values and never invokes the
	// official CLI's lazy initializer.
	endpoint := base.DockerEndpoint()
	serverInfo := base.ServerInfo()
	return &Runtime{
		base:         base,
		client:       dc,
		contextStore: base.ContextStore(),
		currentCtx:   base.CurrentContext(),
		endpoint:     endpoint,
		serverInfo:   serverInfo,
		baseConfig:   base.ConfigFile(),
	}, nil
}

// configureComposeBuildEnvironment is called once while the process-scoped
// Compose runtime is initialized. Compose v2.40 defaults to Bake when the
// variable is absent, and buildx also consults BUILDX_BUILDER for every build;
// neither implicit choice is safe for an API service that promises no hidden
// subprocess or remote builder. An unset variable is therefore fixed to the
// daemon's default exactly once at startup. Requests never mutate the env.
func configureComposeBuildEnvironment() error {
	if raw, ok := os.LookupEnv("COMPOSE_BAKE"); !ok {
		if err := os.Setenv("COMPOSE_BAKE", "false"); err != nil {
			return fmt.Errorf("disable Compose Bake at startup: %w", err)
		}
	} else {
		enabled, err := strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return fmt.Errorf("COMPOSE_BAKE must be false for the embedded Compose API: %w", err)
		}
		if enabled {
			return fmt.Errorf("COMPOSE_BAKE=true is not supported by the embedded Compose API; set COMPOSE_BAKE=false before startup")
		}
	}

	if raw := strings.TrimSpace(os.Getenv("BUILDX_BUILDER")); raw == "" {
		if err := os.Setenv("BUILDX_BUILDER", "default"); err != nil {
			return fmt.Errorf("select Docker default builder at startup: %w", err)
		}
	} else if raw != "default" {
		return fmt.Errorf("BUILDX_BUILDER=%q is not supported by the embedded Compose API; use the Docker daemon default builder", raw)
	}
	return nil
}

func newClientOptions() *flags.ClientOptions {
	options := flags.NewClientOptions()
	flagSet := pflag.NewFlagSet("compose", pflag.ContinueOnError)
	options.InstallFlags(flagSet)
	options.SetDefaultOptions(flagSet)
	return options
}

// ServiceOptions controls one Compose operation's output and registry
// credentials. AuthConfigs are copied into an isolated CLI config; they are
// never written back to the process-wide Docker config.
type ServiceOptions struct {
	Output io.Writer

	// AuthConfigs uses Docker's canonical registry host keys. Docker Hub keys
	// such as docker.io are normalized to the key used by Compose internally.
	AuthConfigs map[string]registry.AuthConfig
}

// Service is a request-scoped Compose API facade. The underlying official
// service intentionally is not closed here because Close would close the
// shared Docker API client owned by Server.
type Service struct {
	compose composeapi.Compose
	cli     *requestCLI
}

// NewService returns a Compose API service using the Runtime's shared daemon
// client and process-scoped CLI initialization.
func (r *Runtime) NewService(ctx context.Context, options ServiceOptions) (*Service, error) {
	if r == nil || r.base == nil || r.client == nil {
		return nil, fmt.Errorf("compose runtime is not initialized")
	}
	if options.Output == nil {
		options.Output = io.Discard
	}

	out := streams.NewOut(options.Output)
	in := streams.NewIn(io.NopCloser(strings.NewReader("")))
	request := &requestCLI{
		DockerCli: r.base,
		runtime:   r,
		in:        in,
		out:       out,
		err:       out,
		config:    cloneConfigFile(r.baseConfig, options.AuthConfigs),
	}

	service := composeimpl.NewComposeService(request, composeimpl.WithPrompt(func(message string, defaultValue bool) (bool, error) {
		return false, fmt.Errorf("compose confirmation required: %s", message)
	}))
	return &Service{compose: service, cli: request}, nil
}

// Compose exposes the official Compose service API for this request.
func (s *Service) Compose() composeapi.Compose {
	if s == nil {
		return nil
	}
	return s.compose
}

// ConfigFile returns the isolated Docker CLI config used by this service.
func (s *Service) ConfigFile() *configfile.ConfigFile {
	if s == nil || s.cli == nil {
		return nil
	}
	return s.cli.config
}

// MaxConcurrency sets the official Compose service concurrency limit. The
// v2.40.3 pull implementation appends build fallbacks from concurrent
// goroutines without synchronization; callers should use 1 for Pull until a
// Compose release fixes that upstream race.
func (s *Service) MaxConcurrency(parallel int) {
	if s != nil && s.compose != nil {
		s.compose.MaxConcurrency(parallel)
	}
}

// ProjectOptions is the subset of compose-go project options needed by the
// HTTP API. Paths are resolved relative to WorkingDir before compose-go reads
// them, matching `docker compose -f ...` with cmd.Dir set to that directory.
type ProjectOptions struct {
	Name        string
	WorkingDir  string
	ConfigPaths []string
	EnvFiles    []string
	Environment []string
}

// LoadProject loads and labels a Compose project using compose-go. The custom
// labels mirror the official Docker Compose command path and are consumed by
// convergence and live project discovery.
func (r *Runtime) LoadProject(ctx context.Context, options ProjectOptions) (*composetypes.Project, error) {
	configPaths, workingDir, err := normalizeProjectPaths(options.WorkingDir, options.ConfigPaths)
	if err != nil {
		return nil, err
	}

	environment := options.Environment
	if len(environment) == 0 {
		environment = os.Environ()
	}
	envMap := composetypes.NewMapping(environment)
	envFiles := append([]string(nil), options.EnvFiles...)
	if len(envFiles) == 0 {
		// The CLI exposes COMPOSE_ENV_FILES as a comma-separated StringArray
		// default. Keep that behavior before falling back to the local .env.
		envFiles = splitComma(envMap["COMPOSE_ENV_FILES"])
	}
	envFiles, err = normalizeProjectPathsFromWorkingDir(workingDir, envFiles)
	if err != nil {
		return nil, err
	}

	projectOptions, err := composecli.NewProjectOptions(configPaths,
		composecli.WithWorkingDirectory(workingDir),
	)
	if err != nil {
		return nil, err
	}
	if options.Name != "" {
		if err := composecli.WithName(options.Name)(projectOptions); err != nil {
			return nil, err
		}
	}
	if err := composecli.WithEnv(environment)(projectOptions); err != nil {
		return nil, err
	}
	if len(envFiles) > 0 {
		if err := composecli.WithEnvFiles(envFiles...)(projectOptions); err != nil {
			return nil, err
		}
	} else if err := composecli.WithEnvFiles()(projectOptions); err != nil {
		return nil, err
	}
	if err := composecli.WithDotEnv(projectOptions); err != nil {
		return nil, err
	}
	if err := composecli.WithDefaultProfiles()(projectOptions); err != nil {
		return nil, err
	}

	project, err := projectOptions.LoadProject(ctx)
	if err != nil {
		return nil, err
	}
	applyComposeLabels(project, envFiles)
	return project, nil
}

func normalizeProjectPaths(workingDir string, paths []string) ([]string, string, error) {
	if workingDir == "" {
		if len(paths) > 0 && paths[0] != "-" {
			if remote := unsupportedRemoteReference(paths[0]); remote != "" {
				return nil, "", fmt.Errorf("remote Compose config source %q is not supported by the embedded API", remote)
			}
			abs, err := filepath.Abs(paths[0])
			if err != nil {
				return nil, "", err
			}
			workingDir = filepath.Dir(abs)
		} else {
			workingDir = "."
		}
	}
	absWorkingDir, err := filepath.Abs(workingDir)
	if err != nil {
		return nil, "", err
	}
	configPaths, err := normalizeProjectPathsFromWorkingDir(absWorkingDir, paths)
	return configPaths, absWorkingDir, err
}

func normalizeProjectPathsFromWorkingDir(workingDir string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if remote := unsupportedRemoteReference(path); remote != "" {
			return nil, fmt.Errorf("remote Compose config source %q is not supported by the embedded API", remote)
		}
		if path != "-" && !filepath.IsAbs(path) {
			path = filepath.Join(workingDir, path)
		}
		result = append(result, filepath.Clean(path))
	}
	return result, nil
}

func unsupportedRemoteReference(value string) string {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	for _, prefix := range []string{
		"http://", "https://", "git://", "git+", "ssh://", "oci://",
	} {
		if strings.HasPrefix(lower, prefix) {
			return value
		}
	}
	return ""
}

func splitComma(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

func applyComposeLabels(project *composetypes.Project, envFiles []string) {
	for name, service := range project.Services {
		service.CustomLabels = composetypes.Labels{
			composeapi.ProjectLabel:     project.Name,
			composeapi.ServiceLabel:     name,
			composeapi.VersionLabel:     composeapi.ComposeVersion,
			composeapi.WorkingDirLabel:  project.WorkingDir,
			composeapi.ConfigFilesLabel: strings.Join(project.ComposeFiles, ","),
			composeapi.OneoffLabel:      "False",
		}
		if len(envFiles) > 0 {
			service.CustomLabels[composeapi.EnvironmentFileLabel] = strings.Join(envFiles, ",")
		}
		project.Services[name] = service
	}
}

func cloneConfigFile(source *configfile.ConfigFile, auths map[string]registry.AuthConfig) *configfile.ConfigFile {
	filename := ""
	if source != nil {
		filename = source.Filename
	}
	// Compose only needs the filename for buildx's per-daemon state path. Do
	// not copy host credential stores, proxies, or auth entries: registry
	// credentials are supplied explicitly per request below.
	clone := configfile.New(filename)
	for key, auth := range auths {
		clone.AuthConfigs[composeAuthConfigKey(key)] = configtypes.AuthConfig{
			Username:      auth.Username,
			Password:      auth.Password,
			Auth:          auth.Auth,
			Email:         auth.Email,
			ServerAddress: auth.ServerAddress,
			IdentityToken: auth.IdentityToken,
			RegistryToken: auth.RegistryToken,
		}
	}
	return clone
}

func composeAuthConfigKey(key string) string {
	key = strings.TrimRight(strings.TrimSpace(key), "/")
	switch strings.TrimPrefix(key, "https://") {
	case "docker.io", "index.docker.io", "registry-1.docker.io":
		return dockerregistry.IndexServer
	default:
		return key
	}
}

// requestCLI supplies request-local streams and config while delegating the
// initialized context, endpoint, and telemetry implementation to Runtime.
type requestCLI struct {
	*command.DockerCli
	runtime *Runtime
	in      *streams.In
	out     *streams.Out
	err     *streams.Out
	config  *configfile.ConfigFile
}

var _ command.Cli = (*requestCLI)(nil)

func (c *requestCLI) Client() client.APIClient               { return c.runtime.client }
func (c *requestCLI) ConfigFile() *configfile.ConfigFile     { return c.config }
func (c *requestCLI) In() *streams.In                        { return c.in }
func (c *requestCLI) Out() *streams.Out                      { return c.out }
func (c *requestCLI) Err() *streams.Out                      { return c.err }
func (c *requestCLI) SetIn(in *streams.In)                   { c.in = in }
func (c *requestCLI) ServerInfo() command.ServerInfo         { return c.runtime.serverInfo }
func (c *requestCLI) CurrentVersion() string                 { return c.runtime.client.ClientVersion() }
func (c *requestCLI) BuildKitEnabled() (bool, error)         { return c.runtime.base.BuildKitEnabled() }
func (c *requestCLI) ContextStore() store.Store              { return c.runtime.contextStore }
func (c *requestCLI) CurrentContext() string                 { return c.runtime.currentCtx }
func (c *requestCLI) DockerEndpoint() dockercontext.Endpoint { return c.runtime.endpoint }
