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
  const cases: Array<{ name: string; source: 'builtin' | 'node'; tool: string; node: string; args: Record<string, any> }> = [
    { name: 'master own path', source: 'node', tool: 'read', node: 'master', args: { filePath: ownPath } },
    { name: 'bound exec', source: 'node', tool: 'exec', node: 'bound-node', args: { command: 'true' } },
    { name: 'copy own master to bound', source: 'builtin', tool: 'copy_between_nodes', node: 'master', args: { sourceNode: 'master', sourcePath: ownPath, targetNode: 'bound-node', targetPath: '/tmp/probe.txt' } },
    { name: 'same-session timer', source: 'builtin', tool: 'create_timer', node: 'master', args: { sessionId } },
    { name: 'same-agent new-session timer', source: 'builtin', tool: 'create_timer', node: 'master', args: { newSession: true, agentName } },
    { name: 'reject master exec', source: 'node', tool: 'exec', node: 'master', args: { command: 'true' } },
    { name: 'reject outside master path', source: 'node', tool: 'read', node: 'master', args: { filePath: '/tmp/outside.txt' } },
    { name: 'reject outside copy source', source: 'builtin', tool: 'copy_between_nodes', node: 'master', args: { sourceNode: 'master', sourcePath: '/tmp/outside.txt', targetNode: 'bound-node', targetPath: '/tmp/probe.txt' } },
    { name: 'reject other-session timer', source: 'builtin', tool: 'create_timer', node: 'master', args: { sessionId: makeId('other') } },
    { name: 'reject representative management tool', source: 'builtin', tool: 'list_agents', node: 'master', args: {} },
  ];

  try {
    for (const item of cases) {
      const identity = { source: item.source, tool: item.tool, ...(item.source === 'node' ? { node: item.node } : {}) };
      const byId = await outcome(() => checkToolPermission(identity, sessionId, item.node, item.args));
      const bySession = await outcome(() => checkToolPermissionForSession(session, identity, item.node, item.args));
      assert.deepEqual(bySession, byId, item.name);
    }
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('exact agent tool rules are isolated-only, live, non-inherited, and cannot allow master exec', async () => {
  const sessionId = makeId('permission_rules');
  const agentName = makeId('permission_rules_agent');
  const parentAgent = makeId('permission_rules_parent');
  const session = await sessionManager.getSession(sessionId);
  session.agent = agentName;
  session.currentNode = 'bound-node';
  await sessionManager.saveSession(sessionId);

  try {
    await sessionManager.setAgentMetadata(parentAgent, {
      toolRules: [{ effect: 'deny', source: 'node', node: 'bound-node', tool: 'read' }],
    });
    await sessionManager.setAgentMetadata(agentName, {
      isolated: false,
      isolatedNode: 'bound-node',
      inherit: parentAgent,
      toolRules: [{ effect: 'deny', source: 'node', node: 'bound-node', tool: 'exec' }],
    });
    await assert.doesNotReject(() => checkToolPermissionForSession(session,
      { source: 'node', node: 'bound-node', tool: 'exec' }, 'bound-node', { command: 'true' }));

    await sessionManager.setAgentMetadata(agentName, {
      isolated: true,
      isolatedNode: 'bound-node',
      inherit: parentAgent,
      toolRules: [
        { effect: 'deny', source: 'node', node: 'bound-node', tool: 'exec' },
        { effect: 'deny', source: 'builtin', tool: 'skill' },
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'allow', source: 'builtin', tool: 'copy_between_nodes' },
        { effect: 'allow', source: 'builtin', tool: 'create_timer' },
        { effect: 'allow', source: 'node', node: 'master', tool: 'exec' },
      ],
    });
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'node', node: 'bound-node', tool: 'exec' }, 'bound-node', { command: 'true' }), /tool rule denies/i);
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'skill' }, 'master', { action: 'list' }), /tool rule denies/i);
    await assert.doesNotReject(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'run_script' }, 'master', {}));
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'node', node: 'master', tool: 'exec' }, 'master', { command: 'true' }), /cannot run exec on master/i);
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'copy_between_nodes' }, 'master', {
        sourceNode: 'master', sourcePath: '/tmp/outside-agent', targetNode: 'bound-node', targetPath: '/tmp/out',
      }), /can only read from agents\//i);
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'copy_between_nodes' }, 'master', {
        sourceNode: 'other-node', sourcePath: '/tmp/in', targetNode: 'bound-node', targetPath: '/tmp/out',
      }), /bound\/current node/i);
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'create_timer' }, 'master', { sessionId: makeId('other-session') }), /own current session/i);
    await assert.rejects(() => checkToolPermissionForSession(session,
      { source: 'builtin', tool: 'create_timer' }, 'master', {
        newSession: true, agentName: makeId('other-agent'),
      }), /own agent/i);

    await sessionManager.setAgentMetadata(agentName, {
      isolated: true,
      isolatedNode: 'bound-node',
      inherit: parentAgent,
      toolRules: [],
    });
    await assert.doesNotReject(() => checkToolPermissionForSession(session,
      { source: 'node', node: 'bound-node', tool: 'read' }, 'bound-node', { filePath: '/tmp/probe' }));
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.setAgentMetadata(parentAgent, {}).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
