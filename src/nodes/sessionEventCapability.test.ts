import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueExternalExecCompletionCapability,
  issueRemoteExecCompletionCapability,
  setNodeEventCapabilitySecretForTests,
  verifyExternalExecCompletionCapability,
  verifyRemoteExecCompletionCapability,
} from './sessionEventCapability';

test('remote exec completion capability is scoped to its node, session, and exec', () => {
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 7));
  try {
    const expected = { nodeId: 'remote-a', sessionId: 'session-a', execId: 'exec_12345678' };
    const capability = issueRemoteExecCompletionCapability(expected.nodeId, expected.sessionId, expected.execId);
    assert.equal(verifyRemoteExecCompletionCapability(capability, expected), true);
    assert.equal(verifyRemoteExecCompletionCapability(capability, { ...expected, nodeId: 'remote-b' }), false);
    assert.equal(verifyRemoteExecCompletionCapability(capability, { ...expected, sessionId: 'session-b' }), false);
    assert.equal(verifyRemoteExecCompletionCapability(capability, { ...expected, execId: 'exec_87654321' }), false);
    assert.equal(verifyRemoteExecCompletionCapability(`${capability}x`, expected), false);
  } finally {
    setNodeEventCapabilitySecretForTests();
  }
});

test('external exec receipt is signed for exactly one authenticated Node, external context and exec ID', () => {
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 7));
  try {
    const expected = { nodeId: 'remote-a', externalId: 'alpha',
      contextId: '11111111-2222-4333-8444-555555555555', execId: 'quiet-heron' };
    const capability = issueExternalExecCompletionCapability(expected.nodeId, expected.externalId,
      expected.contextId, expected.execId);
    assert.equal(verifyExternalExecCompletionCapability(capability, expected), true);
    assert.equal(verifyExternalExecCompletionCapability(capability, { ...expected, nodeId: 'remote-b' }), false);
    assert.equal(verifyExternalExecCompletionCapability(capability, { ...expected, externalId: 'beta' }), false);
    assert.equal(verifyExternalExecCompletionCapability(capability, { ...expected, contextId: '11111111-2222-4333-8444-666666666666' }), false);
    assert.equal(verifyExternalExecCompletionCapability(capability, { ...expected, execId: 'swift-fox' }), false);
    assert.equal(verifyRemoteExecCompletionCapability(capability,
      { nodeId: expected.nodeId, sessionId: expected.contextId, execId: expected.execId }), false);
  } finally { setNodeEventCapabilitySecretForTests(); }
});
