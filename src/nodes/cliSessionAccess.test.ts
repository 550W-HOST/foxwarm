import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { nodesManager } from './manager';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function seedSession(sessionId: string, nodeId: string, agent = 'main') {
  const session = await sessionManager.getSession(sessionId);
  session.agent = agent;
  session.currentNode = nodeId;
  session.history = [{ role: 'user', parts: [{ text: `hello from ${sessionId}` }], __meta: { timestamp: Date.now() } }];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now(), messageCount: session.history.length };
  await sessionManager.saveSession(sessionId);
  return session;
}

test('cli-node session APIs only expose sessions bound to the requesting node', async () => {
  await sessionManager.loadSessions();
  const nodeA = makeId('cli_node_a');
  const nodeB = makeId('cli_node_b');
  const sessionA = makeId('cli_session_a');
  const sessionB = makeId('cli_session_b');

  await seedSession(sessionA, nodeA);
  await seedSession(sessionB, nodeB);

  const list = await nodesManager.listSessionsForNode(nodeA);
  assert.ok(list.some(item => item.id === sessionA));
  assert.equal(list.some(item => item.id === sessionB), false);

  const history = await nodesManager.getSessionHistoryForNode(nodeA, sessionA, 10);
  assert.equal(history.session.id, sessionA);
  assert.equal(history.messages.length, 1);
  assert.match(history.messages[0].text, /hello from/);

  await assert.rejects(
    () => nodesManager.getSessionHistoryForNode(nodeA, sessionB, 10),
    /cannot read history/,
  );
  await assert.rejects(
    () => nodesManager.handleSessionEvent(nodeA, sessionB, 'not allowed', 'trigger'),
    /cannot send session events/,
  );
  await assert.rejects(
    () => nodesManager.handleSessionUserMessage(nodeA, sessionB, 'not allowed', 'trigger'),
    /cannot send messages/,
  );
});

test('cli-node session APIs allow isolated-agent sessions bound to the node', async () => {
  await sessionManager.loadSessions();
  const nodeId = makeId('cli_iso_node');
  const agent = makeId('cli_iso_agent');
  const sessionId = `${agent}/main`;
  await (await import('fs-extra')).default.ensureDir((await import('../config')).getAgentDir(agent));

  await sessionManager.setAgentIsolation(agent, nodeId);
  await seedSession(sessionId, 'master', agent);

  const list = await nodesManager.listSessionsForNode(nodeId);
  assert.ok(list.some(item => item.id === sessionId));

  const history = await nodesManager.getSessionHistoryForNode(nodeId, sessionId, 10);
  assert.equal(history.session.id, sessionId);

  await sessionManager.setAgentIsolation(agent, undefined);
});
