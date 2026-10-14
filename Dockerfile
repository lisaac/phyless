FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
ARG GIT_COMMIT=unknown
RUN GIT_COMMIT="$GIT_COMMIT" npm run build

# Cross-compile on the build host; only the final stage runs as the target arch.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /frontend/dist ./backend/web/dist
ARG TARGETOS TARGETARCH TARGETVARIANT
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} CGO_ENABLED=0 \
    ./scripts/go-build.sh -o phyless ./backend/cmd/server/ \
 && mkdir -m 1777 /rootfs-tmp

# No shell, no package manager: the static binary is the whole runtime.
# Compose is embedded through the Go API (no docker/compose CLI or buildx);
# root CAs are compiled in (x509roots/fallback). /tmp is needed by
# os.CreateTemp (imagefs indexes, uploads).
FROM scratch
COPY --from=builder /rootfs-tmp /tmp
WORKDIR /app
COPY --from=builder /app/phyless .
VOLUME /data
EXPOSE 8080
ENV COMPOSE_BAKE=false
CMD ["./phyless", "-C", "/data"]
