import test from 'node:test';
import assert from 'node:assert/strict';

import * as sessionManager from './sessionManager';
import * as agentTools from './toolsSessionAgent/agents';
import {
  executeMainManagementTool,
  getMainManagementToolServiceStatus,
  shutdownMainManagementTools,
} from './mainManagementTools';
import {
  call_tool,
  list_agents,
  send_to_session,
} from './tools';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(...sessionIds: string[]): Promise<void> {
  await shutdownMainManagementTools().catch(() => {});
  for (const sessionId of sessionIds) {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
}

test('main management service rejects missing, stale, and non-allowlisted sources/operations', async () => {
  const sourceId = makeId('management_source');
  await sessionManager.getSession(sourceId);
  try {
    await assert.rejects(
      () => executeMainManagementTool('list_agents', {}, undefined),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SOURCE_REQUIRED',
    );
    await assert.rejects(
      () => executeMainManagementTool('list_agents', {}, { sessionId: makeId('missing') }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SOURCE_NOT_FOUND',
    );
    await assert.rejects(
      () => executeMainManagementTool('read' as any, {}, { sessionId: sourceId }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED',
    );
  } finally {
    await cleanup(sourceId);
  }
});

test('local transport clones request/response and resolves raw handlers at call time', async () => {
  const sourceId = makeId('management_clone');
  await sessionManager.getSession(sourceId);
  const original = (agentTools as any).tool_list_agents;
  const sharedResult = { nested: { value: 1 } };
  (agentTools as any).tool_list_agents = async (args: any, ctx: any) => {
    args.mutatedByHandler = true;
    assert.equal(ctx.sessionId, sourceId);
    return sharedResult;
  };
  const args: any = { callerValue: 1 };

  try {
    const result: any = await executeMainManagementTool('list_agents', args, { sessionId: sourceId });
    assert.equal(args.mutatedByHandler, undefined);
    result.nested.value = 9;
    assert.equal(sharedResult.nested.value, 1);

    const handlerError = new Error('management handler failure');
    (agentTools as any).tool_list_agents = async () => { throw handlerError; };
    await assert.rejects(
      () => executeMainManagementTool('list_agents', {}, { sessionId: sourceId }),
      (error: any) => error !== handlerError && error?.code === 'RPC_HANDLER_ERROR' && error?.message === handlerError.message,
    );
  } finally {
    (agentTools as any).tool_list_agents = original;
    await cleanup(sourceId);
  }
});

test('direct and unified send_to_session share delivery and waitAfterHandoff control semantics', async () => {
  const sourceId = makeId('management_send_source');
  const targetId = makeId('management_send_target');
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.getSession(targetId);

  try {
    const direct: any = await send_to_session({
      sessionId: targetId,
      message: 'direct management delivery',
      waitAfterHandoff: true,
    }, { sessionId: sourceId, session: source });
    assert.equal(direct.__toolPostAction?.waitForReply, true);

    const unified: any = await call_tool({
      toolId: 'builtin:send_to_session',
      args: { sessionId: targetId, message: 'unified management delivery' },
    }, { sessionId: sourceId, session: source });
    assert.match(String(unified), /Message sent to session/);

    const target = await sessionManager.getSession(targetId);
    const queuedText = target.queue.flatMap(item => item.parts || []).map(part => part.text || part.system || '').join('\n');
    assert.match(queuedText, /direct management delivery/);
    assert.match(queuedText, /unified management delivery/);
  } finally {
    await cleanup(sourceId, targetId);
  }
});

test('list_agents uses the service and preserves isolated-session rejection', async () => {
  const sourceId = makeId('management_agents');
  const agentName = makeId('isolated_agent');
  const source = await sessionManager.getSession(sourceId);
  source.agent = agentName;
  await sessionManager.saveSession(sourceId);

  try {
    const normalResult = await list_agents({}, { sessionId: sourceId, session: source });
    assert.equal(typeof normalResult, 'string');

    await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'test-node' });
    await assert.rejects(
      () => list_agents({}, { sessionId: sourceId, session: source }),
      /Isolated session cannot use list_agents tool/,
    );
    assert.deepEqual(getMainManagementToolServiceStatus(), { placement: 'local', ready: true });
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await cleanup(sourceId);
  }
});

test('shutdown drains and permits clean lazy reinitialization', async () => {
  const sourceId = makeId('management_lifecycle');
  await sessionManager.getSession(sourceId);
  try {
    await executeMainManagementTool('list_agents', {}, { sessionId: sourceId });
    assert.equal(getMainManagementToolServiceStatus().ready, true);
    await shutdownMainManagementTools();
    assert.equal(getMainManagementToolServiceStatus().ready, false);
    await executeMainManagementTool('list_agents', {}, { sessionId: sourceId });
    assert.equal(getMainManagementToolServiceStatus().ready, true);
  } finally {
    await cleanup(sourceId);
  }
});
