import assert from 'node:assert/strict';
import test from 'node:test';
import { issueRemoteExecCompletionCapability, setNodeEventCapabilitySecretForTests } from './sessionEventCapability';
import {
  activateRemoteExecLivenessClaim,
  clearRemoteExecLivenessClaim,
  clearRemoteExecStateForSession,
  getRemoteExecLivenessRecordsForTests,
  hasRemoteExecLivenessClaim,
  releaseRemoteExecReservation,
  reserveRemoteExecIdentity,
  resetRemoteExecLivenessClaimsForTests,
} from './remoteExecLiveness';
import { NodesManager } from './manager';

function reserve(input: { nodeId: string; sessionId: string; agentName: string; execId: string; aliases?: string[] }) {
  const completionCapability = issueRemoteExecCompletionCapability(input.nodeId, input.sessionId, input.execId);
  const reserved = reserveRemoteExecIdentity({
    authenticatedNodeId: input.nodeId,
    canonicalSessionId: input.sessionId,
    sessionIdentityIds: [input.sessionId, ...(input.aliases || [])],
    agentName: input.agentName,
    execId: input.execId,
    completionCapability,
  });
  return { completionCapability, reserved };
}

test('remote exec liveness requires an exact Main reservation and preserves capability ownership', () => {
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 23));
  try {
    const identity = { nodeId: 'node-a', sessionId: 'agent-a/main', agentName: 'agent-a', execId: 'steady-ibis' };
    const unreservedCapability = issueRemoteExecCompletionCapability(identity.nodeId, identity.sessionId, identity.execId);
    assert.throws(() => activateRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability: unreservedCapability,
    }), /without an exact Main reservation/);

    const { completionCapability, reserved } = reserve(identity);
    assert.equal(reserved, true);
    assert.equal(reserve({ ...identity, nodeId: 'node-b' }).reserved, false, 'same Session identity is reserved across Nodes');
    activateRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    });
    assert.equal(hasRemoteExecLivenessClaim([identity.sessionId], identity.agentName, identity.execId), true);
    assert.equal(hasRemoteExecLivenessClaim([identity.sessionId], 'agent-b', identity.execId), false);
    assert.equal(clearRemoteExecLivenessClaim({
      authenticatedNodeId: 'node-b', originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    }), false);
    assert.equal(clearRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    }), true);
  } finally {
    resetRemoteExecLivenessClaimsForTests();
    setNodeEventCapabilitySecretForTests();
  }
});

test('released foreground reservation and completion-before-late-registration cannot revive liveness', () => {
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 27));
  try {
    const identity = { nodeId: 'node-a', sessionId: 'main', agentName: 'main', execId: 'calm-heron' };
    const { completionCapability } = reserve(identity);
    assert.equal(releaseRemoteExecReservation({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    }), true);
    assert.throws(() => activateRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    }), /without an exact Main reservation/);

    const second = reserve({ ...identity, execId: 'swift-raven' });
    assert.equal(clearRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: 'swift-raven', completionCapability: second.completionCapability,
    }), true);
    assert.throws(() => activateRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: 'swift-raven', completionCapability: second.completionCapability,
    }), /without an exact Main reservation/);
  } finally {
    resetRemoteExecLivenessClaimsForTests();
    setNodeEventCapabilitySecretForTests();
  }
});

test('remote exec liveness remains active across disconnect and Session deletion clears all alias-bound state', () => {
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 29));
  try {
    const identity = { nodeId: 'node-a', sessionId: 'old-main', agentName: 'main', execId: 'calm-heron', aliases: ['older-main'] };
    const { completionCapability } = reserve(identity);
    activateRemoteExecLivenessClaim({
      authenticatedNodeId: identity.nodeId, originalSessionId: identity.sessionId,
      execId: identity.execId, completionCapability,
    });
    const manager = new NodesManager();
    const ws = {};
    (manager as any).nodes.set(identity.nodeId, {
      id: identity.nodeId, type: 'test', ws, tools: new Set(), lastActivity: Date.now(),
    });
    manager.unregisterNode(identity.nodeId, ws as any);
    assert.equal(hasRemoteExecLivenessClaim(['new-main', identity.sessionId], identity.agentName, identity.execId), true);
    assert.equal(clearRemoteExecStateForSession(['new-main', identity.sessionId, ...(identity.aliases || [])]), 1);
    assert.deepEqual(getRemoteExecLivenessRecordsForTests(), []);
  } finally {
    resetRemoteExecLivenessClaimsForTests();
    setNodeEventCapabilitySecretForTests();
  }
});
