FROM node:20-alpine AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
ARG GIT_COMMIT=unknown
RUN GIT_COMMIT="$GIT_COMMIT" npm run build

FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /frontend/dist ./backend/web/dist
RUN CGO_ENABLED=0 ./scripts/go-build.sh -o phyless ./backend/cmd/server/ \
    && mkdir -p /runtime/tmp \
    && touch /runtime/tmp/.keep

FROM alpine:latest AS certs
RUN apk add --no-cache ca-certificates

FROM scratch
# Compose is embedded through the Go API; the runtime image intentionally has
# no docker/compose CLI or buildx executable. Keep root certificates for
# registry HTTPS requests made by the in-process pull backend.
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /app/phyless .
COPY --from=builder /runtime/tmp/ /tmp/
VOLUME /data
EXPOSE 8080
ENV COMPOSE_BAKE=false
CMD ["/app/phyless", "-C", "/data"]
