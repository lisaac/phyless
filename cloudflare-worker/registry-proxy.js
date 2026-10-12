// Registry CORS proxy for phyless browser-side image pull.
//
// A browser cannot talk to a container registry directly: registries send no
// CORS headers and the OCI token dance needs cross-origin requests. This Worker
// is a narrow `?url=` pass-through that adds CORS, forwards the auth/range
// headers the pull needs, and streams the upstream body back unbuffered.
//
// GET/HEAD/OPTIONS, plus POST to exactly one URL: Docker Hub's token login,
// so search can run as the user instead of the Worker's shared-IP quota. Two
// allowlists (request Origin, upstream host) both default-deny. See README.md
// for the environment variables.

const ALLOWED_METHODS = 'GET,HEAD,POST,OPTIONS';
const POST_TARGET = 'https://hub.docker.com/v2/auth/token';
const MAX_POST_BODY = 4096;
const ALLOWED_HEADERS = 'Accept, Authorization, Cache-Control, Content-Type, Range';
const EXPOSED_HEADERS =
  'Accept-Ranges, Content-Encoding, Content-Length, Content-Range, Content-Type, Docker-Content-Digest, Retry-After, WWW-Authenticate';
// Only headers a registry pull legitimately needs; everything else is dropped.
const FORWARDED_HEADERS = ['accept', 'authorization', 'cache-control', 'content-type', 'if-modified-since', 'if-none-match', 'range'];

const configCache = new Map();

export default {
  async fetch(request, env) {
    const config = getConfig(env);
    const origin = normalizeOrigin(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      const err = validateOriginPolicy(config, origin);
      if (err) return jsonError(config, origin, 403, err);
      const headers = corsHeaders(config, origin);
      headers.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers });
    }

    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return jsonError(config, origin, 405, 'Only GET, HEAD, OPTIONS and the Docker Hub login POST are supported.');
    }

    const originErr = validateOriginPolicy(config, origin);
    if (originErr) return jsonError(config, origin, 403, originErr);

    const targetParam = new URL(request.url).searchParams.get('url');
    if (!targetParam) return jsonError(config, origin, 400, 'Missing required ?url= query parameter.');

    let target;
    try {
      target = new URL(targetParam);
    } catch {
      return jsonError(config, origin, 400, 'The target url must be an absolute URL.');
    }

    let body;
    if (request.method === 'POST') {
      if (target.href !== POST_TARGET) return jsonError(config, origin, 405, 'POST is only allowed to the Docker Hub login endpoint.');
      if (Number(request.headers.get('Content-Length')) > MAX_POST_BODY) return jsonError(config, origin, 413, 'Request body is too large.');
      body = await request.text();
      if (new TextEncoder().encode(body).length > MAX_POST_BODY) return jsonError(config, origin, 413, 'Request body is too large.');
    }

    const upstreamHeaders = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) upstreamHeaders.set(name, value);
    }

    let upstream;
    try {
      for (let redirects = 0; ; redirects++) {
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
          return jsonError(config, origin, 400, 'Target must be HTTP(S) without URL credentials.');
        }
        if (!config.allowAnyUpstream && !isAllowedHost(target.hostname, config.upstreamAllowlist)) {
          return jsonError(config, origin, 403, `Upstream host ${target.hostname} is not in UPSTREAM_ALLOWLIST.`);
        }
        upstream = await fetch(target.toString(), {
          method: request.method,
          headers: upstreamHeaders,
          body,
          redirect: 'manual',
          signal: request.signal,
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const location = upstream.headers.get('Location');
        if (![301, 302, 303, 307, 308].includes(upstream.status) || !location) break;
        if (body !== undefined) {
          await upstream.body?.cancel();
          return jsonError(config, origin, 502, 'Upstream redirect denied for POST.');
        }
        await upstream.body?.cancel();
        if (redirects >= 5) return jsonError(config, origin, 502, 'Too many upstream redirects.');
        const next = new URL(location, target);
        if (target.protocol === 'https:' && next.protocol !== 'https:') {
          return jsonError(config, origin, 502, 'Insecure upstream redirect denied.');
        }
        if (next.origin !== target.origin) upstreamHeaders.delete('authorization');
        target = next;
      }
    } catch {
      return jsonError(config, origin, 502, 'Upstream fetch failed.');
    }

    const headers = new Headers(upstream.headers);
    applyCors(headers, config, origin);
    headers.set('Cache-Control', 'no-store');
    headers.set('Vary', appendVary(headers.get('Vary'), 'Origin'));
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};

function getConfig(env) {
  const raw = [env.ALLOWED_ORIGINS, env.UPSTREAM_ALLOWLIST, env.ALLOW_ANY_UPSTREAMS, env.ALLOW_MISSING_ORIGIN].map(
    (v) => String(v || '')
  );
  const key = raw.join('\u0000');
  let config = configCache.get(key);
  if (config) return config;
  config = {
    originAllowlist: raw[0].split(',').map(normalizeOrigin).filter(Boolean),
    upstreamAllowlist: parseAllowlist(raw[1]),
    allowAnyUpstream: parseFlag(raw[2]) || raw[1].trim() === '*',
    allowMissingOrigin: parseFlag(raw[3]),
  };
  configCache.set(key, config);
  return config;
}

export function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return '';
  }
}

export function resolveAllowedOrigin(config, origin) {
  if (!config.originAllowlist.length) return origin || '';
  return config.originAllowlist.includes(origin) ? origin : '';
}

export function validateOriginPolicy(config, origin) {
  if (!origin) return config.allowMissingOrigin ? '' : 'This proxy only accepts browser requests from approved origins.';
  if (!config.originAllowlist.length) return '';
  return config.originAllowlist.includes(origin) ? '' : `Origin ${origin} is not allowed to use this proxy.`;
}

export function isAllowedHost(hostname, allowlist) {
  const host = String(hostname || '').toLowerCase();
  if (!allowlist.length) return false;
  return allowlist.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
}

function corsHeaders(config, origin) {
  const headers = new Headers();
  applyCors(headers, config, origin);
  return headers;
}

function applyCors(headers, config, origin) {
  const allowed = resolveAllowedOrigin(config, origin);
  if (allowed) headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
}

function appendVary(current, next) {
  const values = String(current || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.includes(next)) values.push(next);
  return values.join(', ');
}

function jsonError(config, origin, status, message) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  applyCors(headers, config, origin);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}
