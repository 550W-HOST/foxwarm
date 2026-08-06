import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProcessRpcClientTransport, RpcClient } from './rpc';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { sessionWorkerControlServiceDescriptor } from './sessionWorkerControlService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { SessionWorkerStore } from './sessionWorkerStore';
import type { Session } from './types';

function baseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    contextFrontier: [],
    persistentMemorySnapshot: 'worker prompt',
    systemPromptFiles: [],
    snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: 0 },
    lastAppliedMailboxId: 0,
  } as Session;
}

function assertRpcCode(code: string) {
  return (error: any) => error?.code === code;
}

test('real activated child runs durable mailbox through canonical SessionTurnRunner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-host-'));
  const sessionId = 'worker-host-real-child';
  const dbPath = path.join(root, 'session-runtime.sqlite');
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  const store = new SessionWorkerStore(dbPath); store.open();
  const incarnationId = 'runtime-test-incarnation';
  const ownership = store.beginGeneration(sessionId, incarnationId);
  const child = fork(path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'), [], {
    env: {
      ...process.env,
      FOXWARM_DATA_DIR: root,
      FOXWARM_SESSION_WORKER_SESSION_ID: sessionId,
      FOXWARM_SESSION_WORKER_GENERATION: String(ownership.generation),
      FOXWARM_SESSION_WORKER_INCARNATION_ID: incarnationId,
      FOXWARM_SESSION_WORKER_STORE_PATH: dbPath,
      FOXWARM_TEST_FAIL_WRITE_AT: '2',
    },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, { generation: ownership.generation });
  try {
    await transport.waitUntilReady();
    const control = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
    const runtime = new RpcClient(sessionWorkerRuntimeServiceDescriptor, transport);
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), assertRpcCode('SESSION_WORKER_NOT_ACTIVATED'));
    const processIdentity = readSessionWorkerProcessIdentity(child.pid!);
    assert.ok(processIdentity);
    store.registerCandidate(sessionId, ownership.generation, incarnationId, child.pid!, processIdentity!);
    store.activateCandidate(sessionId, ownership.generation, incarnationId, child.pid!, processIdentity!);
    await control.call('activate', {});
    await assert.rejects(() => runtime.call('runPending', { limit: 0 }), assertRpcCode('SESSION_WORKER_MAILBOX_LIMIT'));

    const intent = store.enqueueIntent(sessionId, 'first-input', 'enqueue', {
      type: 'user',
      source: { platform: 'test', channelUserId: 'conversation', preferDirectReply: true },
      parts: [{ text: 'child input' }],
    });
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), /test write failure 2/);
    assert.equal(store.getOwnership(sessionId).mailboxCursor, intent.id);
    const afterFailedClaim = await fs.readJson(statePath);
    assert.equal(afterFailedClaim.lastAppliedMailboxId, intent.id);
    assert.equal(afterFailedClaim.queue.length, 1);
    assert.equal(afterFailedClaim.busy, false);
    assert.equal(afterFailedClaim.history.length, 0);

    const projection = await runtime.call('runPending', { limit: 8 });
    assert.equal(projection.lastAppliedMailboxId, intent.id);
    assert.equal(projection.busy, false);
    assert.equal(projection.queueLength, 0);
    assert.equal(projection.messageCount, 2);
    const durable = await fs.readJson(statePath);
    assert.deepEqual(durable.history.map((message: any) => message.role), ['user', 'model']);
    assert.equal(durable.contextFrontier.length, 2);
    assert.equal(durable.queue.length, 0);
    assert.equal(durable.busy, false);
    const archive = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true });
    try {
      const rows = archive.prepare('SELECT role FROM archive_messages WHERE session_id=? ORDER BY seq').all(sessionId) as Array<{ role: string }>;
      assert.deepEqual(rows.map(row => row.role), ['user', 'model']);
    } finally { archive.close(); }

    projection.stats.totalInputTokens = 999;
    const clonedProjection = await runtime.call('runPending', { limit: 8 });
    assert.notEqual(clonedProjection.stats.totalInputTokens, 999);

    const cursorBeforeInvalid = store.getOwnership(sessionId).mailboxCursor;
    store.enqueueIntent(sessionId, 'invalid-item', 'enqueue', { type: 'obsolete-kind', parts: [{ text: 'bad' }] });
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), assertRpcCode('SESSION_WORKER_INVALID_QUEUE_ITEM'));
    assert.equal(store.getOwnership(sessionId).mailboxCursor, cursorBeforeInvalid);
    assert.equal((await fs.readJson(statePath)).lastAppliedMailboxId, cursorBeforeInvalid);
    const accessor: Record<string, unknown> = { type: 'user' };
    Object.defineProperty(accessor, 'parts', { enumerable: true, get() { throw new Error('accessor ran'); } });
    assert.throws(() => store.enqueueIntent(sessionId, 'accessor', 'enqueue', accessor), /enumerable data properties/);
  } finally {
    try { await transport.drain(2_000); } catch {}
    transport.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    store.close();
    await fs.remove(root);
  }
});
