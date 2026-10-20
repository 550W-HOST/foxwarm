import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as timers from './timers';
import * as tools from './tools';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import * as llm from './llm';
import * as config from './config';
import { MessageRouter } from './messageRouter';
import { getToolScriptRunForTests, shutdownToolScriptRuntime } from './toolscript';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { INTER_AGENT_HANDOFF_RECALL_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX } from './toolCallControls';
import type { Session } from './types';

function sendArgs(sessionId: string, message = 'monitor alert') {
  return { sessionId, handoffRecall: `${INTER_AGENT_HANDOFF_RECALL_PREFIX}\nThe script checks the requested condition and notifies its owner only when useful.`, message,
    handoffConfirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\nThis notification reports an actionable condition, not a duplicate acknowledgement.\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}` };
}

async function fixture(run: (f: { root: string; session: Session; ctx: any; create: (script: any, extra?: any) => Promise<string> }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-script-timer-'));
  const session = await sessionManager.getSession(`script_timer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const ctx = { sessionId: session.id, session };
  timers.setTimersStoreForTests(timers.createTimersStore(path.join(root, 'timers.json')));
  try {
    await run({ root, session, ctx, create: async (script, extra = {}) => {
      const receipt = await tools.callTool('create_timer', { action: 'toolscript', afterSeconds: 3600, script, ...extra }, ctx);
      return /Timer `([^`]+)` created/.exec(receipt)![1];
    } });
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    timers.resetTimersForTests();
    await sessionManager.deleteSession(session.id);
    await fs.remove(root);
  }
}

test.after(async () => { await shutdownToolScriptRuntime(); await sessionRuntime.shutdownSessionRuntime(); });

test('registered file scripts reread source, run quietly while the real Main owner is busy, and preserve its abort slot', async () => {
  await fixture(async ({ root, session, create }) => {
    const script = path.join(root, 'monitor.py');
    const output = path.join(root, 'checked.txt');
    await fs.writeFile(script, 'raise ValueError("obsolete source")');
    const id = await create({ filePath: script, node: 'master', argsJson: JSON.stringify({ filePath: output }) });
    const persisted = await fs.readJson(path.join(root, 'timers.json'));
    assert.equal(persisted.timers[0].script.args.filePath, output);
    timers.resetTimersForTests();
    await timers.initializeTimers();
    await fs.writeFile(script, 'return call_tool("write", {"filePath": args["filePath"], "content": "checked"})');
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const originalChat = llm.chat;
    let requests = 0;
    const controller = new AbortController();
    (llm as any).chat = async (parts: any, owner: Session, _iteration: number, options: any) => {
      requests++;
      if (parts) await options.appendMessage({ role: 'user', parts });
      options.currentSessionEffects.registerAbortController(owner.id, controller);
      entered(); await held;
      options.currentSessionEffects.clearAbortController(owner.id, controller);
      await options.appendMessage({ role: 'model', parts: [{ text: 'done' }] });
      return { text: 'done' };
    };
    const router = new MessageRouter([]);
    session.queue.push({ type: 'user', parts: [{ text: 'long running request' }] });
    const pending = router.processSessionQueue(session.id);
    try {
      await started;
      const before = session.history.length;
      await timers.fireTimerForTests(id);
      assert.equal(await fs.readFile(output, 'utf8'), 'checked');
      assert.equal(requests, 1);
      assert.equal(session.busy, true);
      assert.equal(session.history.length, before);
      assert.equal(session.queue.length, 0);
      assert.equal(sessionManager.abortSessionInFlight(session.id), true);
      assert.equal(controller.signal.aborted, true, 'the model controller was not replaced or cleared');
      assert.equal(timers.listTimers(session.id).length, 0);
    } finally { release(); await pending; (llm as any).chat = originalChat; }
  });
});

test('ToolScript provenance permits self-notification from run, continuation and timer, not direct or spoofed calls', async () => {
  await fixture(async ({ session, ctx, create }) => {
    const send = sendArgs(session.id);
    await assert.rejects(() => tools.callTool('send_to_session', send, ctx), /same session/i);
    await assert.rejects(() => tools.callTool('send_to_session', { ...send, toolScriptRunId: 'tsr_1_12345678' }, ctx), /unsupported argument/i);
    const run = await tools.callTool('run_script', { code: 'return call_tool("send_to_session", args)', args: send }, ctx);
    assert.equal(run.status, 'completed');
    assert.equal(session.queue.length, 1);
    const wrapper = session.queue[0].parts[0].system!;
    assert.match(wrapper, /type="toolscript"/);
    assert.doesNotMatch(wrapper, /replyVia|replyTargetSessionId|from another session/);
    session.queue = [];
    const paused = await tools.callTool('run_script', { code: 'ask_agent("Proceed?")\nreturn call_tool("send_to_session", args)', args: send }, ctx);
    const continued = await tools.callTool('continue_script', { runId: paused.runId, continuationId: paused.continuationId, input: 'yes' }, ctx);
    assert.equal(continued.status, 'completed');
    assert.equal(session.queue.length, 1);
    session.queue = [];
    const id = await create({ code: 'return call_tool("send_to_session", args)', args: send });
    await timers.fireTimerForTests(id);
    assert.equal(session.queue.length, 1);
    assert.match(session.queue[0].parts[0].system!, /monitor alert/);
    session.queue = [];
    const confirmationEnabled = config.HANDOFF_CONFIRMATION_ENABLED;
    (config as any).HANDOFF_CONFIRMATION_ENABLED = true;
    const invalid = await tools.callTool('run_script', { code: 'return call_tool("send_to_session", args)', args: { sessionId: session.id, message: 'missing review' } }, ctx);
    (config as any).HANDOFF_CONFIRMATION_ENABLED = confirmationEnabled;
    assert.equal(invalid.status, 'failed');
    assert.equal(session.queue.length, 0);
    await tools.callTool('run_script', { code: 'return {"toolScriptRunId": "tsr_1_12345678"}' }, ctx);
    await assert.rejects(() => tools.callTool('send_to_session', send, { ...ctx, programmatic: true }), /same session/i);
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: deny-send\n  match: { tool: { source: builtin, name: send_to_session } }\n  action: deny\n'));
    const denied = await tools.callTool('run_script', { code: 'return call_tool("send_to_session", args)', args: send }, ctx);
    assert.equal(denied.status, 'failed');
    assert.equal(session.queue.length, 0);
  });
});

test('unattended final wait preserves the existing wait; failed and paused ticks end without automatic messages', async () => {
  await fixture(async ({ session, create, ctx }) => {
    const wait = { id: 'existing-wait', startedAt: Date.now(), waitForInput: true };
    session.meta.wait = wait;
    const id = await create({ code: `return call_tool("run_script", {"code": ${JSON.stringify('return call_tool("wait", {"waitForInput": True})')}})` });
    await timers.fireTimerForTests(id);
    assert.deepEqual(session.meta.wait, wait);
    assert.equal(session.history.length, 0);
    assert.equal(session.queue.length, 0);
    const fail = await create({ code: 'raise ValueError("monitor failed")' });
    await timers.fireTimerForTests(fail);
    const pause = await create({ code: 'ask_agent("Need input")' });
    await timers.fireTimerForTests(pause);
    assert.equal(timers.listTimers(session.id).length, 0);
    const records = await tools.callTool('list_toolscript_runs', {}, ctx);
    assert.ok(records.runs.some((run: any) => run.status === 'failed'));
    const waiting = records.runs.find((run: any) => run.status === 'waiting');
    assert.ok(waiting);
    const saved = await getToolScriptRunForTests(waiting.runId);
    assert.ok(saved?.snapshotBase64);
    assert.equal(session.queue.length, 0);
    assert.deepEqual(session.meta.wait, wait);
  });
});

test('a timeout checkpoint preserves deferred wait intent without arming the unattended owner', async () => {
  await fixture(async ({ session, ctx, create }) => {
    const existing = { id: 'checkpoint-owner-wait', startedAt: Date.now(), waitForInput: true };
    session.meta.wait = existing;
    const originalCall = tools.call_tool;
    (tools as any).call_tool = async (args: any, context: any) => {
      const result = await originalCall(args, context);
      if (args.name === 'wait' || args.toolId === 'builtin:wait') await new Promise(resolve => setTimeout(resolve, 30));
      return result;
    };
    try {
      const id = await create({ code: 'call_tool("wait", {"waitForInput": True})\nreturn 7', timeoutSecs: 0.01 });
      await timers.fireTimerForTests(id);
      assert.deepEqual(session.meta.wait, existing);
      const records = await tools.callTool('list_toolscript_runs', {}, ctx);
      const paused = records.runs.find((run: any) => run.waitingReason === 'timeout');
      assert.ok(paused);
      assert.deepEqual((await getToolScriptRunForTests(paused.runId))?.waiting?.timeout?.pendingSessionWait, { waitForInput: true });
      assert.equal(session.queue.length, 0);
    } finally { (tools as any).call_tool = originalCall; }
  });
});

test('script registration is owner-only, replacement clears old payload, and fire-time read/host authorization remains live', async () => {
  await fixture(async ({ root, session, ctx, create }) => {
    const other = await sessionManager.getSession(`${session.id}_other`);
    try {
      await assert.rejects(() => tools.callTool('create_timer', { action: 'toolscript', sessionId: other.id, afterSeconds: 60, script: { code: 'return 1' } }, ctx), /calling Session/);
      const message = await timers.createTimer({ sessionId: other.id, message: 'message target', afterSeconds: 3600 });
      await assert.rejects(() => tools.callTool('update_timer', { sessionId: other.id, timerId: message.id, action: 'toolscript', script: { code: 'return 1' } }, ctx), /owner Session/);
      const own = await timers.createTimer({ sessionId: session.id, message: 'old message', afterSeconds: 3600, newSession: true });
      await tools.callTool('update_timer', { timerId: own.id, action: 'toolscript', script: { code: 'return 1' } }, ctx);
      assert.equal(timers.listTimers(session.id)[0].message, '');
      assert.equal(timers.listTimers(session.id)[0].newSession, false);
      await tools.callTool('update_timer', { timerId: own.id, action: 'message', message: 'new message' }, ctx);
      assert.equal(timers.listTimers(session.id)[0].script, undefined);
      const source = path.join(root, 'source.py'); const output = path.join(root, 'denied.txt');
      await fs.writeFile(source, 'return call_tool("write", {"filePath": args["filePath"], "content": "forbidden"})');
      const id = await create({ code: 'return 1' });
      await tools.callTool('update_timer', { timerId: id, script: { filePath: source, args: { filePath: output } } }, ctx);
      const updated = timers.listTimers(session.id).find(timer => timer.id === id)!;
      assert.equal(updated.script!.code, undefined);
      setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: deny-write\n  match: { tool: { source: node, name: write } }\n  action: deny\n'));
      await timers.fireTimerForTests(id);
      assert.equal(await fs.pathExists(output), false);
      const readDenied = await create({ filePath: source });
      setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: deny-read\n  match: { tool: { source: node, name: read } }\n  action: deny\n'));
      await timers.fireTimerForTests(readDenied);
      assert.equal(timers.listTimers(session.id).some(timer => timer.id === readDenied), false);
    } finally { await sessionManager.deleteSession(other.id); }
  });
});

test('one slice per timer skips overlap and in-flight self update/delete cannot consume a replacement', { timeout: 20000 }, async () => {
  await fixture(async ({ root, session, ctx }) => {
    const originalCall = tools.call_tool;
    let entered!: () => void; let release!: () => void;
    let reached = new Promise<void>(resolve => { entered = resolve; });
    let held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    (tools as any).call_tool = async (args: any, context: any) => {
      if (args.toolId === 'builtin:search_tools' || args.source === 'builtin' && args.name === 'search_tools') { calls++; entered(); await held; }
      return originalCall(args, context);
    };
    try {
      const timer = await timers.createTimer({ sessionId: session.id, cron: '0 0 1 1 *', action: 'toolscript', script: { code: 'return call_tool("search_tools", {"query": "read", "limit": 1})' } });
      const first = timers.fireTimerForTests(timer.id); await reached;
      await timers.fireTimerForTests(timer.id);
      assert.equal(calls, 1);
      await tools.callTool('update_timer', { timerId: timer.id, script: { code: 'return 42' } }, ctx);
      release(); await first;
      assert.equal(timers.listTimers(session.id).find(item => item.id === timer.id)?.script?.code, 'return 42');
      const selfUpdate = await timers.createTimer({ sessionId: session.id, afterSeconds: 3600, action: 'toolscript', script: { code: 'return 1' } });
      await tools.callTool('update_timer', { timerId: selfUpdate.id, script: { code: 'return call_tool("update_timer", args)', args: { timerId: selfUpdate.id, afterSeconds: 3600, script: { code: 'return 7' } } } }, ctx);
      await timers.fireTimerForTests(selfUpdate.id);
      assert.equal(timers.listTimers(session.id).find(item => item.id === selfUpdate.id)?.script?.code, 'return 7');
      await tools.callTool('update_timer', { timerId: selfUpdate.id, script: { code: 'return call_tool("delete_timer", args)', args: { timerId: selfUpdate.id } } }, ctx);
      await timers.fireTimerForTests(selfUpdate.id);
      assert.equal(timers.listTimers(session.id).some(item => item.id === selfUpdate.id), false);
      // A replacement once deadline that fires during the prior slice is not lost.
      reached = new Promise<void>(resolve => { entered = resolve; }); held = new Promise<void>(resolve => { release = resolve; });
      const overdue = await timers.createTimer({ sessionId: session.id, afterSeconds: 3600, action: 'toolscript',
        script: { code: 'return call_tool("search_tools", {"query": "read", "limit": 1})' } });
      const oldSlice = timers.fireTimerForTests(overdue.id); await reached;
      const output = path.join(root, 'replacement-ran');
      await tools.callTool('update_timer', { timerId: overdue.id, afterSeconds: 0.01,
        script: { code: 'return call_tool("write", args)', args: { filePath: output, content: 'replacement' } } }, ctx);
      await new Promise(resolve => setTimeout(resolve, 30));
      release(); await oldSlice;
      const deadline = Date.now() + 3000;
      while (!await fs.pathExists(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(await fs.readFile(output, 'utf8'), 'replacement');
      // Drain includes accepted scripts, without starting future cron ticks.
      reached = new Promise<void>(resolve => { entered = resolve; }); held = new Promise<void>(resolve => { release = resolve; });
      await tools.callTool('update_timer', { timerId: timer.id, script: { code: 'return call_tool("search_tools", {"query": "read", "limit": 1})' } }, ctx);
      const draining = timers.fireTimerForTests(timer.id); await reached;
      let settled = false; const stop = timers.shutdownTimers().then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
      release(); await draining; await stop;
      await timers.fireTimerForTests(timer.id); assert.equal(calls, 3);
    } finally { release(); (tools as any).call_tool = originalCall; }
  });
});
