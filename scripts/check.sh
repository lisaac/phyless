#!/bin/sh
# Local quality gate; no deployment. Docker acceptance tests remain opt-in.
set -eu
cd "$(dirname "$0")/.."
go test -race ./...
go vet ./...
cd frontend
npm test -- --reporter=dot
npm run build
