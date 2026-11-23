package compose

import (
	"context"
	"io"

	composetypes "github.com/compose-spec/compose-go/v2/types"
	composeapi "github.com/docker/compose/v5/pkg/api"
)

// The operations api/compose.go runs, so it never imports the Compose library
// itself: a Compose major bump (v2 → v5 changed the module path) stays here.

// Labels Compose sets on the containers it manages.
const (
	ProjectLabel         = composeapi.ProjectLabel
	ServiceLabel         = composeapi.ServiceLabel
	ConfigFilesLabel     = composeapi.ConfigFilesLabel
	WorkingDirLabel      = composeapi.WorkingDirLabel
	EnvironmentFileLabel = composeapi.EnvironmentFileLabel
)

// LogConsumer receives `compose logs` lines.
type LogConsumer = composeapi.LogConsumer

// Up builds missing images (quietly; failures still return), creates/
// recreates diverged services and starts the project, like
// `docker compose up -d`.
func (s *Service) Up(ctx context.Context, project *composetypes.Project, buildOut io.Writer) error {
	build := &composeapi.BuildOptions{Deps: true, Quiet: true, Progress: "quiet", Out: buildOut}
	if s.cli.runtime.buildKit {
		names, err := s.servicesToBuild(ctx, project)
		if err != nil {
			return err
		}
		if err := s.buildKitServices(ctx, project, names, nil); err != nil {
			return err
		}
		build = nil // images are in place; Compose must not build again
	}
	return s.compose.Up(ctx, project, composeapi.UpOptions{
		Create: composeapi.CreateOptions{
			Build:                build,
			Recreate:             composeapi.RecreateDiverged,
			RecreateDependencies: composeapi.RecreateDiverged,
			Inherit:              true,
		},
		Start: composeapi.StartOptions{Project: project},
	})
}

func (s *Service) Stop(ctx context.Context, name string, project *composetypes.Project) error {
	return s.compose.Stop(ctx, name, composeapi.StopOptions{Project: project})
}

func (s *Service) Pause(ctx context.Context, name string, project *composetypes.Project) error {
	return s.compose.Pause(ctx, name, composeapi.PauseOptions{Project: project})
}

func (s *Service) Down(ctx context.Context, name string, project *composetypes.Project) error {
	return s.compose.Down(ctx, name, composeapi.DownOptions{Project: project})
}

func (s *Service) Restart(ctx context.Context, name string, project *composetypes.Project) error {
	return s.compose.Restart(ctx, name, composeapi.RestartOptions{Project: project})
}

// Build builds every service with a build section, plain progress to out.
func (s *Service) Build(ctx context.Context, project *composetypes.Project, out io.Writer) error {
	if !s.cli.runtime.buildKit {
		return s.compose.Build(ctx, project, composeapi.BuildOptions{Progress: "plain", Out: out})
	}
	var names []string
	for name, svc := range project.Services {
		if svc.Build != nil {
			names = append(names, name)
		}
	}
	return s.buildKitServices(ctx, project, names, out)
}

// Pull pulls service images, skipping services that are built locally.
func (s *Service) Pull(ctx context.Context, project *composetypes.Project) error {
	return s.compose.Pull(ctx, project, composeapi.PullOptions{IgnoreBuildable: true})
}

// LogsOptions mirrors `docker compose logs` flags phyless exposes.
type LogsOptions struct {
	Since, Until, Tail string
}

// Logs follows the project's container logs (with timestamps) until ctx ends.
// project may be nil for a project known only from running containers.
func (s *Service) Logs(ctx context.Context, name string, project *composetypes.Project, consumer LogConsumer, o LogsOptions) error {
	return s.compose.Logs(ctx, name, consumer, composeapi.LogOptions{
		Project: project, Follow: true, Timestamps: true, Since: o.Since, Until: o.Until, Tail: o.Tail,
	})
}
