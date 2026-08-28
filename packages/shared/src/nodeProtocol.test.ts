import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_NODE_PROTOCOL_RANGE,
  LEGACY_NODE_PROTOCOL_RANGE,
  describeNodeProtocolCompatibility,
  negotiateNodeProtocol,
  normalizeNodeProtocolRange,
  resolveAdvertisedNodeProtocol,
} from './nodeProtocol';

test('Node protocol ranges are strict bounded plain data', () => {
  assert.deepEqual(normalizeNodeProtocolRange({ min: 2, max: 4 }), { min: 2, max: 4 });
  for (const value of [null, [], { min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1.5, max: 2 }, { min: 1, max: 2, extra: true }]) {
    assert.throws(() => normalizeNodeProtocolRange(value));
  }
});

test('missing protocol is explicit legacy generation one', () => {
  assert.deepEqual(resolveAdvertisedNodeProtocol(undefined), { range: LEGACY_NODE_PROTOCOL_RANGE, legacy: true });
  assert.deepEqual(resolveAdvertisedNodeProtocol({ min: 2, max: 2 }), { range: CURRENT_NODE_PROTOCOL_RANGE, legacy: false });
});

test('protocol negotiation chooses the newest intersection and rejects disjoint ranges', () => {
  assert.deepEqual(negotiateNodeProtocol({ min: 2, max: 4 }, { min: 3, max: 5 }), {
    status: 'compatible', client: { min: 2, max: 4 }, master: { min: 3, max: 5 }, legacyClient: false, negotiated: 4,
  });
  const incompatible = negotiateNodeProtocol(LEGACY_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE, true);
  assert.equal(incompatible.status, 'upgrade-required');
  assert.match(describeNodeProtocolCompatibility(incompatible), /legacy\/1.*Master requires 2-2.*Update and restart/i);
});