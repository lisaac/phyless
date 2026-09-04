FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o infra-manager ./cmd/server/

FROM alpine:latest
# Compose is embedded through the Go API; the runtime image intentionally has
# no docker/compose CLI or buildx executable. Keep root certificates for
# registry HTTPS requests made by the in-process pull backend.
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/infra-manager .
COPY web/dist ./web/dist
VOLUME /data
EXPOSE 8080
ENV COMPOSE_BAKE=false
CMD ["./infra-manager"]
