import test from 'node:test';
import assert from 'node:assert/strict';

import * as sessionManager from './sessionManager';
import * as agentTools from './toolsSessionAgent/agents';
import * as archiveRecallTools from './toolsSessionAgent/archiveRecall';
import * as nodeTools from './tools/nodeTools';
import {
  executeMainManagementTool,
  getMainManagementToolServiceStatus,
  initializeMainManagementTools,
  resetMainManagementToolsForTests,
  shutdownMainManagementTools,
} from './mainManagementTools';
import {
  call_tool,
  create_agent,
  create_child_session,
  create_session,
  list_agents,
  recall,
  send_to_session,
} from './tools';
import { tool_run_script } from './toolscript';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(...sessionIds: string[]): Promise<void> {
  await shutdownMainManagementTools().catch(() => {});
  resetMainManagementToolsForTests();
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
    await assert.rejects(
      () => executeMainManagementTool('list_agents', { overbound: 'x'.repeat(65 * 1024) }, { sessionId: sourceId }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_INVALID_ARGS',
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

test('worker recall, agent creation, and node administration keep direct unified and ToolScript parity through the fixed service', async () => {
  const sourceId = makeId('management_worker_tools');
  const source = await sessionManager.getSession(sourceId);
  const ctx: any = { sessionId: sourceId, session: source, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const originals = {
    recall: (archiveRecallTools as any).tool_recall,
    createAgent: (agentTools as any).tool_create_agent,
    pairList: (nodeTools as any).tool_node_pair_list,
    bootstrap: (nodeTools as any).tool_node_bootstrap_info,
  };
  (archiveRecallTools as any).tool_recall = async (_args: any, rawCtx: any) => `main-recall:${rawCtx.sessionId}`;
  (agentTools as any).tool_create_agent = async (_args: any, rawCtx: any) => `main-create-agent:${rawCtx.sessionId}`;
  (nodeTools as any).tool_node_pair_list = async (_args: any, rawCtx: any) => `main-pair-list:${rawCtx.sessionId}`;
  (nodeTools as any).tool_node_bootstrap_info = async (_args: any, rawCtx: any) => `main-bootstrap:${rawCtx.sessionId}`;
  try {
    assert.equal(await recall({ sessionId: 'other/session', target: 'overview' }, ctx), `main-recall:${sourceId}`);
    assert.equal(await call_tool({ source: 'builtin', name: 'create_agent', args: { agentName: 'unused' } }, ctx), `main-create-agent:${sourceId}`);
    assert.equal(await executeMainManagementTool('node_bootstrap_info', {}, ctx), `main-bootstrap:${sourceId}`);
    const nested = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="node_pair_list", args={})' }, ctx);
    assert.equal(nested.status, 'completed');
    assert.equal(nested.result, `main-pair-list:${sourceId}`);
    await assert.rejects(() => create_agent({ agentName: 'unsafe', convertSession: true }, ctx),
      (error: any) => error?.code === 'SESSION_WORKER_TOOL_UNAVAILABLE' && error?.retryable === true);
    await assert.rejects(() => create_agent({ agentName: 'unsafe', sourceSessionId: 'other/session' }, ctx),
      (error: any) => error?.code === 'SESSION_WORKER_TOOL_UNAVAILABLE' && error?.retryable === true);
  } finally {
    (archiveRecallTools as any).tool_recall = originals.recall;
    (agentTools as any).tool_create_agent = originals.createAgent;
    (nodeTools as any).tool_node_pair_list = originals.pairList;
    (nodeTools as any).tool_node_bootstrap_info = originals.bootstrap;
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

test('direct, unified, and ToolScript creation calls reject removed and unknown top-level keys', async () => {
  const sourceId = makeId('management_force_model_source');
  const source = await sessionManager.getSession(sourceId);
  const directSessionName = makeId('unknown_direct_create');
  const unifiedSessionName = makeId('unknown_unified_create');
  try {
    await assert.rejects(
      () => create_child_session({ suffix: 'old-direct', model: 'removed' }, { sessionId: sourceId, session: source }),
      /no longer accepts top-level model or effort/,
    );
    await assert.rejects(
      () => create_session({ agentName: 'main', sessionName: makeId('old_create'), effort: 'high' }, { sessionId: sourceId, session: source }),
      /no longer accepts top-level model or effort/,
    );
    await assert.rejects(
      () => call_tool({ source: 'builtin', name: 'create_child_session', args: { suffix: 'old-unified', effort: 'low' } }, { sessionId: sourceId, session: source }),
      /no longer accepts top-level model or effort/,
    );
    await assert.rejects(
      () => create_child_session({ suffix: 'unknown-direct', bogus: true }, { sessionId: sourceId, session: source }),
      /unknown key: bogus/,
    );
    await assert.rejects(
      () => create_session({ agentName: 'main', sessionName: directSessionName, bogus: true }, { sessionId: sourceId, session: source }),
      /unknown key: bogus/,
    );
    await assert.rejects(
      () => call_tool({ source: 'builtin', name: 'create_child_session', args: { suffix: 'unknown-unified', bogus: true } }, { sessionId: sourceId, session: source }),
      /unknown key: bogus/,
    );
    await assert.rejects(
      () => call_tool({ source: 'builtin', name: 'create_session', args: { agentName: 'main', sessionName: unifiedSessionName, bogus: true } }, { sessionId: sourceId, session: source }),
      /unknown key: bogus/,
    );
    const nested = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="builtin", name="create_session", args={"agentName":"main","sessionName":"old-script","model":"removed"})',
    }, { sessionId: sourceId, session: source });
    assert.equal(nested.status, 'failed');
    assert.match(String(nested.error), /no longer accepts top-level model or effort/);
    const nestedChildUnknown = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="builtin", name="create_child_session", args={"suffix":"unknown-script","bogus":True})',
    }, { sessionId: sourceId, session: source });
    assert.equal(nestedChildUnknown.status, 'failed');
    assert.match(String(nestedChildUnknown.error), /unknown key: bogus/);
    const nestedSessionUnknown = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="builtin", name="create_session", args={"agentName":"main","sessionName":"unknown-script-session","bogus":True})',
    }, { sessionId: sourceId, session: source });
    assert.equal(nestedSessionUnknown.status, 'failed');
    assert.match(String(nestedSessionUnknown.error), /unknown key: bogus/);
    assert.equal(sessionManager.getAllSessions().has(`${sourceId}_old-direct`), false);
    assert.equal(sessionManager.getAllSessions().has(`${sourceId}_old-unified`), false);
    assert.equal(sessionManager.getAllSessions().has(`${sourceId}_unknown-direct`), false);
    assert.equal(sessionManager.getAllSessions().has(`${sourceId}_unknown-unified`), false);
    assert.equal(sessionManager.getAllSessions().has(`${sourceId}_unknown-script`), false);
    assert.equal(sessionManager.getAllSessions().has(directSessionName), false);
    assert.equal(sessionManager.getAllSessions().has(unifiedSessionName), false);
    assert.equal(sessionManager.getAllSessions().has('unknown-script-session'), false);
  } finally {
    await cleanup(sourceId, 'old-script', directSessionName, unifiedSessionName, 'unknown-script-session');
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

test('worker display-name updates cross the Main-owned catalog boundary', async () => {
  const sourceId = makeId('management_display_name');
  await sessionManager.getSession(sourceId);
  try {
    const result = String(await executeMainManagementTool('session_update_display_name', {
      action: 'update-display-name',
      name: 'Main-owned name',
    }, { sessionId: sourceId }));
    assert.match(result, /display name changed/);
    assert.equal(sessionManager.getSessionCatalog(sourceId)?.displayName, 'Main-owned name');
  } finally {
    await cleanup(sourceId);
  }
});

test('terminal shutdown rejects later calls until explicit test reset', async () => {
  const sourceId = makeId('management_lifecycle');
  await sessionManager.getSession(sourceId);
  try {
    await executeMainManagementTool('list_agents', {}, { sessionId: sourceId });
    assert.equal(getMainManagementToolServiceStatus().ready, true);
    await shutdownMainManagementTools();
    assert.equal(getMainManagementToolServiceStatus().ready, false);
    await assert.rejects(
      () => executeMainManagementTool('list_agents', {}, { sessionId: sourceId }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SHUTDOWN',
    );
    assert.equal(getMainManagementToolServiceStatus().ready, false);
    resetMainManagementToolsForTests();
    await executeMainManagementTool('list_agents', {}, { sessionId: sourceId });
    assert.equal(getMainManagementToolServiceStatus().ready, true);
  } finally {
    await cleanup(sourceId);
  }
});

test('terminal shutdown drains accepted work and fences new calls', async () => {
  const sourceId = makeId('management_drain');
  await sessionManager.getSession(sourceId);
  const original = (agentTools as any).tool_list_agents;
  let markStarted!: () => void;
  let releaseHandler!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseHandler = resolve; });
  (agentTools as any).tool_list_agents = async () => {
    markStarted();
    await release;
    return 'drained result';
  };

  try {
    const accepted = executeMainManagementTool('list_agents', {}, { sessionId: sourceId });
    await started;
    let shutdownSettled = false;
    const shutdown = shutdownMainManagementTools().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    assert.equal(shutdownSettled, false);
    await assert.rejects(
      () => executeMainManagementTool('list_agents', {}, { sessionId: sourceId }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SHUTDOWN',
    );
    releaseHandler();
    assert.equal(await accepted, 'drained result');
    await shutdown;
    assert.equal(getMainManagementToolServiceStatus().ready, false);
  } finally {
    releaseHandler?.();
    (agentTools as any).tool_list_agents = original;
    await cleanup(sourceId);
  }
});

test('terminal shutdown fences an initialization already in flight', async () => {
  const initialization = initializeMainManagementTools();
  const shutdown = shutdownMainManagementTools();
  await assert.rejects(initialization, (error: any) => error?.code === 'MAIN_MANAGEMENT_SHUTDOWN');
  await shutdown;
  assert.equal(getMainManagementToolServiceStatus().ready, false);
  resetMainManagementToolsForTests();
});
