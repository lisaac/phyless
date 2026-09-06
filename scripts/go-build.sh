#!/bin/sh
# Release build. compose/pkg/compose/build_buildkit.go blank-imports four buildx
# drivers; "kubernetes" and "remote" drag in ~277 k8s.io packages that are dead
# weight here, because configureComposeBuildEnvironment (internal/docker/compose/
# runtime.go) rejects any BUILDX_BUILDER but "default" at startup. We drop those
# two imports with go build -overlay. Go forbids overlaying GOMODCACHE, so the
# module is reached through a temp symlink + throwaway go.mod replace; nothing in
# the repo or the module cache is modified. "docker"/"docker-container" stay.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
MOD=$(go list -m -f '{{.Dir}}' github.com/docker/compose/v2)
if [ -z "$MOD" ]; then
	go mod download github.com/docker/compose/v2
	MOD=$(go list -m -f '{{.Dir}}' github.com/docker/compose/v2)
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ln -s "$MOD" "$TMP/compose"
cp "$REPO/go.mod" "$REPO/go.sum" "$TMP/"
go mod edit -modfile="$TMP/go.mod" -replace "github.com/docker/compose/v2=$TMP/compose"

SRC="$MOD/pkg/compose/build_buildkit.go"
grep -v -E '^[[:space:]]*_ "github.com/docker/buildx/driver/(kubernetes|remote)"' "$SRC" >"$TMP/build_buildkit.go"
DROPPED=$(($(wc -l <"$SRC") - $(wc -l <"$TMP/build_buildkit.go")))
if [ "$DROPPED" -ne 2 ]; then
	echo "go-build.sh: expected to drop 2 buildx driver imports, dropped $DROPPED" >&2
	echo "go-build.sh: compose changed; re-check $SRC before releasing." >&2
	exit 1
fi
printf '{"Replace":{"%s":"%s"}}' "$TMP/compose/pkg/compose/build_buildkit.go" "$TMP/build_buildkit.go" >"$TMP/overlay.json"

exec go build -modfile="$TMP/go.mod" -overlay "$TMP/overlay.json" -trimpath -ldflags='-s -w' "$@"
