import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { NodeClient } from './client';
import { setNodeToolSessionEventDispatcher } from '../../shared/dist/nodeTools';

async function clientWithResponder(responder: (request: any) => any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-session-event-ack-'));
  const client = new NodeClient({
    host: 'http://master.invalid',
    nodeId: 'remote-a',
    authToken: 'test-auth',
    credentialsFile: path.join(root, 'credentials.json'),
    localTrigger: false,
  });
  const sent: any[] = [];
  (client as any).ws = {
    readyState: 1,
    send(raw: string) {
      const request = JSON.parse(raw);
      sent.push(request);
      queueMicrotask(() => { void (client as any).handleMessage(responder(request)); });
    },
  };
  return { client, sent, root };
}

test('remote session event resolves only after master acceptance ACK', async () => {
  const { client, sent, root } = await clientWithResponder(request => ({
    type: 'session_event_accepted',
    requestId: request.requestId,
  }));
  try {
    await client.sendSessionEvent('session-a', 'done', 'background', {
      eventId: 'remote-exec-completion:exec_12345678',
      execId: 'exec_12345678',
      completionCapability: 'capability',
      eventTimestamp: 123456789,
    });
    assert.equal(sent.length, 1);
    assert.equal(typeof sent[0].requestId, 'string');
    assert.equal(sent[0].execId, 'exec_12345678');
    assert.equal(sent[0].completionCapability, 'capability');
    assert.equal(sent[0].eventTimestamp, 123456789);
  } finally {
    setNodeToolSessionEventDispatcher(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote session event rejects when master rejects it', async () => {
  const { client, root } = await clientWithResponder(request => ({
    type: 'error',
    requestId: request.requestId,
    error: 'completion rejected',
  }));
  try {
    await assert.rejects(
      () => client.sendSessionEvent('session-a', 'done', 'background'),
      /completion rejected/,
    );
  } finally {
    setNodeToolSessionEventDispatcher(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote session event rejects immediately when the connection closes before ACK', async () => {
  const { client, root } = await clientWithResponder(() => ({ type: 'unrelated' }));
  try {
    const delivery = client.sendSessionEvent('session-a', 'done', 'background');
    await new Promise(resolve => setImmediate(resolve));
    (client as any).rejectPendingRequests(new Error('socket closed'));
    await assert.rejects(delivery, /socket closed/);
  } finally {
    setNodeToolSessionEventDispatcher(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
