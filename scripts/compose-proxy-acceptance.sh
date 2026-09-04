#!/bin/sh
set -eu

target=${PHYLESS_ACCEPTANCE_SSH_TARGET:-user@docker.example.test}
key=${PHYLESS_ACCEPTANCE_SSH_KEY:-~/.ssh/id_ed25519}
binary=${1:-${PHYLESS_ACCEPTANCE_BINARY:-}}

ssh_readonly() {
	ssh -o BatchMode=yes -o ConnectTimeout=10 -i "$key" "$target" "$@"
}

if [ "${PHYLESS_ACCEPTANCE_RUN:-0}" != "1" ]; then
	echo "PHYLESS_ACCEPTANCE_RUN is unset; running read-only Docker baseline only" >&2
	ssh_readonly 'set -eu
echo "== docker version =="
docker version --format "server={{.Server.Version}} api={{.Server.APIVersion}} os={{.Server.Os}} arch={{.Server.Arch}}"
echo "== docker info =="
docker info --format "name={{.Name}} os={{.OperatingSystem}} arch={{.Architecture}} driver={{.Driver}} mem={{.MemTotal}} ncpu={{.NCPU}}"
echo "== protected containers =="
docker inspect -f "{{.Name}} image={{.Config.Image}} id={{.Id}} status={{.State.Status}}" protected-container phyless-app
echo "== protected image =="
docker image inspect -f "{{.Id}} {{.RepoTags}}" phyless:latest
echo "== images =="
docker image ls --format "{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}"
echo "== system df =="
docker system df --format "type={{.Type}} total={{.TotalCount}} active={{.Active}} size={{.Size}} reclaimable={{.Reclaimable}}"'
	exit 0
fi

if [ -z "$binary" ] || [ ! -f "$binary" ]; then
	build_dir=$(mktemp -d "${TMPDIR:-/tmp}/phyless-acceptance.XXXXXX")
	binary="$build_dir/compose-acceptance.test"
	trap 'rm -rf "$build_dir"' EXIT INT TERM
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go test -c ./internal/docker/compose -o "$binary"
fi

test -f "$binary"
remote_binary=/tmp/phyless-acceptance-test.$$
project_name=phyless-acceptance-$(date +%s)-$$
cleanup() {
	ssh_readonly "rm -f -- '$remote_binary'" >/dev/null 2>&1 || true
	if [ -n "${build_dir:-}" ]; then
		rm -rf "$build_dir"
	fi
}
trap cleanup EXIT INT TERM

before_containers=$(ssh_readonly 'docker inspect -f "{{.Name}} image={{.Config.Image}} id={{.Id}} status={{.State.Status}}" protected-container phyless-app')
before_image=$(ssh_readonly 'docker image inspect -f "{{.Id}}" phyless:latest')
scp -q -o BatchMode=yes -o ConnectTimeout=10 -i "$key" "$binary" "$target:$remote_binary"

set +e
ssh_readonly "docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop=ALL --security-opt=no-new-privileges --memory=512m --pids-limit=256 -e PATH=/nonexistent -e HOME=/tmp -e DOCKER_HOST=unix:///var/run/docker.sock -e COMPOSE_BAKE=false -e PHYLESS_ACCEPTANCE=1 -e PHYLESS_ACCEPTANCE_PROJECT=$project_name -v /var/run/docker.sock:/var/run/docker.sock -v '$remote_binary:/usr/local/bin/compose-acceptance.test:ro' alpine:latest /usr/local/bin/compose-acceptance.test -test.v -test.run '^TestComposeAPI(Real|ProxyPull)Acceptance$'"
test_status=$?
set -e

after_containers=$(ssh_readonly 'docker inspect -f "{{.Name}} image={{.Config.Image}} id={{.Id}} status={{.State.Status}}" protected-container phyless-app')
after_image=$(ssh_readonly 'docker image inspect -f "{{.Id}}" phyless:latest')
if [ "$before_containers" != "$after_containers" ]; then
	echo "protected container state changed" >&2
	echo "before: $before_containers" >&2
	echo "after:  $after_containers" >&2
	test_status=1
fi
if [ "$before_image" != "$after_image" ]; then
	echo "protected phyless:latest image changed" >&2
	echo "before: $before_image" >&2
	echo "after:  $after_image" >&2
	test_status=1
fi
exit "$test_status"
