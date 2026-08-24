import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueRemoteExecCompletionCapability,
  setNodeEventCapabilitySecretForTests,
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
