#!/bin/sh
# Pinned source of the static busybox embedded for the no-shell terminal and
# file browsing (backend/internal/docker/debugshell). The pins below are the
# only place its version lives.
#
#   scripts/fetch-busybox.sh             refresh the embedded binaries (gzip)
#   scripts/fetch-busybox.sh --source D  download the corresponding source
#                                        (GPL-2.0) into D, verified; the release
#                                        workflow attaches it to every release
#
# To upgrade: bump the pins, run without arguments, update the versions and
# hashes in backend/internal/docker/debugshell/busybox-NOTICE.md, commit.
set -eu

ALPINE=v3.24
VERSION=1.37.0-r31
UPSTREAM=1.37.0
# aports commit Alpine built $VERSION from (the apk's .PKGINFO "commit").
APORTS=c3ef5d10e6ef6528852c51f0564963e2f8c1be19
UPSTREAM_SHA512=ad8fd06f082699774f990a53d7a73b189ed404fe0a2166aff13eae4d9d8ee5c9239493befe949c98801fe7897520dbff3ed0224faa7205854ce4fa975e18467e

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sha512() { if command -v sha512sum >/dev/null; then sha512sum "$1"; else shasum -a 512 "$1"; fi | cut -d' ' -f1; }

if [ "${1:-}" = --source ]; then
	out=${2:?usage: $0 --source DIR}
	mkdir -p "$out"
	curl -fsSL "https://busybox.net/downloads/busybox-$UPSTREAM.tar.bz2" -o "$out/busybox-$UPSTREAM.tar.bz2"
	[ "$(sha512 "$out/busybox-$UPSTREAM.tar.bz2")" = "$UPSTREAM_SHA512" ] || { echo "busybox-$UPSTREAM.tar.bz2: checksum mismatch" >&2; exit 1; }
	# Alpine's build recipe: APKBUILD, patches and configs at that commit.
	curl -fsSL "https://gitlab.alpinelinux.org/alpine/aports/-/archive/$APORTS/aports-$APORTS.tar.gz?path=main/busybox" \
		-o "$out/busybox-$VERSION-alpine-aports.tar.gz"
	tar -tzf "$out/busybox-$VERSION-alpine-aports.tar.gz" | grep -q '/main/busybox/APKBUILD$'
	ls -l "$out"/busybox-*
	exit 0
fi

OUT=$(cd "$(dirname "$0")/.." && pwd)/backend/internal/docker/debugshell
# Go arch (what the daemon's /version reports) : Alpine arch. armhf (armv6)
# also runs on armv7, which reports "arm" too.
for pair in amd64:x86_64 arm64:aarch64 arm:armhf 386:x86; do
	goarch=${pair%%:*} apkarch=${pair#*:}
	curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/$ALPINE/main/$apkarch/busybox-static-$VERSION.apk" -o "$TMP/$goarch.apk"
	# The notice names this commit as the source: refuse a binary built elsewhere.
	tar -xzOf "$TMP/$goarch.apk" .PKGINFO 2>/dev/null | grep -qx "commit = $APORTS" || { echo "$apkarch: not built from aports $APORTS" >&2; exit 1; }
	mkdir "$TMP/$goarch"
	tar -xzf "$TMP/$goarch.apk" -C "$TMP/$goarch" bin/busybox.static 2>/dev/null
	printf '%s  busybox (%s)\n' "$(shasum -a 256 "$TMP/$goarch/bin/busybox.static" | cut -d' ' -f1)" "$goarch"
	# Embedded compressed (-n: no name/time, so the output is reproducible).
	gzip -9n <"$TMP/$goarch/bin/busybox.static" >"$OUT/busybox-$goarch.gz"
done
