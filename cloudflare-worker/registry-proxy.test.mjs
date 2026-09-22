import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowlist,
  normalizeOrigin,
  isAllowedHost,
  resolveAllowedOrigin,
  validateOriginPolicy,
} from './registry-proxy.js';
import worker from './registry-proxy.js';

test('parseAllowlist trims, lowercases, drops empties', () => {
  assert.deepEqual(parseAllowlist(' A , b.com ,, C '), ['a', 'b.com', 'c']);
  assert.deepEqual(parseAllowlist(''), []);
});

test('isAllowedHost matches exact and *.suffix', () => {
  assert.equal(isAllowedHost('registry-1.docker.io', ['*.docker.io']), true);
  assert.equal(isAllowedHost('ghcr.io', ['ghcr.io']), true);
  assert.equal(isAllowedHost('evil.com', ['ghcr.io']), false);
  assert.equal(isAllowedHost('anything', []), false); // default deny
});

test('normalizeOrigin canonicalizes', () => {
  assert.equal(normalizeOrigin('https://A.com'), 'https://a.com');
  assert.equal(normalizeOrigin('not a url'), '');
  assert.equal(normalizeOrigin(''), '');
});

test('resolveAllowedOrigin reflects only allowed origins', () => {
  assert.equal(resolveAllowedOrigin({ originAllowlist: ['https://a'] }, 'https://a'), 'https://a');
  assert.equal(resolveAllowedOrigin({ originAllowlist: ['https://a'] }, 'https://b'), '');
  assert.equal(resolveAllowedOrigin({ originAllowlist: [] }, 'https://x'), 'https://x'); // open reflects
});

test('validateOriginPolicy default-denies missing origin', () => {
  assert.notEqual(validateOriginPolicy({ originAllowlist: [], allowMissingOrigin: false }, ''), '');
  assert.equal(validateOriginPolicy({ originAllowlist: [], allowMissingOrigin: true }, ''), '');
  assert.equal(validateOriginPolicy({ originAllowlist: ['https://a'] }, 'https://a'), '');
  assert.notEqual(validateOriginPolicy({ originAllowlist: ['https://a'] }, 'https://b'), '');
});

test('forwards and exposes Retry-After from a rate-limited registry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } });
  try {
    const response = await worker.fetch(
      new Request('https://worker.example/?url=https%3A%2F%2Fregistry.example%2Fv2%2F', { headers: { Origin: 'https://app.example' } }),
      { UPSTREAM_ALLOWLIST: 'registry.example' },
    );
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.match(response.headers.get('Access-Control-Expose-Headers') || '', /Retry-After/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates every redirect and strips credentials across origins', async () => {
  const original = globalThis.fetch;
  const req = new Request('https://worker.example/?url=https://registry.example/v2/', {
    headers: { Origin: 'https://app.example', Authorization: 'Bearer private' },
  });
  try {
    for (const allowed of [false, true]) {
      const calls = [];
      let cancelled = false;
      globalThis.fetch = async (url, opts) => {
        calls.push({ url, auth: opts.headers.get('authorization'), redirect: opts.redirect });
        return calls.length === 1
          ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { Location: 'https://cdn.example/blob' } })
          : new Response('layer');
      };
      const response = await worker.fetch(req, { UPSTREAM_ALLOWLIST: allowed ? 'registry.example,cdn.example' : 'registry.example' });
      assert.equal(response.status, allowed ? 200 : 403);
      assert.equal(cancelled, true);
      assert.equal(calls.length, allowed ? 2 : 1);
      assert.equal(calls[0].redirect, 'manual');
      assert.equal(calls[0].auth, 'Bearer private');
      if (allowed) assert.equal(calls[1].auth, null);
    }
  } finally { globalThis.fetch = original; }
});

test('bounds redirect loops and refuses HTTPS downgrades', async () => {
  const original = globalThis.fetch;
  try {
    for (const location of ['/again', 'http://registry.example/blob']) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(null, { status: 307, headers: { Location: location } }); };
      const response = await worker.fetch(new Request('https://worker.example/?url=https://registry.example/v2/', {
        headers: { Origin: 'https://app.example' },
      }), { UPSTREAM_ALLOWLIST: 'registry.example' });
      assert.equal(response.status, 502);
      assert.equal(calls, location === '/again' ? 6 : 1);
    }
  } finally { globalThis.fetch = original; }
});
