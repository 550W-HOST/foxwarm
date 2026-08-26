import assert from 'node:assert/strict';
import test from 'node:test';
import { NodesManager } from './manager';
import * as sessionManager from '../sessionManager';
import { PERSISTENT_EXEC_ID_COLLISION_CODE } from '../../packages/shared/dist/persistentExec';

function installRemote(manager: NodesManager, nodeId: string, onCall: (message: any) => void): void {
  (manager as any).nodes.set(nodeId, {
    id: nodeId, type: 'test', tools: new Set(['exec']), lastActivity: Date.now(),
    ws: { send(payload: string) { onCall(JSON.parse(payload)); } },
  });
}

test('remote exec preallocation retries owner-acknowledged collisions before success', async () => {
  const ids = ['calm-otter', 'quiet-heron'];
  const manager = new NodesManager({ generateExecId: () => ids.shift()! });
  const sessionId = `remote-retry-${Date.now()}`;
  await sessionManager.getSession(sessionId);
  const seen: string[] = [];
  installRemote(manager, 'remote-retry', message => {
    seen.push(message.backgroundExecId);
    queueMicrotask(() => {
      if (seen.length === 1) manager.handleToolError(message.callId, { code: PERSISTENT_EXEC_ID_COLLISION_CODE, message: 'collision' });
      else manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` });
    });
  });
  try {
    const result = await manager.executeTool('remote-retry', 'exec', { command: 'sleep 1' }, sessionId);
    assert.deepEqual(seen, ['calm-otter', 'quiet-heron']);
    assert.match(JSON.stringify(result), /quiet-heron/);
  } finally { await sessionManager.deleteSession(sessionId).catch(() => false); }
});

test('remote exec collision retry exhaustion fails closed without a hidden ID', async () => {
  const ids = ['quiet-otter', 'calm-heron', 'swift-raven'];
  const manager = new NodesManager({ generateExecId: () => ids.shift()!, remoteExecCollisionAttempts: 3 });
  const sessionId = `remote-exhaust-${Date.now()}`;
  await sessionManager.getSession(sessionId);
  const seen: string[] = [];
  installRemote(manager, 'remote-exhaust', message => {
    seen.push(message.backgroundExecId);
    queueMicrotask(() => manager.handleToolError(message.callId, { code: PERSISTENT_EXEC_ID_COLLISION_CODE, message: 'collision' }));
  });
  try {
    await assert.rejects(() => manager.executeTool('remote-exhaust', 'exec', { command: 'sleep 1' }, sessionId), /exhausted after 3/);
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  } finally { await sessionManager.deleteSession(sessionId).catch(() => false); }
});
