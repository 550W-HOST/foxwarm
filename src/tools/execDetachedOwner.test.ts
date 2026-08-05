import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as llm from '../llm';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { createExecRuntime, type ExecRuntime, type RunningExecEntry } from '../execManager';
import type { Session } from '../types';
import { tool_exec } from './execTools';

function createSession(id: string, cwd: string): Session {
  return {
    id,
    agent: 'main',
    cwd,
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function fakeEntry(id: string, command: string, cwd: string): RunningExecEntry {
  return {
    id,
    pid: 12345,
    sessionId: 'detached-session',
    agentName: 'main',
    nodeId: 'master',
    command,
    initialCwd: cwd,
    logPath: path.join(cwd, `${id}.log`),
    statusPath: path.join(cwd, `${id}.status.json`),
    cwdPath: path.join(cwd, `${id}.cwd.txt`),
    startedAt: Date.now(),
    notifyOnCompletion: false,
  };
}

test('detached foreground exec uses its runtime, owner persistence, and passed cwd', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-detached-exec-'));
  const next = path.join(root, 'next');
  await fs.ensureDir(next);
  const session = createSession(`detached_exec_${Date.now()}`, root);
  const runtime = createExecRuntime({
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'temp'),
    registryPath: path.join(root, 'running.json'),
  });
  let persistCount = 0;
  const originals = {
    save: sessionManager.saveSession,
    update: sessionRuntime.updateSettings,
  };
  (sessionManager as any).saveSession = async () => { throw new Error('global save forbidden'); };
  (sessionRuntime as any).updateSettings = async () => { throw new Error('global cwd update forbidden'); };
  const ctx: any = {
    sessionId: session.id,
    session,
    execRuntime: runtime,
    persistCurrentSession: async () => { persistCount += 1; },
  };

  try {
    await runtime.initialize();
    const changed = String(await tool_exec({ command: `cd ${JSON.stringify(next)}; printf detached-output`, timeout: 5 }, ctx));
    assert.match(changed, /detached-output/);
    assert.match(changed, new RegExp(`SESSION CWD CHANGED: .*${path.basename(next)}`));
    assert.equal(session.cwd, next);
    assert.equal(persistCount, 2, 'pre-exec and changed cwd each persist exactly once');
    assert.deepEqual(runtime.listRunningExecs(), []);
    assert.deepEqual((await fs.readJson(path.join(root, 'running.json'))).execs, []);

    const unchanged = String(await tool_exec({ command: 'printf unchanged-cwd', timeout: 5 }, ctx));
    assert.match(unchanged, /unchanged-cwd/);
    assert.doesNotMatch(unchanged, /SESSION CWD CHANGED/);
    assert.equal(persistCount, 3, 'unchanged cwd adds only the unconditional pre-exec persist');

    const beforeFailure = runtime.listRunningExecs().length;
    await assert.rejects(() => tool_exec({ command: 'printf must-not-spawn', timeout: 5 }, {
      ...ctx,
      persistCurrentSession: async () => { throw new Error('owner persist failed'); },
    }), /owner persist failed/);
    assert.equal(runtime.listRunningExecs().length, beforeFailure);
  } finally {
    (sessionManager as any).saveSession = originals.save;
    (sessionRuntime as any).updateSettings = originals.update;
    await fs.remove(root);
  }
});

test('detached timeout uses one injected runtime for wait, live cwd, mark, and formatting', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-detached-timeout-'));
  const session = createSession('detached-session', root);
  const entry = fakeEntry('timeout-entry', 'sleep 10', root);
  const calls: string[] = [];
  const runtime: ExecRuntime = {
    initialize: async () => {},
    startPersistentExec: async () => { calls.push('start'); return entry; },
    waitForExecCompletion: async () => { calls.push('wait'); return null; },
    markExecForBackgroundNotification: async () => { calls.push('mark'); return entry; },
    finalizeForegroundExec: async () => { calls.push('finalize'); },
    buildForegroundExecResult: async () => { calls.push('foreground'); return 'foreground'; },
    buildBackgroundTimeoutResult: async () => { calls.push('background'); return 'background-result'; },
    readFinishedExecWorkingDirectory: async () => { calls.push('finished-cwd'); return root; },
    readLiveExecWorkingDirectory: async () => { calls.push('live-cwd'); return root; },
    listRunningExecs: () => [entry],
  };
  let persists = 0;
  try {
    const result = await tool_exec({ command: 'sleep 10', timeout: 1 }, {
      sessionId: session.id,
      session,
      execRuntime: runtime,
      persistCurrentSession: async () => { persists += 1; },
    });
    assert.equal(result, 'background-result');
    assert.deepEqual(calls, ['start', 'wait', 'live-cwd', 'mark', 'background']);
    assert.equal(persists, 1);
  } finally {
    await fs.remove(root);
  }
});

test('parallel detached exec replays cwd in model order through the same owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-detached-parallel-exec-'));
  const firstCwd = path.join(root, 'first');
  const secondCwd = path.join(root, 'second');
  await Promise.all([fs.ensureDir(firstCwd), fs.ensureDir(secondCwd)]);
  const session = createSession(`detached_parallel_exec_${Date.now()}`, root);
  let sequence = 0;
  const cwdById = new Map<string, string>();
  const runtime: ExecRuntime = {
    initialize: async () => {},
    startPersistentExec: async options => {
      const id = `parallel-${sequence++}`;
      cwdById.set(id, options.command.includes('first') ? firstCwd : secondCwd);
      return fakeEntry(id, options.command, root);
    },
    waitForExecCompletion: async () => ({ exitCode: 0, finishedAt: new Date().toISOString() }),
    markExecForBackgroundNotification: async () => null,
    finalizeForegroundExec: async () => {},
    buildForegroundExecResult: async entry => `output-${entry.command}`,
    buildBackgroundTimeoutResult: async () => 'background',
    readFinishedExecWorkingDirectory: async entry => cwdById.get(entry.id) || null,
    readLiveExecWorkingDirectory: async () => null,
    listRunningExecs: () => [],
  };
  let persistCount = 0;
  const originals = { save: sessionManager.saveSession, update: sessionRuntime.updateSettings };
  (sessionManager as any).saveSession = async () => { throw new Error('global save forbidden'); };
  (sessionRuntime as any).updateSettings = async () => { throw new Error('global cwd update forbidden'); };
  const effects: llm.CurrentSessionEffects = {
    appendMessage: async () => {},
    persistSession: async owner => { assert.strictEqual(owner, session); persistCount += 1; },
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
    execRuntime: runtime,
  };

  try {
    const message = await llm.executeTools([
      { id: 'call-first', name: 'exec', args: { command: 'first' } },
      { id: 'call-second', name: 'exec', args: { command: 'second' } },
    ], { sessionId: session.id }, session, { currentSessionEffects: effects });
    assert.equal(message.parts.length, 2);
    assert.equal(session.cwd, secondCwd, 'last model-order exec owns the replayed cwd');
    assert.equal(persistCount, 4, 'two unconditional pre-exec saves plus two ordered cwd changes');
    assert.match(JSON.stringify(message), /SESSION CWD CHANGED/);
  } finally {
    (sessionManager as any).saveSession = originals.save;
    (sessionRuntime as any).updateSettings = originals.update;
    await fs.remove(root);
  }
});
