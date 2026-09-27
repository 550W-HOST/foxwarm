import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMasterNodeProtocol } from '../background/nodeProtocol.js';

test('browser Node accepts valid explicit and omitted legacy Master protocol responses', () => {
  assert.deepEqual(resolveMasterNodeProtocol({ master: { min: 1, max: 2 }, negotiated: 2 }), {
    master: { min: 1, max: 2 }, negotiated: 2, legacy: false,
  });
  assert.deepEqual(resolveMasterNodeProtocol({ master: { min: 1, max: 1 }, negotiated: 1 }), {
    master: { min: 1, max: 1 }, negotiated: 1, legacy: false,
  });
  assert.deepEqual(resolveMasterNodeProtocol(undefined), {
    master: { min: 1, max: 1 }, negotiated: 1, legacy: true,
  });
});

test('browser Node rejects malformed present Master protocol responses', () => {
  for (const value of [
    null,
    {},
    { master: { min: 1, max: 2 } },
    { master: { min: 1, max: 2 }, negotiated: 2, extra: true },
    { master: { min: 1, max: 2, extra: true }, negotiated: 2 },
    { master: { min: 1, max: 1_000_001 }, negotiated: 2 },
    { master: { min: 1, max: 2 }, negotiated: 1 },
    { master: { min: 3, max: 3 }, negotiated: 3 },
    { master: { min: true, max: 2 }, negotiated: 2 },
    { master: { min: 1, max: 2 }, negotiated: true },
  ]) {
    assert.throws(() => resolveMasterNodeProtocol(value));
  }
});
