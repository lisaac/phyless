FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o infra-manager ./cmd/server/

FROM node:20-alpine AS frontend
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM alpine:latest
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY --from=builder /app/infra-manager .
COPY --from=frontend /web/dist ./web/dist
VOLUME /data
EXPOSE 8080
CMD ["./infra-manager"]
