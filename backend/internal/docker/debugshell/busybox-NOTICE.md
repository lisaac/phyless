# BusyBox

phyless embeds four statically linked BusyBox executables, gzip-compressed, in
this directory (`busybox-<arch>.gz`). They run only inside helper containers
that phyless creates for its no-shell terminal and file browsing; phyless never
links against BusyBox, and BusyBox is a separate program distributed alongside
it.

BusyBox is licensed under the **GNU General Public License, version 2 only**
(`GPL-2.0-only`); the full text is in [busybox-COPYING](busybox-COPYING). This
does not change the license of phyless itself (MIT, see `LICENSE`). A copy of
the license is also placed at `/usr/share/licenses/busybox/COPYING` inside the
`phyless-debug` image that phyless imports on a Docker host.

## Origin

| | |
|---|---|
| Package | Alpine Linux `busybox-static` 1.37.0-r31 (Alpine v3.24, `main`) |
| Upstream | BusyBox 1.37.0, <https://busybox.net/> |
| Alpine build recipe | aports commit `c3ef5d10e6ef6528852c51f0564963e2f8c1be19`, `main/busybox` (APKBUILD, patches, configs) |

| File | Alpine arch | sha256 of the decompressed binary |
|---|---|---|
| `busybox-amd64.gz` | x86_64 | `1690ed6db71fa35621537580135deb8de4f55f30a50d9d591050256e334cd8b9` |
| `busybox-arm64.gz` | aarch64 | `999cb969d09093a71716cfc747bb53cdada3f332c05eb5046c56e0f66a4d6d22` |
| `busybox-arm.gz` | armhf (armv6, also runs on armv7) | `6bcc190c3b9f1bb7d4b7a46f4a6efaf8473b99ceb4abe242e6f866d6f9bf0491` |
| `busybox-386.gz` | x86 | `1e0970061bd61fc734cdbf201ea65fefde853924dd89d3d0b51d65639120ba2c` |

Decompressed, they are the unmodified `bin/busybox.static` from those packages.
`scripts/fetch-busybox.sh` downloads them and refuses a package whose
`.PKGINFO` names any other aports commit.

## Corresponding source

Every phyless release on GitHub includes, next to the binaries:

- `busybox-1.37.0.tar.bz2`: the upstream source (sha512
  `ad8fd06f082699774f990a53d7a73b189ed404fe0a2166aff13eae4d9d8ee5c9239493befe949c98801fe7897520dbff3ed0224faa7205854ce4fa975e18467e`);
- `busybox-1.37.0-r31-alpine-aports.tar.gz`: Alpine's build recipe at the
  commit above — the patches and configuration the binaries were built with.

`scripts/fetch-busybox.sh --source <dir>` fetches and verifies the same files.
