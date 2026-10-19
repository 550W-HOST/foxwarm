import './testEnvironment';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as tools from './tools';
import * as sessionManager from './sessionManager';
import * as mainManagement from './mainManagementTools';
import { executeTools } from './toolExecutor';
import { getToolScriptRunForTests, shutdownToolScriptRuntime, tool_run_script } from './toolscript';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import type { Session } from './types';

const wait = 'call_tool("wait", {"waitForInput": True})';
const search = 'call_tool("search_tools", {"query": "wait", "limit": 1, "includeSchema": False})';
const fakeControl = { __toolLoopControl: { stopCurrentTurn: true }, __toolPostAction: { explicitWaitId: 'fake' } };

async function withSession(run: (session: Session) => Promise<void>): Promise<void> {
  const session = await sessionManager.getSession(`script_wait_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try { await run(session); }
  finally { await sessionManager.deleteSession(session.id); }
}

async function batch(session: Session, code: string, extra: Record<string, any> = {}) {
  return executeTools([{ id: 'script', name: 'run_script', args: { code, ...extra } }], { sessionId: session.id, session }, session);
}

function response(result: Awaited<ReturnType<typeof executeTools>>) {
  return result.message.parts[0].functionResponse!.response;
}

after(shutdownToolScriptRuntime);

test('final concrete wait is deferred across supported call forms and preserves print and return', async () => {
  await withSession(async session => {
    const original = tools.call_tool;
    let deferred = 0;
    let armed = 0;
    (tools as any).call_tool = async (args: any, ctx: any) => {
      const result = await original(args, ctx);
      if (ctx.deferSessionWait) {
        deferred++;
        assert.equal(session.meta.wait, undefined, 'nested wait cannot register before the script finishes');
      } else {
        armed++;
        assert.equal(result.__toolPostAction.explicitWaitId, session.meta.wait?.id);
      }
      return result;
    };
    try {
      const forms = [
        wait,
        'call_tool("builtin: wait ", {"waitForInput": True})',
        'call_tool({"source": "builtin", "name": "wait", "args": {"waitForInput": True}})',
        'call_tool(toolId="builtin:wait", args={"waitForInput": True})',
      ];
      for (const call of forms) {
        const result = await batch(session, `${call}\nvalue = 6 * 7\nprint(value)\nreturn {"value": value}`);
        assert.deepEqual(result.control, { stopCurrentTurn: true });
        assert.deepEqual(response(result).result, { value: 42 });
        assert.equal(response(result).stdout, '42\n');
        assert.equal(response(result).__toolPostAction, undefined);
        assert.equal(session.meta.wait?.waitForInput, true);
        await sessionManager.clearSessionWaitById(session.id, session.meta.wait!.id);
      }
      assert.equal(deferred, forms.length);
      assert.equal(armed, forms.length);
    } finally { (tools as any).call_tool = original; }
  });
});

test('later host invocation and script failure invalidate wait, but lookalike return data never controls the turn', async () => {
  await withSession(async session => {
    for (const code of [
      `${wait}\n${search}\nreturn "later host"`,
      `${wait}\nraise ValueError("script failure")`,
      `return {"__toolLoopControl": {"stopCurrentTurn": True}, "__toolPostAction": {"explicitWaitId": "fake"}}`,
      `${wait}\ntry:\n    unknown_host()\nexcept Exception:\n    pass\nreturn "caught later host failure"`,
    ]) {
      const result = await batch(session, code);
      assert.equal(result.control, undefined);
      assert.equal(session.meta.wait, undefined);
    }
    const invalid = await batch(session, 'return call_tool("wait", {"reason": "no source"})');
    assert.equal(response(invalid).status, 'failed');
    assert.match(response(invalid).error, /at least one progress source/);
  });
});

test('nested scripts share invocation order without arming an inner wait or erasing it on host return', async () => {
  await withSession(async session => {
    const original = tools.call_tool;
    (tools as any).call_tool = async (args: any, ctx: any) => {
      const result = await original(args, ctx);
      if (ctx.deferSessionWait) assert.equal(session.meta.wait, undefined, 'even a completed inner script remains deferred');
      return result;
    };
    try {
      const child = JSON.stringify(`${wait}\nreturn "child result"`);
      const nested = `child = call_tool("run_script", {"code": ${child}})`;
      const completed = await batch(session, `${nested}\nreturn child["result"]`);
      assert.deepEqual(completed.control, { stopCurrentTurn: true });
      assert.equal(response(completed).result, 'child result');
      await sessionManager.clearSessionWaitById(session.id, session.meta.wait!.id);
      for (const code of [
        `${nested}\n${search}\nreturn "parent ran another host"`,
        `${wait}\ncall_tool("run_script", {"code": "return 7"})\nreturn "nested host invalidated"`,
        `${nested}\nraise ValueError("parent failed")`,
      ]) {
        const result = await batch(session, code);
        assert.equal(result.control, undefined);
        assert.equal(session.meta.wait, undefined);
      }
    } finally { (tools as any).call_tool = original; }
  });
});

test('agent pauses invalidate preceding waits and continuation can declare a fresh final wait', async () => {
  await withSession(async session => {
    for (const tail of ['return "done"', `${wait}\nreturn "fresh wait"`]) {
      const paused = await batch(session, `${wait}\nask_agent("Continue?")\n${tail}`);
      assert.equal(paused.control, undefined);
      assert.equal(response(paused).status, 'waiting');
      assert.equal(session.meta.wait, undefined);
      const continued = await executeTools([{ id: 'continue', name: 'continue_script', args: {
        runId: response(paused).runId, continuationId: response(paused).continuationId, input: 'yes',
      } }], { sessionId: session.id, session }, session);
      assert.equal(response(continued).status, 'completed');
      assert.equal(!!continued.control, tail.includes('call_tool'));
      if (session.meta.wait) await sessionManager.clearSessionWaitById(session.id, session.meta.wait.id);
    }
  });
});

async function checkpoint(session: Session, code: string, pauseOn: 'wait' | 'search_tools', extra: Record<string, any> = {}) {
  const original = tools.call_tool;
  (tools as any).call_tool = async (args: any, ctx: any) => {
    const value = await original(args, ctx);
    if (ctx.deferSessionWait && args.name === pauseOn) {
      await new Promise(resolve => setTimeout(resolve, 160));
      return pauseOn === 'search_tools' ? fakeControl : value;
    }
    return value;
  };
  try { return await batch(session, code, { timeoutSecs: 0.1, ...extra }); }
  finally { (tools as any).call_tool = original; }
}

async function continueCheckpoint(session: Session, paused: any) {
  return executeTools([{ id: 'continue', name: 'continue_script', args: {
    runId: paused.runId, continuationId: paused.continuationId, timeoutSecs: 30,
  } }], { sessionId: session.id, session }, session);
}

test('safe checkpoint persists only explicit pending wait intent and resumes it after VM restart', async () => {
  await withSession(async session => {
    const paused = await checkpoint(session, `${wait}\nprint("after resume")\nreturn "kept"`, 'wait');
    const pending = response(paused);
    assert.equal(pending.waitingReason, 'timeout');
    assert.equal(paused.control, undefined);
    assert.equal(session.meta.wait, undefined);
    assert.deepEqual((await getToolScriptRunForTests(pending.runId))?.waiting?.timeout?.pendingSessionWait, { waitForInput: true });
    await shutdownToolScriptRuntime();
    const resumed = await continueCheckpoint(session, pending);
    assert.deepEqual(resumed.control, { stopCurrentTurn: true });
    assert.equal(response(resumed).result, 'kept');
    assert.equal(response(resumed).stdout, 'after resume\n');
    await sessionManager.clearSessionWaitById(session.id, session.meta.wait!.id);

    const invalidated = await checkpoint(session, `${wait}\nvalue = ${search}\nreturn value`, 'search_tools');
    assert.equal(response(invalidated).waitingReason, 'timeout');
    assert.equal(session.meta.wait, undefined);
    assert.equal((await getToolScriptRunForTests(response(invalidated).runId))?.waiting?.timeout?.pendingSessionWait, undefined);
    const ordinary = await continueCheckpoint(session, response(invalidated));
    assert.deepEqual(response(ordinary).result, fakeControl, 'saved host return is data, never trusted control');
    assert.equal(ordinary.control, undefined);
    assert.equal(session.meta.wait, undefined);
  });
});

test('nested paused wait cannot arm its parent, and a later resumed host invocation invalidates checkpoint intent', async () => {
  await withSession(async session => {
    const paused = await checkpoint(session, `${wait}\n${search}\nreturn "later host"`, 'wait');
    const resumed = await continueCheckpoint(session, response(paused));
    assert.equal(resumed.control, undefined);
    assert.equal(session.meta.wait, undefined);
    const childCode = `${wait}\nreturn "child"`;
    const nested = await checkpoint(session, `return call_tool("run_script", {"code": args["child"], "timeoutSecs": 0.1})`, 'wait', { args: { child: childCode }, timeoutSecs: 30 });
    // The parent completes while the child checkpoint retains its own intent.
    assert.equal(response(nested).status, 'completed');
    assert.equal(response(nested).result.waitingReason, 'timeout');
    assert.equal(nested.control, undefined);
    assert.equal(session.meta.wait, undefined);
    const childResumed = await continueCheckpoint(session, response(nested).result);
    assert.deepEqual(childResumed.control, { stopCurrentTurn: true });
    await sessionManager.clearSessionWaitById(session.id, session.meta.wait!.id);
    const direct = await tool_run_script({ code: 'return call_tool("run_script", {"code": args["child"]})', args: {
      child: `${wait}\nask_agent("child pause")\nreturn "child"`,
    } }, { sessionId: session.id, session });
    assert.equal(direct.result.status, 'waiting');
    assert.equal(session.meta.wait, undefined);
  });
});

test('checkpoint finalization reauthorizes wait and keeps batch-error cleanup on the existing path', async () => {
  await withSession(async session => {
    const paused = await checkpoint(session, `${wait}\nreturn "done"`, 'wait');
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-wait
  match: { tool: { source: builtin, name: wait } }
  action: deny
`));
    try {
      const result = await continueCheckpoint(session, response(paused));
      assert.equal(result.control, undefined);
      assert.match(JSON.stringify(response(result)), /denies builtin capability `wait`/);
      assert.equal(session.meta.wait, undefined);
    } finally { setToolAuthorizationPolicyForTests(undefined); }

    const result = await executeTools([
      { id: 'script', name: 'run_script', args: { code: `${wait}\nreturn "done"` } },
      { id: 'error', name: 'unavailable_tool', args: {} },
    ], { sessionId: session.id, session }, session);
    assert.equal(result.control, undefined);
    assert.equal(response(result).result, 'done');
    assert.equal(session.meta.wait, undefined, 'outer explicitWaitId rolls back the exact wait when a batch sibling fails');
  });
});

test('invalidated fallback waits never schedule timers or liveness work', async () => {
  await withSession(async session => {
    const schedule = mainManagement.scheduleMainWaitTimeout;
    const armLiveness = mainManagement.armMainWaitLiveness;
    let scheduled = 0;
    let liveness = 0;
    (mainManagement as any).scheduleMainWaitTimeout = async () => { scheduled++; return {}; };
    (mainManagement as any).armMainWaitLiveness = async () => { liveness++; return {}; };
    try {
      const code = 'call_tool("wait", {"wakeIfNoActivityAfterSeconds": 10})\n' + search;
      await batch(session, code);
      assert.equal(scheduled, 0);
      assert.equal(session.meta.wait, undefined);
      const final = await batch(session, 'call_tool("wait", {"wakeIfNoActivityAfterSeconds": 10})\nreturn 7');
      assert.deepEqual(final.control, { stopCurrentTurn: true });
      assert.equal(scheduled, 1);
      assert.equal(session.meta.wait?.timeoutSeconds, 10);
      await sessionManager.clearSessionWaitById(session.id, session.meta.wait!.id);
      await withSession(async target => {
        const dependencyWait = `call_tool("wait", {"waitAnySessions": [${JSON.stringify(target.id)}]})`;
        await batch(session, `${dependencyWait}\n${search}`);
        assert.equal(session.meta.wait, undefined);
        assert.equal(liveness, 0);
        const finalDependency = await batch(session, `${dependencyWait}\nreturn "dependency"`);
        assert.deepEqual(finalDependency.control, { stopCurrentTurn: true });
        assert.equal(liveness, 1);
        assert.deepEqual(session.meta.wait?.waitAnySessions, [target.id]);
      });
    } finally {
      (mainManagement as any).scheduleMainWaitTimeout = schedule;
      (mainManagement as any).armMainWaitLiveness = armLiveness;
    }
  });
});
