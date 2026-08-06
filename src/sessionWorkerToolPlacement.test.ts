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
import type { Session } from './types';

function owner(): Session {
  return { id: `worker-tools-${Date.now()}`, agent: 'main', history: [], queue: [], meta: {}, stats: {}, currentNode: 'master' } as Session;
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
  const originals = { getSession: sessionManager.getSession, getExistingSession: sessionManager.getExistingSession, saveSession: sessionManager.saveSession };
  (sessionManager as any).getSession = async () => { throw new Error('forbidden guarded getSession'); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('forbidden guarded getExistingSession'); };
  (sessionManager as any).saveSession = async () => { throw new Error('forbidden guarded saveSession'); };
  try {
  for (const [name, args, extra] of [
    ['create_child_session', { suffix: 'x' }], ['send_file', { filePath: 'x' }], ['compact_session', {}],
    ['node', { action: 'list' }], ['copy_between_nodes', {}], ['session', { action: 'list' }],
    ['get_session_messages', { sessionId: 'other/session' }], ['recall', { sessionId: 'other/session' }],
    ['image_write_to_file', { id: 'x', filePath: 'x' }, { runtimeNodeId: 'remote' }],
  ] as any[]) {
    await assert.rejects(() => callTool(name, args, { ...ctx, ...(extra || {}) }), { code: 'SESSION_WORKER_TOOL_UNAVAILABLE', retryable: true });
  }
  assert.match(String(await callTool('session', { action: 'status' }, ctx)), new RegExp(session.id));
  assert.match(String(await callTool('session', { action: 'update-display-name', name: 'Worker exact' }, ctx)), /changed/);
  assert.equal(session.displayName, 'Worker exact');
  assert.match(String(await callTool('set_goal', { goal: 'stay exact' }, ctx)), /ok/);
  assert.match(String(await callTool('wait', { reason: 'pause' }, ctx)), /object Object|stopCurrentTurn/);
  assert.match(String(await callTool('stop_session', { sessionId: session.id }, ctx)), /Stop signal set/);
  assert.equal(session.stopping, true);
  assert.ok(persists >= 4);
  assert.deepEqual(await catalogBytes(), before);
  } finally {
    Object.assign(sessionManager, originals);
  }
});
