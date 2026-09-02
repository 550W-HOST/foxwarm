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
import { getRemoteExecLivenessRecordsForTests } from './remoteExecLiveness';

function installRemote(
  manager: NodesManager,
  nodeId: string,
  onCall: (message: any) => void,
  compatibility: NodeProtocolCompatibility = negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE),
): void {
  (manager as any).nodes.set(nodeId, {
    id: nodeId, type: 'test', tools: new Set(['exec']), lastActivity: Date.now(), protocolCompatibility: compatibility,
    capabilities: { tools: [{ name: 'exec', description: 'exec' }], features: { remoteExecBackgroundRegistration: true } },
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

test('Main reservation prevents the same Session exec ID from reaching two Nodes', async () => {
  await withSession('remote-main-reservation', async sessionId => {
    const first = new NodesManager({ generateExecId: () => 'steady-ibis' });
    const secondIds = ['steady-ibis', 'calm-heron'];
    const second = new NodesManager({ generateExecId: () => secondIds.shift()! });
    const firstSeen: any[] = [];
    const secondSeen: any[] = [];
    installRemote(first, 'remote-reservation-a', message => {
      firstSeen.push(message);
      first.registerRemoteExecBackground('remote-reservation-a', {
        sessionId, execId: message.backgroundExecId, completionCapability: message.completionCapability,
      });
      queueMicrotask(() => first.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` }));
    });
    installRemote(second, 'remote-reservation-b', message => {
      secondSeen.push(message);
      queueMicrotask(() => second.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` }));
    });

    const firstCall = first.executeTool('remote-reservation-a', 'exec', { command: 'sleep 60' }, sessionId);
    const secondCall = second.executeTool('remote-reservation-b', 'exec', { command: 'printf done' }, sessionId);
    await Promise.all([firstCall, secondCall]);
    assert.deepEqual(firstSeen.map(message => message.backgroundExecId), ['steady-ibis']);
    assert.deepEqual(secondSeen.map(message => message.backgroundExecId), ['calm-heron']);
    assert.deepEqual(getRemoteExecLivenessRecordsForTests().map(record => [record.execId, record.state]), [['steady-ibis', 'active']]);
  });
});

test('foreground response and definite pre-start rejection release Main reservations', async () => {
  await withSession('remote-main-release', async sessionId => {
    const ids = ['quiet-otter', 'swift-raven'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()! });
    let callCount = 0;
    installRemote(manager, 'remote-main-release-node', message => {
      callCount += 1;
      queueMicrotask(() => {
        if (callCount === 1) manager.handleToolResponse(message.callId, { output: 'foreground' });
        else manager.handleToolError(message.callId, { message: 'invalid cwd', execStarted: false });
      });
    });
    await manager.executeTool('remote-main-release-node', 'exec', { command: 'printf done' }, sessionId);
    await assert.rejects(() => manager.executeTool('remote-main-release-node', 'exec', { command: 'pwd', cwd: '/missing' }, sessionId));
    assert.deepEqual(getRemoteExecLivenessRecordsForTests(), []);

    const sendFailure = new NodesManager({ generateExecId: () => 'calm-heron' });
    installRemote(sendFailure, 'remote-send-failure-node', () => { throw new Error('socket closed before send'); });
    await assert.rejects(() => sendFailure.executeTool('remote-send-failure-node', 'exec', { command: 'printf no' }, sessionId), /socket closed before send/);
    assert.deepEqual(getRemoteExecLivenessRecordsForTests(), []);
  });
});

test('durable completion before the late tool response clears state without resurrection', async () => {
  await withSession('remote-completion-response-race', async sessionId => {
    const manager = new NodesManager({ generateExecId: () => 'steady-ibis' });
    installRemote(manager, 'remote-completion-race-node', message => {
      queueMicrotask(async () => {
        manager.registerRemoteExecBackground('remote-completion-race-node', {
          sessionId, execId: message.backgroundExecId, completionCapability: message.completionCapability,
        });
        await manager.handleSessionEvent('remote-completion-race-node', sessionId, 'done', 'background', {
          eventId: `remote-exec-completion:${message.backgroundExecId}`,
          execId: message.backgroundExecId,
          completionCapability: message.completionCapability,
          eventTimestamp: Date.now(),
        });
        manager.handleToolResponse(message.callId, { output: `execId: ${message.backgroundExecId}` });
      });
    });
    await manager.executeTool('remote-completion-race-node', 'exec', { command: 'sleep 1' }, sessionId);
    assert.deepEqual(getRemoteExecLivenessRecordsForTests(), []);
  });
});

test('current Main retains an old Node successful exec response as outcome-unknown', async () => {
  await withSession('remote-old-node-success', async sessionId => {
    const manager = new NodesManager({ generateExecId: () => 'steady-ibis' });
    installRemote(manager, 'remote-old-node-success-node', message => {
      queueMicrotask(() => manager.handleToolResponse(message.callId, { output: 'legacy ambiguous result' }));
    });
    delete (manager as any).nodes.get('remote-old-node-success-node').capabilities.features;
    await manager.executeTool('remote-old-node-success-node', 'exec', { command: 'printf done' }, sessionId);
    assert.deepEqual(getRemoteExecLivenessRecordsForTests().map(record => [record.execId, record.state]), [['steady-ibis', 'outcome-unknown']]);
  });
});

test('remote exec response classification uses the dispatch peer feature snapshot across same-ID reconnect replacement', async () => {
  await withSession('remote-feature-snapshot', async sessionId => {
    const ids = ['steady-ibis', 'calm-heron'];
    const manager = new NodesManager({ generateExecId: () => ids.shift()! });
    const pending: any[] = [];
    installRemote(manager, 'remote-feature-snapshot-node', message => { pending.push(message); });

    const oldNode = (manager as any).nodes.get('remote-feature-snapshot-node');
    delete oldNode.capabilities.features;
    const oldCall = manager.executeTool('remote-feature-snapshot-node', 'exec', { command: 'printf old' }, sessionId);
    installRemote(manager, 'remote-feature-snapshot-node', () => { throw new Error('replacement should not receive old call'); });
    manager.handleToolResponse(pending.shift().callId, { output: 'old peer success' });
    await oldCall;
    assert.deepEqual(getRemoteExecLivenessRecordsForTests().map(record => [record.execId, record.state]), [['steady-ibis', 'outcome-unknown']]);

    const currentMessages: any[] = [];
    installRemote(manager, 'remote-feature-snapshot-node', message => { currentMessages.push(message); });
    const currentCall = manager.executeTool('remote-feature-snapshot-node', 'exec', { command: 'printf current' }, sessionId);
    installRemote(manager, 'remote-feature-snapshot-node', () => { throw new Error('replacement should not receive current call'); });
    const currentReplacement = (manager as any).nodes.get('remote-feature-snapshot-node');
    delete currentReplacement.capabilities.features;
    manager.handleToolResponse(currentMessages.shift().callId, { output: 'current peer foreground success' });
    await currentCall;
    assert.deepEqual(getRemoteExecLivenessRecordsForTests().map(record => [record.execId, record.state]), [['steady-ibis', 'outcome-unknown']]);
  });
});
