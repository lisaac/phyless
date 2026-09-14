FROM node:20-alpine AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
COPY .git/HEAD /tmp/git/HEAD
COPY .git/refs/heads /tmp/git/refs/heads
ARG GIT_COMMIT
RUN ref="$(sed -n 's/^ref: //p' /tmp/git/HEAD)"; \
    GIT_COMMIT="${GIT_COMMIT:-$(if [ -n "$ref" ]; then cat "/tmp/git/$ref"; else cat /tmp/git/HEAD; fi)}" npm run build

FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /frontend/dist ./backend/web/dist
RUN ./scripts/go-build.sh -o phyless ./backend/cmd/server/

FROM alpine:latest
# Compose is embedded through the Go API; the runtime image intentionally has
# no docker/compose CLI or buildx executable. Keep root certificates for
# registry HTTPS requests made by the in-process pull backend.
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/phyless .
VOLUME /data
EXPOSE 8080
ENV COMPOSE_BAKE=false
CMD ["./phyless", "-C", "/data"]
