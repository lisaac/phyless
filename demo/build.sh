#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "${1:?usage: build.sh MAIN_CHECKOUT OUTPUT_DIR}" && pwd)"
output_dir="$(mkdir -p "${2:?usage: build.sh MAIN_CHECKOUT OUTPUT_DIR}" && cd "$2" && pwd)"
demo_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

git -C "$source_dir" archive HEAD frontend | tar -x -C "$build_dir"
frontend_dir="$build_dir/frontend"

mkdir -p "$frontend_dir/public"
cp "$demo_dir/bootstrap.js" "$frontend_dir/public/phyless-demo.js"
cp "$demo_dir/vite.demo.config.ts" "$frontend_dir/vite.demo.config.ts"

cd "$frontend_dir"
npm ci
npm run typecheck
GIT_COMMIT="$(git -C "$source_dir" rev-parse --short HEAD)" npx vite build --config vite.demo.config.ts
cp -R "$frontend_dir/demo-dist/." "$output_dir/"
