#!/bin/sh
# Release build. The embedded Compose API drags in code that this server can
# never reach (it never exports telemetry). We drop it with go build -overlay
# instead of forking the modules:
#
#   cli      command/telemetry*  OTLP metric/trace exporters (otel sdk)
#   compose  internal/tracing    OTLP exporter setup (otel sdk, buildkit detect)
#   cli      command/container   init() registering `docker container …` cobra
#                                commands (Compose only calls RunExec/RunAttach)
#   grpc     -tags grpcnotrace   x/net/trace debug pages (html/template)
#
# The last two matter far more than their own size: any reachable text/template
# execution makes the linker keep every exported method of every type (reflect
# MethodByName), ~8 MB here. Check with -ldflags=-dumpdep: no <ReflectMethod>.
#
# (Compose v5 no longer links buildx. phyless builds in process against the
# daemon's BuildKit, see backend/internal/docker/compose/buildkit.go; Compose's
# own classic builder stays only as the fallback for daemons without BuildKit.)
#
# Go forbids overlaying GOMODCACHE, so each module is reached through a temp
# symlink + throwaway go.mod replace; nothing in the repo or the module cache is
# modified. Every patch is guarded by a count check so an upstream change fails
# the build loudly instead of silently re-growing the binary.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$REPO/go.mod" "$REPO/go.sum" "$TMP/"
mkdir "$TMP/ov"
OVERLAY=""

die() { echo "go-build.sh: $*" >&2; echo "go-build.sh: upstream changed; re-check the stubs before releasing." >&2; exit 1; }

# link MOD ALIAS -> symlink module dir into TMP and point go.mod at it.
# A directory replacement needs a go.mod; +incompatible modules (docker/cli)
# have none, so those get a shim dir of symlinks plus a synthesized go.mod.
link() {
	dir=$(go list -m -f '{{.Dir}}' "$1")
	[ -n "$dir" ] || { go mod download "$1"; dir=$(go list -m -f '{{.Dir}}' "$1"); }
	if [ -f "$dir/go.mod" ]; then
		ln -s "$dir" "$TMP/$2"
	else
		mkdir "$TMP/$2"
		ln -s "$dir"/* "$TMP/$2/"
		printf 'module %s\n\ngo %s\n' "$1" "$(go list -m -f '{{.GoVersion}}' "$1" | grep . || echo 1.24)" >"$TMP/$2/go.mod"
	fi
	go mod edit -modfile="$TMP/go.mod" -replace "$1=$TMP/$2"
}
# overlay SRC DST -> map SRC to DST (DST empty string deletes the file)
overlay() { OVERLAY="$OVERLAY${OVERLAY:+,}\"$1\":\"$2\""; }
# expect N FILE PATTERN -> guard
expect() { n=$(grep -c -E "$3" "$2" || true); [ "$n" -eq "$1" ] || die "expected $1 match(es) of '$3' in $2, got $n"; }

link github.com/docker/compose/v5 compose
link github.com/docker/cli cli

# --- docker/cli: no OTLP telemetry -------------------------------------------
SRC="$TMP/cli/cli/command/telemetry.go"
expect 1 "$SRC" '^type TelemetryClient interface'
expect 1 "$SRC" '^func \(cli \*DockerCli\) Resource\(\) \*resource.Resource'
expect 1 "$SRC" '^func \(cli \*DockerCli\) createGlobalMeterProvider\('
expect 1 "$SRC" '^func \(cli \*DockerCli\) createGlobalTracerProvider\('
expect 1 "$SRC" '^func filterResourceAttributesEnvvar\(\)'
expect 1 "$TMP/cli/cli/command/telemetry_utils.go" '^func \(cli \*DockerCli\) InstrumentCobraCommands\('
cat >"$TMP/ov/telemetry.go" <<'GO'
package command

// phyless: telemetry stub. This server never exports OTLP metrics or traces,
// so the SDK, exporters and resource detection are compiled out.

import (
	"context"

	"github.com/spf13/cobra"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

type TelemetryClient interface {
	Resource() *resource.Resource
	TracerProvider() trace.TracerProvider
	MeterProvider() metric.MeterProvider
}

type telemetryResource struct{}

func (*DockerCli) Resource() *resource.Resource { return resource.Empty() }

func (*DockerCli) TracerProvider() trace.TracerProvider { return tracenoop.NewTracerProvider() }
func (*DockerCli) MeterProvider() metric.MeterProvider  { return metricnoop.NewMeterProvider() }

func (*DockerCli) createGlobalMeterProvider(context.Context)  {}
func (*DockerCli) createGlobalTracerProvider(context.Context) {}
func filterResourceAttributesEnvvar()                         {}

func BaseCommandAttributes(*cobra.Command, Streams) []attribute.KeyValue { return nil }
func (*DockerCli) InstrumentCobraCommands(context.Context, *cobra.Command) {}
func (*DockerCli) StartInstrumentation(*cobra.Command) func(error)        { return func(error) {} }
GO
overlay "$SRC" "$TMP/ov/telemetry.go"
overlay "$TMP/cli/cli/command/telemetry_docker.go" ""
overlay "$TMP/cli/cli/command/telemetry_utils.go" ""

# --- compose: no OTLP tracing setup ------------------------------------------
for f in tracing mux docker_context; do
	[ -f "$TMP/compose/internal/tracing/$f.go" ] || die "missing internal/tracing/$f.go"
	overlay "$TMP/compose/internal/tracing/$f.go" ""
done
expect 0 "$TMP/compose/internal/tracing/attributes.go" 'otel/sdk|OTLPConfig|ShutdownFunc'
expect 0 "$TMP/compose/internal/tracing/wrap.go" 'otel/sdk|OTLPConfig|ShutdownFunc'

# --- cli: no `docker container` command registration ------------------------
# Renamed, not deleted, so the files' imports stay used; the unexported funcs
# are then unreachable and dropped.
for f in cmd prune; do
	SRC="$TMP/cli/cli/command/container/$f.go"
	expect 1 "$SRC" '^func init\(\) \{$'
	sed "s/^func init() {$/func phylessDropped_$f() {/" "$SRC" >"$TMP/ov/container_$f.go"
	overlay "$SRC" "$TMP/ov/container_$f.go"
done

printf '{"Replace":{%s}}' "$OVERLAY" >"$TMP/overlay.json"
exec go build -modfile="$TMP/go.mod" -overlay "$TMP/overlay.json" -tags grpcnotrace -trimpath -ldflags='-s -w' "$@"
