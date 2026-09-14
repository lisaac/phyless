# Running phyless

The repository ships one Docker Compose service. Runtime state is kept in the
repository's `data/` directory and mounted at `/data` in the container.

## Start

Set the initial credentials, then build and start the service:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export ADMIN_PASSWORD='choose-a-strong-password'
docker compose -f compose.yaml up -d --build
```

The web UI is available at `http://localhost:8080`. The Docker socket is mounted
so the service can manage the local Docker daemon.

## Stop and update

```bash
docker compose -f compose.yaml down
docker compose -f compose.yaml up -d --build
```

Do not commit `data/`: it contains the JWT secret, user configuration, and audit
log. The directory is ignored by both Git and the Docker build context.
