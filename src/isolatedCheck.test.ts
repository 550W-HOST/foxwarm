import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentDir } from './config';
import { checkToolPermission, checkToolPermissionForSession } from './isolatedCheck';
import * as sessionManager from './sessionManager';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function outcome(run: () => Promise<void>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await run();
    return { ok: true };
  } catch (error: any) {
    return { ok: false, message: error?.message || String(error) };
  }
}

test('passed-session tool permission preserves isolated ID-path behavior and messages', async () => {
  const sessionId = makeId('permission_parity');
  const agentName = makeId('permission_agent');
  const session = await sessionManager.getSession(sessionId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sessionId);
  await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node' });

  const ownPath = `${getAgentDir(agentName)}/probe.txt`;
  const cases: Array<{ name: string; tool: string; node: string; args: Record<string, any> }> = [
    { name: 'master own path', tool: 'read', node: 'master', args: { filePath: ownPath } },
    { name: 'bound exec', tool: 'exec', node: 'bound-node', args: { command: 'true' } },
    { name: 'copy own master to bound', tool: 'copy_between_nodes', node: 'master', args: { sourceNode: 'master', sourcePath: ownPath, targetNode: 'bound-node', targetPath: '/tmp/probe.txt' } },
    { name: 'same-session timer', tool: 'create_timer', node: 'master', args: { sessionId } },
    { name: 'same-agent new-session timer', tool: 'create_timer', node: 'master', args: { newSession: true, agentName } },
    { name: 'reject master exec', tool: 'exec', node: 'master', args: { command: 'true' } },
    { name: 'reject outside master path', tool: 'read', node: 'master', args: { filePath: '/tmp/outside.txt' } },
    { name: 'reject outside copy source', tool: 'copy_between_nodes', node: 'master', args: { sourceNode: 'master', sourcePath: '/tmp/outside.txt', targetNode: 'bound-node', targetPath: '/tmp/probe.txt' } },
    { name: 'reject other-session timer', tool: 'create_timer', node: 'master', args: { sessionId: makeId('other') } },
    { name: 'reject representative management tool', tool: 'list_agents', node: 'master', args: {} },
  ];

  try {
    for (const item of cases) {
      const byId = await outcome(() => checkToolPermission(item.tool, sessionId, item.node, item.args));
      const bySession = await outcome(() => checkToolPermissionForSession(session, item.tool, item.node, item.args));
      assert.deepEqual(bySession, byId, item.name);
    }
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
