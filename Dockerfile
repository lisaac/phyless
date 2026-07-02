FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o infra-manager ./cmd/server/

FROM alpine:latest
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY --from=builder /app/infra-manager .
COPY web/dist ./web/dist
VOLUME /data
EXPOSE 8080
CMD ["./infra-manager"]
