FROM node:20-alpine AS frontend
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ .
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
COPY --from=frontend /web/dist ./web/dist
RUN ./scripts/go-build.sh -o infra-manager ./cmd/server/

FROM alpine:latest
# Compose is embedded through the Go API; the runtime image intentionally has
# no docker/compose CLI or buildx executable. Keep root certificates for
# registry HTTPS requests made by the in-process pull backend.
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/infra-manager .
VOLUME /data
EXPOSE 8080
ENV COMPOSE_BAKE=false
CMD ["./infra-manager"]
