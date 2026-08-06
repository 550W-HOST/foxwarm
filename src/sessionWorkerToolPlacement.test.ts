import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as sessionManager from './sessionManager';
import { SESSIONS_FILE } from './config';
import { callTool } from './tools';
import { tool_call_tool } from './tools/unifiedSearch';
import { tool_run_script } from './toolscript';
import { executeTools } from './llm';
import * as nodeExecution from './nodeExecution';
import type { Session } from './types';

function owner(): Session {
  const id = `worker-tools-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return { id, aliases: [`${id}-alias`], agent: 'main', history: [], queue: [], meta: {}, stats: {}, currentNode: 'master' } as Session;
}

async function catalogBytes(): Promise<Buffer | null> {
  return await fs.pathExists(SESSIONS_FILE) ? fs.readFile(SESSIONS_FILE) : null;
}

test('worker direct, unified, and ToolScript builtin dispatch retain exact owner without child globals', async () => {
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
    assert.match(String(await tool_call_tool({ source: 'builtin', name: 'read', args: { filePath } }, ctx)), /exact-owner/);
    const script = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="read", args={"filePath": args["path"]})', args: { path: filePath } }, ctx);
    assert.match(JSON.stringify(script.result), /exact-owner/);
    assert.match(String(await callTool('get_archived_messages', { sessionId: session.id }, ctx)), /No archived messages/);
    assert.match(String(await callTool('get_archived_blocks', { sessionId: session.id }, ctx)), /No archived blocks/);
    assert.deepEqual(await catalogBytes(), before);
  } finally {
    Object.assign(sessionManager, originals);
    await fs.remove(dir);
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
    ['create_child_session', { suffix: 'x' }], ['send_file', { filePath: 'x' }], ['compact_session', {}],
    ['node', { action: 'list' }], ['copy_between_nodes', {}], ['session', { action: 'list' }],
    ['session', { action: ' list ' }], ['node_tools', { action: 'list' }], ['get_memory_context', { timestamp: 1 }],
    ['get_session_messages', { sessionId: 'other/session' }], ['recall', { sessionId: 'other/session' }],
    ['get_session_messages', { sessionId: '' }], ['get_session_messages', { sessionId: ' ' }],
    ['stop_session', { sessionId: '' }], ['stop_session', { sessionId: ' ' }],
    ['session', { action: 'update-display-name', sessionId: 'other/session', name: 'x' }],
    ['set_session_child_model', { sessionId: ' ', model: 'x' }],
    ['recall', { agentName: ' other-agent ', vector_query: 'x' }],
    ['image_write_to_file', { id: 'x', filePath: 'x' }, { runtimeNodeId: 'remote' }],
  ] as any[]) {
    await assert.rejects(() => callTool(name, args, { ...ctx, ...(extra || {}) }), { code: 'SESSION_WORKER_TOOL_UNAVAILABLE', retryable: true });
  }
  assert.match(String(await callTool('session', { action: 'status' }, ctx)), new RegExp(session.id));
  assert.match(String(await callTool('session', { action: 'update-display-name', name: 'Worker exact' }, ctx)), /changed/);
  assert.match(String(await callTool('session', { action: 'update-display-name', sessionId: '', name: 'Worker exact 2' }, ctx)), /changed/);
  assert.equal(session.displayName, 'Worker exact 2');
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
    await tool_call_tool({ source: 'builtin', name: 'read', args: { filePath: 'x' } }, ctx);
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
  const originalIsolated = sessionManager.isSessionEffectivelyIsolated;
  (sessionManager as any).isSessionEffectivelyIsolated = () => { throw new Error('concrete permission reached before guard'); };
  try {
    const direct = await executeTools([{ id: 'guarded', name: 'compact_session', args: {}, argsParseError: 'malformed', rawArgsText: '{' } as any],
      { sessionId: session.id, broadcast: async () => { broadcasts += 1; }, onToolStart: () => { starts += 1; } }, session,
      { currentSessionEffects: effects });
    assert.match(JSON.stringify(direct), /SESSION_WORKER_TOOL_UNAVAILABLE/);
    assert.match(JSON.stringify(direct), /"retryable":true/);
    assert.equal(broadcasts, 0); assert.equal(starts, 0);
    await assert.rejects(() => tool_call_tool({ source: 'builtin', name: 'compact_session', args: {} }, ctx),
      { code: 'SESSION_WORKER_TOOL_UNAVAILABLE', retryable: true });
  } finally { (sessionManager as any).isSessionEffectivelyIsolated = originalIsolated; }
  const nested = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="compact_session", args={})' }, ctx);
  assert.equal(nested.status, 'failed');
  assert.match(String(nested.error), /SESSION_WORKER_TOOL_UNAVAILABLE/);
});
