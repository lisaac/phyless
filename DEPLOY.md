# Running phyless

The repository ships one Docker Compose service. Runtime state is kept in the
repository's `data/` directory and mounted at `/data` in the container.

## Start

Build and start the service:

```bash
docker compose -f compose.yaml up -d --build
```

The web UI is available at `http://localhost:8080`. On first visit, set the
initial `admin` password; the service persists its generated JWT secret and the
password hash under `data/`. The Docker socket is mounted so the service can
manage the local Docker daemon.

## Stop and update

```bash
docker compose -f compose.yaml down
docker compose -f compose.yaml up -d --build
```

Do not commit `data/`: it contains the JWT secret, user configuration, and audit
log. The directory is ignored by both Git and the Docker build context.
