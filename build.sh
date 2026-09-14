#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

os=$(go env GOHOSTOS)
arch=$(go env GOHOSTARCH)
case "$os" in
  linux|windows) cgo=0 ;;
  darwin) cgo=1 ;; # fsevents needs CGO for native macOS builds.
  *) echo "build.sh: unsupported operating system: $os" >&2; exit 1 ;;
esac

output=phyless
[ "$os" = windows ] && output="$output.exe"

echo "== building frontend =="
(cd frontend && npm run build)

echo "== building backend for $os/$arch =="
rm -rf backend/web/dist
mkdir -p backend/web/dist
cp -R frontend/dist/. backend/web/dist/
CGO_ENABLED="$cgo" GOOS="$os" GOARCH="$arch" ./scripts/go-build.sh -o "$output" ./backend/cmd/server/

echo "built $output"
