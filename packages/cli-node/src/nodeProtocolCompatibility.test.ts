import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeClient } from './client';

function makeClient() {
  const statuses: Array<{ status: string; detail: any }> = [];
  const client = new NodeClient({
    host: 'http://master.invalid',
    nodeId: 'node-a',
    authToken: 'token',
    localTrigger: false,
    onStatus: (status, detail) => statuses.push({ status, detail }),
  });
  const closes: any[] = [];
  (client as any).ws = { close: (...args: any[]) => closes.push(args) };
  return { client, statuses, closes };
}

test('current client accepts an unversioned legacy Master registered response as protocol v1', async () => {
  const { client, statuses, closes } = makeClient();
  await (client as any).handleMessage({ type: 'registered', nodeId: 'node-a' });
  assert.equal((client as any).protocolIncompatible, false);
  assert.equal(statuses[0]?.status, 'registered');
  assert.equal(closes.length, 0);
  assert.equal((client as any).execRecoveryStarted, true);
});

test('current client remains connected but quarantined after Master incompatibility response', async () => {
  const { client, statuses, closes } = makeClient();
  await (client as any).handleMessage({
    type: 'node_incompatible',
    code: 'NODE_PROTOCOL_INCOMPATIBLE',
    nodeId: 'node-a',
    clientProtocol: { min: 1, max: 2 },
    masterProtocol: { min: 3, max: 3 },
    message: 'upgrade required',
  });
  assert.equal((client as any).protocolIncompatible, true);
  assert.equal(statuses[0]?.status, 'protocol_incompatible');
  assert.equal(closes.length, 0);
});

test('current client rejects an invalid negotiated generation from Master', async () => {
  const { client, statuses, closes } = makeClient();
  await (client as any).handleMessage({
    type: 'registered', nodeId: 'node-a',
    nodeProtocol: { master: { min: 2, max: 3 }, negotiated: 3 },
  });
  assert.equal((client as any).protocolIncompatible, true);
  assert.match(statuses[0]?.detail?.message || '', /invalid Node protocol selection 3; expected 2/);
  assert.equal(closes[0]?.[0], 1008);
});