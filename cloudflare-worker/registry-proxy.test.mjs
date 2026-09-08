import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowlist,
  normalizeOrigin,
  isAllowedHost,
  resolveAllowedOrigin,
  validateOriginPolicy,
} from './registry-proxy.js';

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
