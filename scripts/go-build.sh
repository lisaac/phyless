#!/bin/sh
# Release build. The embedded Compose API drags in code that this server can
# never reach (it pins BUILDX_BUILDER=default and COMPOSE_BAKE=false at startup,
# see backend/internal/docker/compose/runtime.go, and never exports telemetry). We drop
# it with go build -overlay instead of forking the modules:
#
#   compose  build_buildkit.go   blank-imports of the kubernetes/remote/
#                                docker-container buildx drivers (k8s.io ~35 MB)
#   buildx   build/opt.go        S3 cache credential lookup (aws-sdk-go-v2)
#   buildx   util/buildflags     HCL/cty decoders used only by bake (go-cty)
#   cli      command/telemetry*  OTLP metric/trace exporters (otel sdk)
#   compose  internal/tracing    OTLP exporter setup (otel sdk, buildkit detect)
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

link github.com/docker/compose/v2 compose
link github.com/docker/buildx buildx
link github.com/docker/cli cli

# --- compose: drop dead buildx drivers -------------------------------------
SRC="$TMP/compose/pkg/compose/build_buildkit.go"
expect 3 "$SRC" '^[[:space:]]*_ "github.com/docker/buildx/driver/(kubernetes|remote|docker-container)"'
grep -v -E '^[[:space:]]*_ "github.com/docker/buildx/driver/(kubernetes|remote|docker-container)"' "$SRC" >"$TMP/ov/build_buildkit.go"
overlay "$SRC" "$TMP/ov/build_buildkit.go"

# --- buildx: no AWS credential lookup for s3 cache --------------------------
SRC="$TMP/buildx/build/opt.go"
expect 1 "$SRC" '^[[:space:]]*awsconfig "github.com/aws/aws-sdk-go-v2/config"'
expect 1 "$SRC" '^func addAwsCredentials\(ci \*client.CacheOptionsEntry\) \{'
awk '
	/^[[:space:]]*awsconfig "github.com\/aws\/aws-sdk-go-v2\/config"/ { next }
	/^func addAwsCredentials\(ci \*client.CacheOptionsEntry\) \{/ { print "func addAwsCredentials(*client.CacheOptionsEntry) {} // phyless: no S3 cache credentials on this build"; skip=1; next }
	skip && /^}/ { skip=0; next }
	skip { next }
	{ print }
' "$SRC" >"$TMP/ov/opt.go"
overlay "$SRC" "$TMP/ov/opt.go"

# --- buildx: drop cty (bake HCL) decoders ------------------------------------
for f in attests cache export secrets ssh; do
	[ -f "$TMP/buildx/util/buildflags/${f}_cty.go" ] || die "missing buildflags/${f}_cty.go"
	overlay "$TMP/buildx/util/buildflags/${f}_cty.go" ""
done
SRC="$TMP/buildx/util/buildflags/cache.go"
expect 2 "$SRC" '"github.com/zclconf/go-cty/cty(/json)?"'
expect 1 "$SRC" '^[[:space:]]*case cty.Value:'
awk '
	/"github.com\/zclconf\/go-cty\/cty(\/json)?"/ { next }
	/^[[:space:]]*case cty.Value:/ { getline; next }
	{ print }
' "$SRC" >"$TMP/ov/cache.go"
overlay "$SRC" "$TMP/ov/cache.go"
SRC="$TMP/buildx/util/buildflags/utils.go"
expect 1 "$SRC" '^func removeDupes\['
expect 1 "$SRC" '^func getAndDelete\('
awk '/^func getAndDelete\(/ { exit } { print }' "$SRC" | grep -v 'zclconf/go-cty' >"$TMP/ov/utils.go"
overlay "$SRC" "$TMP/ov/utils.go"

# --- docker/cli: no OTLP telemetry -------------------------------------------
SRC="$TMP/cli/cli/command/telemetry.go"
expect 1 "$SRC" '^type TelemetryClient interface'
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
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

type TelemetryClient interface {
	TracerProvider() trace.TracerProvider
	MeterProvider() metric.MeterProvider
}

type telemetryResource struct{}

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

printf '{"Replace":{%s}}' "$OVERLAY" >"$TMP/overlay.json"
exec go build -modfile="$TMP/go.mod" -overlay "$TMP/overlay.json" -trimpath -ldflags='-s -w' "$@"
