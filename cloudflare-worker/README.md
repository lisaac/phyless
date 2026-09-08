# phyless registry CORS proxy (Cloudflare Worker)

A narrow `?url=` pass-through that lets the phyless web UI pull container images
**from the browser** when the phyless server and Docker daemon cannot reach the
registry themselves. It adds CORS, forwards the headers the OCI pull needs, and
streams the upstream body back unbuffered. It never stores anything.

Only `GET`, `HEAD`, `OPTIONS`. Both allowlists **default-deny**.

## Deploy

```bash
npm i -g wrangler        # or: npx wrangler
wrangler deploy registry-proxy.js --name phyless-registry-proxy --compatibility-date 2024-11-01
```

Then set the deployed URL as the "worker URL" in the phyless pull dialog
(browser download mode).

## Environment variables

| Var | Meaning | Example |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated request Origins allowed to use the proxy. Empty = reflect any Origin (still requires an Origin unless `ALLOW_MISSING_ORIGIN`). | `https://phyless.example,http://docker.example.test:8080` |
| `UPSTREAM_ALLOWLIST` | Comma-separated registry hosts. `*.suffix` matches subdomains. `*` = any upstream. | `registry-1.docker.io,auth.docker.io,*.docker.io,ghcr.io,*.githubusercontent.com,production.cloudflare.docker.com` |
| `ALLOW_ANY_UPSTREAMS` | `true` to skip the upstream allowlist. Prefer a real allowlist. | `false` |
| `ALLOW_MISSING_ORIGIN` | `true` to accept requests without an Origin header (e.g. curl). Off by default. | `false` |

Set via `wrangler secret put` / `wrangler deploy --var`, or the dashboard.

## Typical Docker Hub allowlist

```
registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,*.docker.io
```

GHCR:

```
ghcr.io,*.githubusercontent.com,pkg-containers.githubusercontent.com
```

## Security notes

- The proxy forwards `Authorization` to the upstream you point it at, so keep
  `UPSTREAM_ALLOWLIST` tight — never leave `ALLOW_ANY_UPSTREAMS=true` in
  production, or the Worker becomes an open credential-forwarding proxy.
- Private-registry credentials transit the browser → this Worker → registry at
  request time only. They are never sent to the phyless server.
