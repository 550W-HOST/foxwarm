import assert from 'node:assert/strict';
import test from 'node:test';
import { NodesManager } from './manager';
import * as sessionManager from '../sessionManager';
import { PERSISTENT_EXEC_ID_COLLISION_CODE } from '../../packages/shared/dist/persistentExec';
import {
  CURRENT_NODE_PROTOCOL_RANGE,
  LEGACY_NODE_PROTOCOL_RANGE,
  negotiateNodeProtocol,
  type NodeProtocolCompatibility,
} from '../../packages/shared/dist/nodeProtocol';
import { verifyRemoteExecCompletionCapability } from './sessionEventCapability';

function installRemote(
  manager: NodesManager,
  nodeId: string,
  onCall: (message: any) => void,
  compatibility: NodeProtocolCompatibility = negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE),
): void {
  (manager as any).nodes.set(nodeId, {
    id: nodeId, type: 'test', tools: new Set(['exec']), lastActivity: Date.now(), protocolCompatibility: compatibility,
    ws: { send(payload: string) { onCall(JSON.parse(payload)); } },
  });
}

const v1Compatibility = () => negotiateNodeProtocol(LEGACY_NODE_PROTOCOL_RANGE, CURRENT_NODE_PROTOCOL_RANGE, true);

async function withSession(prefix: string, run: (sessionId: string) => Promise<void>): Promise<void> {
  const sessionId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await sessionManager.getSession(sessionId);
  try { await run(sessionId); }
  finally { await sessionManager.deleteSession(sessionId).catch(() => false); }
}

test('negotiated v1 uses the current petname when the remote accepts it', async () => {
  await withSession('remote-v1-current-id', async sessionId => {
    const manager = new NodesManager({ generateExecId: () => 'quiet-otter' });
    const seen: any[] = [];
    installRemote(manager, 'remote-v1-current-id', message => {
      seen.push(message);
      queueMicrotask(() => manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` }));
    }, v1Compatibility());
    const result = await manager.executeTool('remote-v1-current-id', 'exec', { command: 'sleep 1' }, sessionId);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].backgroundExecId, 'quiet-otter');
    assert.equal(verifyRemoteExecCompletionCapability(seen[0].completionCapability, {
      nodeId: 'remote-v1-current-id', sessionId, execId: 'quiet-otter',
    }), true);
    assert.match(JSON.stringify(result), /quiet-otter/);
  });
});

test('negotiated v1 falls back only on the exact legacy invalid-ID error and binds the final ID everywhere', async () => {
  await withSession('remote-v1-fallback', async sessionId => {
    const ids = ['calm-otter', 'quiet-heron'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()! });
    const seen: any[] = [];
    installRemote(manager, 'remote-v1-fallback', message => {
      seen.push(message);
      queueMicrotask(() => {
        if (seen.length === 1) manager.handleToolError(message.callId, 'Persistent exec ID is invalid.');
        else manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` });
      });
    }, v1Compatibility());
    const result = await manager.executeTool('remote-v1-fallback', 'exec', { command: 'sleep 1' }, sessionId);
    assert.deepEqual(seen.map(message => message.backgroundExecId), ['calm-otter', 'exec_quiet-heron']);
    assert.equal(verifyRemoteExecCompletionCapability(seen[1].completionCapability, {
      nodeId: 'remote-v1-fallback', sessionId, execId: 'exec_quiet-heron',
    }), true);
    assert.match(JSON.stringify(result), /exec_quiet-heron/);
  });
});

test('negotiated v1 retries only the exact legacy duplicate-ID error with a newly allocated legacy ID', async () => {
  await withSession('remote-v1-collision', async sessionId => {
    const ids = ['calm-otter', 'quiet-heron', 'swift-raven'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()! });
    const seen: any[] = [];
    installRemote(manager, 'remote-v1-collision', message => {
      seen.push(message);
      queueMicrotask(() => {
        if (seen.length === 1) manager.handleToolError(message.callId, 'Persistent exec ID is invalid.');
        else if (seen.length === 2) manager.handleToolError(message.callId, 'Persistent exec `exec_quiet-heron` already exists.');
        else manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` });
      });
    }, v1Compatibility());
    const result = await manager.executeTool('remote-v1-collision', 'exec', { command: 'sleep 1' }, sessionId);
    assert.deepEqual(seen.map(message => message.backgroundExecId), ['calm-otter', 'exec_quiet-heron', 'exec_swift-raven']);
    assert.match(JSON.stringify(result), /exec_swift-raven/);
  });
});

test('negotiated v1 never retries generic, ambiguous, or structured errors', async () => {
  for (const remoteError of [
    'Persistent exec ID is invalid. ',
    'Remote connection closed after dispatch.',
    { code: PERSISTENT_EXEC_ID_COLLISION_CODE, message: 'collision' },
  ]) {
    await withSession('remote-v1-no-retry', async sessionId => {
      const ids = ['calm-otter', 'quiet-heron'];
      const manager = new NodesManager({ generateExecId: () => ids.shift()! });
      const seen: any[] = [];
      installRemote(manager, 'remote-v1-no-retry', message => {
        seen.push(message);
        queueMicrotask(() => manager.handleToolError(message.callId, remoteError));
      }, v1Compatibility());
      await assert.rejects(() => manager.executeTool('remote-v1-no-retry', 'exec', { command: 'sleep 1' }, sessionId));
      assert.equal(seen.length, 1);
    });
  }
});

test('v2 remote exec preallocation keeps structured collision retries unchanged', async () => {
  await withSession('remote-v2-retry', async sessionId => {
    const ids = ['calm-otter', 'quiet-heron'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()! });
    const seen: string[] = [];
    installRemote(manager, 'remote-v2-retry', message => {
      seen.push(message.backgroundExecId);
      queueMicrotask(() => {
        if (seen.length === 1) manager.handleToolError(message.callId, { code: PERSISTENT_EXEC_ID_COLLISION_CODE, message: 'collision' });
        else manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` });
      });
    });
    const result = await manager.executeTool('remote-v2-retry', 'exec', { command: 'sleep 1' }, sessionId);
    assert.deepEqual(seen, ['calm-otter', 'quiet-heron']);
    assert.match(JSON.stringify(result), /quiet-heron/);
  });
});

test('v2 remote exec collision retry exhaustion fails closed without a hidden ID', async () => {
  await withSession('remote-v2-exhaust', async sessionId => {
    const ids = ['quiet-otter', 'calm-heron', 'swift-raven'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()!, remoteExecCollisionAttempts: 3 });
    const seen: string[] = [];
    installRemote(manager, 'remote-v2-exhaust', message => {
      seen.push(message.backgroundExecId);
      queueMicrotask(() => manager.handleToolError(message.callId, { code: PERSISTENT_EXEC_ID_COLLISION_CODE, message: 'collision' }));
    });
    await assert.rejects(() => manager.executeTool('remote-v2-exhaust', 'exec', { command: 'sleep 1' }, sessionId), /exhausted after 3/);
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  });
});
