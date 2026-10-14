#!/bin/sh
# Refresh the static busybox binaries embedded for the no-shell debug terminal
# (backend/internal/docker/debugshell). Source: Alpine's busybox-static package,
# pinned below; bump ALPINE/VERSION, run, and commit the binaries.
set -eu

ALPINE=v3.24
VERSION=1.37.0-r31
OUT=$(cd "$(dirname "$0")/.." && pwd)/backend/internal/docker/debugshell
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for pair in amd64:x86_64 arm64:aarch64; do
	goarch=${pair%%:*} apkarch=${pair#*:}
	curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/$ALPINE/main/$apkarch/busybox-static-$VERSION.apk" -o "$TMP/$goarch.apk"
	mkdir "$TMP/$goarch"
	tar -xzf "$TMP/$goarch.apk" -C "$TMP/$goarch" bin/busybox.static 2>/dev/null
	install -m 0755 "$TMP/$goarch/bin/busybox.static" "$OUT/busybox-$goarch"
done
(cd "$OUT" && shasum -a 256 busybox-*)
