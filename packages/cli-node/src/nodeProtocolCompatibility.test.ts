import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeClient } from './client';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

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
    nodeProtocol: { master: { min: 2, max: 3 }, negotiated: 2 },
  });
  assert.equal((client as any).protocolIncompatible, true);
  assert.match(statuses[0]?.detail?.message || '', /invalid Node protocol selection 2; expected 3/);
  assert.equal(closes[0]?.[0], 1008);
});

test('a Session-only tool interceptor does not advertise external execution it cannot approve', () => {
  const client = new NodeClient({ host: 'http://master.invalid', nodeId: 'node-a', authToken: 'token',
    localTrigger: false, toolCallInterceptor: async () => true });
  assert.equal((client as any).getNodeCapabilities().features.externalToolOwner, undefined);
  const standalone = makeClient();
  assert.equal((standalone.client as any).getNodeCapabilities().features.externalToolOwner, 1);
});
test('current CLI advertises and forwards the trusted programmatic hint to actual file producers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-cli-script-data-'));
  const file = path.join(root, 'data.txt');
  const { client } = makeClient();
  const responses: any[] = [];
  (client as any).send = (message: any) => responses.push(message);
  try {
    await fs.writeFile(file, '{"v":1}\r\n');
    assert.equal((client as any).getNodeCapabilities().features.programmaticToolData, true);
    const message = { type: 'tool_call', callId: 'direct', tool: 'read', args: { filePath: file, programmatic: true }, sessionId: 'source', agentName: 'main' };
    await (client as any).handleToolCall(message);
    assert.equal(responses[0].type, 'tool_call_response'); assert.equal(responses[0].result.content, undefined);
    await (client as any).handleToolCall({ ...message, callId: 'script', programmatic: true });
    assert.equal(responses[1].type, 'tool_call_response'); assert.equal(responses[1].result.content, '{"v":1}\r\n');
    assert.equal(responses[1].result.output, responses[0].result.output); assert.equal(responses[1].result.truncated, false);
    assert.equal(responses[1].result.filePath, file);
  } finally { await fs.remove(root); }
});
