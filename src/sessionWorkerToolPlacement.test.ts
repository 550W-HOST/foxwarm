import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as sessionManager from './sessionManager';
import { getAgentDir, SESSIONS_FILE } from './config';
import { callTool } from './tools';
import { tool_call_tool } from './tools/unifiedSearch';
import { tool_search_tools } from './tools/unifiedSearch';
import { tool_run_script } from './toolscript';
import { executeTools } from './llm';
import * as nodeExecution from './nodeExecution';
import * as mcpExternal from './mcpExternalService';
import * as agentMetadata from './session/agentMetadata';
import { RpcError } from './rpc';
import * as fileDelivery from './fileDelivery';
import type { Session } from './types';

function owner(): Session {
  const id = `worker-tools-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return { id, aliases: [`${id}-alias`], agent: 'main', history: [], queue: [], meta: {}, stats: {}, currentNode: 'master' } as Session;
}

async function catalogBytes(): Promise<Buffer | null> {
  return await fs.pathExists(SESSIONS_FILE) ? fs.readFile(SESSIONS_FILE) : null;
}

test('worker direct, unified, and ToolScript node dispatch retain exact owner without child globals', async () => {
  const session = owner();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-tool-placement-'));
  const filePath = path.join(dir, 'probe.txt');
  await fs.writeFile(filePath, 'exact-owner');
  const before = await catalogBytes();
  const originals = { getSession: sessionManager.getSession, getExistingSession: sessionManager.getExistingSession, saveSession: sessionManager.saveSession,
    getArchivedMessages: sessionManager.getArchivedMessages, getArchivedBlocks: sessionManager.getArchivedBlocks };
  (sessionManager as any).getSession = async () => { throw new Error('forbidden child getSession'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('forbidden child getExistingSession'); };
  (sessionManager as any).saveSession = async () => { throw new Error('forbidden child saveSession'); };
  (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[], totalMatched: 0, availableRange: {}, requestedRange: {} });
  (sessionManager as any).getArchivedBlocks = async () => ({ records: [] as any[], totalMatched: 0, requestedRange: {} });
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  try {
    const effects: any = { placement: 'session-worker', appendMessage: async () => {}, persistSession: async () => {},
      notifySessionEvent: () => {}, registerAbortController: () => {}, clearAbortController: () => {}, clearWaitById: async () => false };
    assert.match(JSON.stringify(await executeTools([{ id: 'direct-read', name: 'read', args: { filePath } }],
      { sessionId: session.id }, session, { currentSessionEffects: effects })), /exact-owner/);
    assert.match(String(await callTool('read', { filePath }, ctx)), /exact-owner/);
    assert.match(String(await tool_call_tool({ source: 'node', name: 'read', args: { filePath } }, ctx)), /exact-owner/);
    const script = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="node", name="read", args={"filePath": args["path"]})', args: { path: filePath } }, ctx);
    assert.match(JSON.stringify(script.result), /exact-owner/);
    assert.match(String(await callTool('get_archived_messages', { sessionId: session.id }, ctx)), /No archived messages/);
    assert.match(String(await callTool('get_archived_blocks', { sessionId: session.id }, ctx)), /No archived blocks/);
    assert.deepEqual(await catalogBytes(), before);
  } finally {
    Object.assign(sessionManager, originals);
    await fs.remove(dir);
  }
});

test('Worker direct, unified, and ToolScript calls share live exact agent rules', async () => {
  const session = owner();
  session.agent = `worker_rules_agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  session.currentNode = 'remote-a';
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const originalExecute = nodeExecution.executeRemoteNodeTool;
  let calls = 0;
  try {
    await sessionManager.setAgentMetadata(session.agent, {
      isolated: true,
      isolatedNode: 'remote-a',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'deny', source: 'node', node: 'remote-a', tool: 'read' },
      ],
    });
    (nodeExecution as any).executeRemoteNodeTool = async () => { calls += 1; return { output: 'allowed' }; };
    await assert.rejects(() => callTool('read', { filePath: 'probe.txt' }, ctx), /tool rule denies/i);
    await assert.rejects(() => tool_call_tool({ source: 'node', name: 'read', args: { filePath: 'probe.txt' } }, ctx), /tool rule denies/i);
    const nested = await tool_run_script({ code: 'def main(args):\n    return call_tool("read", {"filePath": "probe.txt"})' }, ctx);
    assert.equal(nested.status, 'failed');
    assert.match(String(nested.error), /tool rule denies/i);
    assert.equal(calls, 0);

    await sessionManager.setAgentMetadata(session.agent, { isolated: true, isolatedNode: 'remote-a', toolRules: [] });
    assert.deepEqual(await callTool('read', { filePath: 'probe.txt' }, ctx), { output: 'allowed' });
    assert.equal(calls, 1);
  } finally {
    (nodeExecution as any).executeRemoteNodeTool = originalExecute;
    await sessionManager.setAgentMetadata(session.agent, { isolated: false }).catch(() => {});
  }
});

test('Worker unified call_tool authorizes the concrete Node target and delegates MCP target authority', async () => {
  const session = owner();
  session.agent = `worker_dispatcher_call_tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  session.currentNode = 'remote-a';
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const originalNodeExecute = nodeExecution.executeRemoteNodeTool;
  const originalMcpCall = mcpExternal.callMcpTool;
  let nodeEffects = 0;
  let mcpEffects = 0;
  const nodeDescriptor = { source: 'node', name: 'custom_probe', args: {} };
  const mcpDescriptor = { source: 'mcp', server: 'demo', name: 'probe', args: {} };
  try {
    (nodeExecution as any).executeRemoteNodeTool = async () => { nodeEffects += 1; return { output: 'node-ok' }; };
    (mcpExternal as any).callMcpTool = async () => { mcpEffects += 1; return { output: 'mcp-ok' }; };
    await sessionManager.setAgentMetadata(session.agent, {
      isolated: true,
      isolatedNode: 'remote-a',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'allow', source: 'mcp', server: 'demo', tool: 'probe' },
        { effect: 'deny', source: 'node', node: 'remote-a', tool: 'custom_probe' },
      ],
    });

    await assert.rejects(() => callTool('call_tool', nodeDescriptor, ctx), /denies node capability `custom_probe`/i);
    await assert.rejects(() => tool_call_tool(nodeDescriptor, ctx), /denies node capability `custom_probe`/i);
    const nested = await tool_run_script({
      code: 'def main(args):\n    return call_tool(source="node", name="custom_probe", args={})',
    }, ctx);
    assert.equal(nested.status, 'failed');
    assert.match(String(nested.error), /denies node capability `custom_probe`/i);
    assert.equal(nodeEffects, 0);
    assert.deepEqual(await tool_call_tool(mcpDescriptor, ctx), { output: 'mcp-ok' });
    assert.equal(mcpEffects, 1);

    await sessionManager.setAgentMetadata(session.agent, {
      isolated: true,
      isolatedNode: 'remote-a',
      toolRules: [
        { effect: 'allow', source: 'builtin', tool: 'run_script' },
        { effect: 'allow', source: 'mcp', server: 'demo', tool: 'probe' },
      ],
    });
    assert.deepEqual(await tool_call_tool(nodeDescriptor, ctx), { output: 'node-ok' });
    assert.equal(nodeEffects, 1);
    assert.equal(mcpEffects, 1);
  } finally {
    (nodeExecution as any).executeRemoteNodeTool = originalNodeExecute;
    (mcpExternal as any).callMcpTool = originalMcpCall;
    await sessionManager.setAgentMetadata(session.agent, { isolated: false }).catch(() => {});
  }
});

test('worker placement permits live rule-only replacement but still blocks isolation-node changes', async () => {
  const agentName = `worker_rule_update_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentDir = getAgentDir(agentName);
  await fs.ensureDir(agentDir);
  await sessionManager.setAgentMetadata(agentName, {
    isolated: true,
    isolatedNode: 'remote-a',
    toolRules: [{ effect: 'allow', source: 'builtin', tool: 'run_script' }],
  });
  sessionManager.setSessionWorkerEnqueueSink(async () => {});
  try {
    const updated = await sessionManager.setAgentIsolation(agentName, 'remote-a', []);
    assert.equal(updated.toolRuleCount, 0);
    assert.deepEqual(sessionManager.getAgentToolRules(agentName), []);
    await assert.rejects(() => sessionManager.setAgentIsolation(agentName, 'remote-b', []),
      (error: any) => error instanceof RpcError && error.code === 'SESSION_WORKER_ADMIN_UNSUPPORTED');
  } finally {
    sessionManager.setSessionWorkerEnqueueSink(undefined);
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await fs.remove(agentDir).catch(() => {});
  }
});

test('worker guards run before unsupported handlers and exact current state tools persist locally', async () => {
  const session = owner();
  let persists = 0;
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => { persists += 1; } };
  const before = await catalogBytes();
  const originals = { getSession: sessionManager.getSession, getExistingSession: sessionManager.getExistingSession, saveSession: sessionManager.saveSession,
    getArchivedMessages: sessionManager.getArchivedMessages, getArchivedBlocks: sessionManager.getArchivedBlocks };
  (sessionManager as any).getSession = async () => { throw new Error('forbidden guarded getSession'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('forbidden guarded getExistingSession'); };
  (sessionManager as any).saveSession = async () => { throw new Error('forbidden guarded saveSession'); };
  (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[], totalMatched: 0, availableRange: {}, requestedRange: {} });
  (sessionManager as any).getArchivedBlocks = async () => ({ records: [] as any[], totalMatched: 0, requestedRange: {} });
  try {
  for (const [name, args, extra] of [
    ['create_agent', { agentName: 'unsafe', convertSession: true }],
    ['create_agent', { agentName: 'unsafe', sourceSessionId: 'other/session' }],
    ['stop_session', { sessionId: '' }], ['stop_session', { sessionId: ' ' }],
    ['session', { action: 'update-display-name', sessionId: 'other/session', name: 'x' }],
    ['set_session_child_model', { sessionId: ' ', model: 'x' }],
    ['set_agent_inherit', { agentName: 'main' }],
    ['set_agent_isolated', { agentName: 'main' }],
    ['move_session', { sessionId: session.id, newSessionId: 'moved' }],
  ] as any[]) {
    await assert.rejects(() => callTool(name, args, { ...ctx, ...(extra || {}) }), { code: 'SESSION_WORKER_TOOL_UNAVAILABLE', retryable: true });
  }
  assert.match(String(await callTool('compact_session', {}, ctx)), /cannot start background compaction from a busy model tool call/);
  await assert.rejects(() => callTool('compact_session', { sessionId: 'other/session' }, ctx), /exact current session/);
  assert.match(String(await callTool('session', { action: 'status' }, ctx)), new RegExp(session.id));
  assert.match(String(await callTool('set_goal', { goal: 'stay exact' }, ctx)), /ok/);
  assert.match(String(await callTool('wait', { reason: 'pause' }, ctx)), /object Object|stopCurrentTurn/);
  assert.match(String(await callTool('stop_session', { sessionId: session.id }, ctx)), /Stop signal set/);
  session.stopping = false;
  assert.match(String(await callTool('stop_session', { sessionId: session.aliases![0] }, ctx)), /Stop signal set/);
  assert.match(String(await callTool('get_session_messages', { sessionId: session.aliases![0] }, ctx)), /No messages/);
  assert.match(String(await callTool('recall', { sessionId: `  ${session.id}  `, agentName: ' main ', target: 'overview' }, ctx)), /Recall overview/);
  assert.equal(session.stopping, true);
  assert.ok(persists >= 4);
  assert.deepEqual(await catalogBytes(), before);
  } finally {
    Object.assign(sessionManager, originals);
  }
});

test('worker direct and unified current-node routing carries exact cwd while explicit node does not', async () => {
  const session = owner();
  session.currentNode = 'remote-current'; session.cwd = '/exact/cwd';
  const calls: any[] = [];
  const original = nodeExecution.executeRemoteNodeTool;
  (nodeExecution as any).executeRemoteNodeTool = async (...args: any[]) => { calls.push(args); return { output: 'remote-ok' }; };
  const effects: any = { placement: 'session-worker', appendMessage: async () => {}, persistSession: async () => {},
    notifySessionEvent: () => {}, registerAbortController: () => {}, clearAbortController: () => {}, clearWaitById: async () => false };
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  try {
    await executeTools([{ id: 'direct', name: 'read', args: { filePath: 'x' } }], { sessionId: session.id }, session, { currentSessionEffects: effects });
    await tool_call_tool({ source: 'node', name: 'read', args: { filePath: 'x' } }, ctx);
    await tool_call_tool({ source: 'node', nodeId: 'remote-other', name: 'read', args: { filePath: 'x' } }, ctx);
    assert.deepEqual(calls.map(call => call[4]), [
      { currentNode: 'remote-current', cwd: '/exact/cwd' },
      { currentNode: 'remote-current', cwd: '/exact/cwd' },
      undefined,
    ]);
  } finally { (nodeExecution as any).executeRemoteNodeTool = original; }
});

test('worker guarded errors precede direct notifications, permissions, and recursive ToolScript effects', async () => {
  const session = owner(); session.verbose = true;
  let broadcasts = 0; let starts = 0;
  const effects: any = { placement: 'session-worker', appendMessage: async () => {}, persistSession: async () => {},
    notifySessionEvent: () => {}, registerAbortController: () => {}, clearAbortController: () => {}, clearWaitById: async () => false };
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const originalIsolated = agentMetadata.isSessionEffectivelyIsolated;
  (agentMetadata as any).isSessionEffectivelyIsolated = () => { throw new Error('concrete permission reached before guard'); };
  try {
    const direct = await executeTools([{ id: 'guarded', name: 'move_session', args: {}, argsParseError: 'malformed', rawArgsText: '{' } as any],
      { sessionId: session.id, broadcast: async () => { broadcasts += 1; }, onToolStart: () => { starts += 1; } }, session,
      { currentSessionEffects: effects });
    assert.match(JSON.stringify(direct), /SESSION_WORKER_TOOL_UNAVAILABLE/);
    assert.match(JSON.stringify(direct), /"retryable":true/);
    assert.equal(broadcasts, 0); assert.equal(starts, 0);
    await assert.rejects(() => tool_call_tool({ source: 'builtin', name: 'move_session', args: {} }, ctx),
      { code: 'SESSION_WORKER_TOOL_UNAVAILABLE', retryable: true });
  } finally { (agentMetadata as any).isSessionEffectivelyIsolated = originalIsolated; }
  const nested = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="move_session", args={})' }, ctx);
  assert.equal(nested.status, 'failed');
  assert.match(String(nested.error), /SESSION_WORKER_TOOL_UNAVAILABLE/);
});

test('recursive call_tool target rejection drops Worker progress while Main local progress remains', async () => {
  const session = owner();
  let progressEvents = 0;
  const originals = { notify: sessionManager.notifySessionEvent, get: sessionManager.getSession,
    getExisting: sessionManager.getExistingSession, save: sessionManager.saveSession };
  (sessionManager as any).notifySessionEvent = () => { progressEvents += 1; };
  (sessionManager as any).getSession = async () => { throw new Error('recursive child getSession'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('recursive child getExistingSession'); };
  (sessionManager as any).saveSession = async () => { throw new Error('recursive child saveSession'); };
  const workerCtx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', toolUseId: 'outer-worker',
    persistCurrentSession: async () => {} };
  try {
    const recursive = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="call_tool", args={"source":"builtin", "name":"move_session", "args":{}})' }, workerCtx);
    assert.equal(recursive.status, 'failed');
    assert.match(String(recursive.error), /dispatcher\/container.*not a concrete builtin capability/i);
    assert.equal(progressEvents, 0);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-toolscript-progress-'));
    const filePath = path.join(dir, 'probe.txt');
    await fs.writeFile(filePath, 'local-progress');
    try {
      const local = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="node", name="read", args={"filePath":args["path"]})', args: { path: filePath } },
        { ...workerCtx, sessionPlacement: 'local', toolUseId: 'outer-local' });
      assert.equal(local.status, 'completed');
      assert.ok(progressEvents >= 2);
    } finally { await fs.remove(dir); }
  } finally {
    (sessionManager as any).notifySessionEvent = originals.notify;
    (sessionManager as any).getSession = originals.get;
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).saveSession = originals.save;
  }
});

test('worker node topology select and compound copy use fixed facade with exact persistence', async () => {
  const session = owner();
  let persists = 0; let selectCalls = 0; let copyCalls = 0;
  const originals = { list: nodeExecution.listNodeTopology, select: nodeExecution.validateNodeSelection,
    copy: nodeExecution.copyBetweenNodes, get: sessionManager.getSession, save: sessionManager.saveSession,
    isolated: sessionManager.isSessionEffectivelyIsolated };
  (nodeExecution as any).listNodeTopology = async () => [{ id: 'master', type: 'master', tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }] }];
  (nodeExecution as any).validateNodeSelection = async () => { selectCalls += 1; return { nodeId: 'remote-a', defaultCwd: '/remote/default' }; };
  (nodeExecution as any).copyBetweenNodes = async () => { copyCalls += 1; return { sizeBytes: 3, sha256: 'copy-hash', overwritten: false }; };
  (sessionManager as any).getSession = async () => { throw new Error('child node getSession'); };
  (sessionManager as any).saveSession = async () => { throw new Error('child node saveSession'); };
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => { persists += 1; } };
  try {
    assert.match(String(await callTool('node', { action: 'list' }, ctx)), /master/);
    assert.equal((await tool_search_tools({ sources: ['node'], query: 'read' }, ctx)).tools[0].name, 'read');
    assert.match(String(await callTool('node', { action: 'select', nodeId: 'remote-a' }, ctx)), /remote\/default/);
    assert.equal(session.currentNode, 'remote-a'); assert.equal(session.cwd, undefined); assert.equal(persists, 1);

    session.currentNode = 'master'; session.cwd = '/before';
    ctx.persistCurrentSession = async () => {
      session.currentNode = 'authoritative-after-resync'; session.cwd = '/authority';
      throw new RpcError('SESSION_WORKER_PERSIST_FAILED', 'select persist failed', true);
    };
    await assert.rejects(() => callTool('node', { action: 'select', nodeId: 'remote-a' }, ctx), { code: 'SESSION_WORKER_PERSIST_FAILED' });
    assert.equal(session.currentNode, 'authoritative-after-resync'); assert.equal(session.cwd, '/authority');

    ctx.persistCurrentSession = async () => {
      session.currentNode = 'authoritative-before-poison'; session.cwd = '/poison-authority';
      throw new RpcError('SESSION_WORKER_RESYNC_REQUIRED', 'resync failed', true);
    };
    await assert.rejects(() => callTool('node', { action: 'select', nodeId: 'remote-a' }, ctx), { code: 'SESSION_WORKER_RESYNC_REQUIRED' });
    assert.equal(session.currentNode, 'authoritative-before-poison'); assert.equal(session.cwd, '/poison-authority');

    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    await assert.rejects(() => callTool('node', { action: 'select', nodeId: 'remote-a' }, ctx), /isolated and cannot switch node/);
    assert.equal(selectCalls, 3);
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
    ctx.persistCurrentSession = async () => { persists += 1; };

    const copyArgs = { sourceNode: 'master', sourcePath: 'a', targetNode: 'remote-a', targetPath: 'b' };
    assert.match(String(await callTool('copy_between_nodes', copyArgs, ctx)), /copy-hash/);
    assert.match(String(await tool_call_tool({ source: 'builtin', name: 'copy_between_nodes', args: copyArgs }, ctx)), /copy-hash/);
    const script = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="copy_between_nodes", args=args)', args: copyArgs }, ctx);
    assert.equal(script.status, 'completed'); assert.match(JSON.stringify(script.result), /copy-hash/);
    assert.equal(copyCalls, 3);
  } finally {
    (nodeExecution as any).listNodeTopology = originals.list; (nodeExecution as any).validateNodeSelection = originals.select;
    (nodeExecution as any).copyBetweenNodes = originals.copy; (sessionManager as any).getSession = originals.get;
    (sessionManager as any).saveSession = originals.save; (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('worker send_file direct unified and ToolScript calls share exact fixed delivery facade', async () => {
  const session = owner(); session.currentNode = 'remote-a'; session.cwd = '/exact/cwd';
  const calls: any[] = []; const original = fileDelivery.deliverFile;
  (fileDelivery as any).deliverFile = async (request: any) => { calls.push(request); return { output: 'sent', fullPath: '/prepared/file' }; };
  const ctx: any = { sessionId: session.id, session, sessionPlacement: 'session-worker', runtimeNodeId: 'remote-a', persistCurrentSession: async () => {} };
  const args = { filePath: ' demo.txt ', sessionId: 'target', caption: ' cap ' };
  try {
    assert.equal((await callTool('send_file', args, ctx)).output, 'sent');
    assert.equal((await tool_call_tool({ source: 'builtin', name: 'send_file', args }, ctx)).output, 'sent');
    const script = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="send_file", args=args)', args }, ctx);
    assert.equal(script.status, 'completed'); assert.match(JSON.stringify(script.result), /prepared\/file/);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], { sourceSessionId: session.id,
      intent: { sessionId: 'target', filePath: 'demo.txt', caption: 'cap' },
      routing: { runtimeNodeId: 'remote-a', currentNode: 'remote-a', cwd: '/exact/cwd' } });
  } finally { (fileDelivery as any).deliverFile = original; }
});
