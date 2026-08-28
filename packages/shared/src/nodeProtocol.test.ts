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
  assert.deepEqual(resolveAdvertisedNodeProtocol({ min: 1, max: 2 }), { range: CURRENT_NODE_PROTOCOL_RANGE, legacy: false });
});

test('protocol negotiation covers rolling current and legacy combinations while rejecting disjoint ranges', () => {
  assert.equal(negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE).negotiated, 2);
  assert.deepEqual(negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE, LEGACY_NODE_PROTOCOL_RANGE), {
    status: 'compatible', client: CURRENT_NODE_PROTOCOL_RANGE, master: LEGACY_NODE_PROTOCOL_RANGE, legacyClient: false, negotiated: 1,
  });
  assert.deepEqual(negotiateNodeProtocol(LEGACY_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE, true), {
    status: 'compatible', client: LEGACY_NODE_PROTOCOL_RANGE, master: CURRENT_NODE_PROTOCOL_RANGE, legacyClient: true, negotiated: 1,
  });
  assert.deepEqual(negotiateNodeProtocol({ min: 2, max: 4 }, { min: 3, max: 5 }), {
    status: 'compatible', client: { min: 2, max: 4 }, master: { min: 3, max: 5 }, legacyClient: false, negotiated: 4,
  });
  const incompatible = negotiateNodeProtocol({ min: 3, max: 3 }, CURRENT_NODE_PROTOCOL_RANGE);
  assert.equal(incompatible.status, 'upgrade-required');
  assert.match(describeNodeProtocolCompatibility(incompatible), /client 3-3.*Master requires 1-2.*Update and restart/i);
});
