import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';

import { executeTools } from './llm';
import * as llm from './llm';
import { MessageRouter } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as managedSessions from './managedSessions';
import { getAgentDir } from './config';
import { tool_cancel_toolscript_run, tool_continue_script, tool_get_toolscript_run, tool_list_toolscript_runs, tool_run_script, tool_start_toolscript_run, getToolScriptRunForTests, resetToolScriptRunsForTests } from './toolscript';
import type { Session } from './types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function writeScript(fileName: string, content: string): Promise<string> {
  const agentDir = getAgentDir('main');
  await fs.ensureDir(agentDir);
  const fullPath = path.join(agentDir, fileName);
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}

test('run_script executes internal call_tool without surfacing nested tool history entries', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_exec');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    'print("hello")',
    'call_tool("search_tools", {"query": "read", "sources": ["builtin"], "limit": 1, "includeSchema": False})',
  ].join('\n'));

  const session = await sessionManager.getSession(sessionId);

  try {
    const toolMessage = await executeTools(
      [{ id: 'run-script-1', name: 'run_script', args: { filePath: scriptName } }],
      { sessionId, session },
      session,
    );

    assert.equal(toolMessage.parts.length, 1);
    const response = toolMessage.parts[0].functionResponse?.response;
    assert.equal(response?.status, 'completed');
    assert.equal(response?.stdout, 'hello\n');
    assert.deepEqual(response?.executedTools, ['search_tools']);
    assert.equal(response?.result?.count, 1);
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('run_script pauses at ask_agent and continue_script resumes from persisted snapshot', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_pause');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    'print("before")',
    'answer = ask_agent("What now?")',
    'print(answer)',
    'answer',
  ].join('\n'));

  const session = await sessionManager.getSession(sessionId);

  try {
    const paused = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(paused.status, 'waiting');
    assert.equal(paused.waitingReason, 'agent');
    assert.equal(paused.question, 'What now?');
    assert.ok(paused.runId);
    assert.ok(paused.continuationId);
    assert.equal(paused.stdout, 'before\n');
    assert.deepEqual(paused.executedTools, []);

    const persisted = await getToolScriptRunForTests(paused.runId);
    assert.equal(persisted?.status, 'waiting');
    assert.equal(persisted?.waiting?.reason, 'agent');
    assert.equal(persisted?.waiting?.question, 'What now?');
    assert.ok(persisted?.snapshotBase64);

    const completed = await tool_continue_script({
      runId: paused.runId,
      continuationId: paused.continuationId,
      input: 'Continue',
    }, { sessionId, session });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.result, 'Continue');
    assert.equal(completed.stdout, 'before\nContinue\n');
    assert.deepEqual(completed.executedTools, []);

    const finalRecord = await getToolScriptRunForTests(paused.runId);
    assert.equal(finalRecord?.status, 'completed');
    assert.equal(finalRecord?.snapshotBase64, undefined);
    assert.equal(finalRecord?.lastResult, 'Continue');
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('request_model_without_context uses direct low-level llm request with no tools or persistent context', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_model');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, 'request_model_without_context("ping")');

  const session = await sessionManager.getSession(sessionId);
  session.model = 'anthropic/claude-sonnet-4-5';
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  let captured: { model?: string; systemPrompt?: string; toolDefinitionsLength?: number; inputText?: string } = {};

  (llm as any).requestLlmOnce = async (options: any) => {
    captured = {
      model: options.model,
      systemPrompt: options.systemPrompt,
      toolDefinitionsLength: Array.isArray(options?.toolDefinitions) ? options.toolDefinitions.length : -1,
      inputText: Array.isArray(options?.contents) ? options.contents.flatMap((msg: any) => msg.parts || []).map((part: any) => part.text || '').join('\n') : '',
    };
    return { text: 'pong', toolCalls: [] as any[] };
  };

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { text: 'pong' });
    assert.equal(captured.model, 'anthropic/claude-sonnet-4-5');
    assert.equal(captured.systemPrompt, '');
    assert.equal(captured.toolDefinitionsLength, 0);
    assert.equal(captured.inputText, 'ping');
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('ToolScript manager host functions can open, step, and release a managed child session', async () => {
  await resetToolScriptRunsForTests();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = makeId('toolscript_manager_parent');
  const childId = makeId('toolscript_manager_child');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `step = session_step("${childId}", lease["leaseId"], lease["revision"], run_mode="idle", inbox_order="before", message="managed hello")`,
    `release_managed_session("${childId}", lease["leaseId"], step["revision"])`,
    'step',
  ].join('\n'));

  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    if (parts?.length) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: `child handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` }],
    });
    return { text: `child handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` };
  };

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(result.status, 'completed');
    assert.equal(result.result?.runMode, 'idle');
    assert.equal(result.result?.inboxOrder, 'before');
    assert.equal(result.result?.yieldReason, 'idle');
    assert.equal(result.result?.consumedPendingInboxCount, 0);
    assert.equal(result.result?.pendingInboxCount, 0);
    assert.equal(result.result?.newMessagesCount, 2);
    assert.equal(result.result?.newMessages?.length, 0);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('ToolScript session_step can optionally include full newMessages payload', async () => {
  await resetToolScriptRunsForTests();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = makeId('toolscript_manager_include_parent');
  const childId = makeId('toolscript_manager_include_child');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `step = session_step("${childId}", lease["leaseId"], lease["revision"], run_mode="idle", inbox_order="before", include_messages=True, message="managed hello")`,
    `release_managed_session("${childId}", lease["leaseId"], step["revision"])`,
    'step',
  ].join('\n'));

  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    if (parts?.length) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: `child handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` }],
    });
    return { text: `child handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` };
  };

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(result.status, 'completed');
    assert.equal(result.result?.newMessages?.length, 2);
    assert.equal(result.result?.newMessages?.[0]?.role, 'user');
    assert.equal(result.result?.newMessages?.[1]?.role, 'model');
    assert.match(result.result?.newMessages?.[1]?.parts?.[0]?.text || '', /managed hello/);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('background ToolScript controller run can wait for managed inbox events and resume itself', async () => {
  await resetToolScriptRunsForTests();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = makeId('toolscript_bg_parent');
  const childId = makeId('toolscript_bg_child');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `event = wait_for_managed_event("${childId}", lease["leaseId"], lease["revision"])`,
    `result = step_and_release_managed_session("${childId}", lease["leaseId"], event["revision"], message="controller woke")`,
    'result',
  ].join('\n'));

  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    if (parts?.length) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: `bg child handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` }],
    });
    return { text: 'ok' };
  };

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const started = await tool_start_toolscript_run({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(started.mode, 'background');
    assert.equal(started.status, 'waiting');
    assert.equal(started.waitingReason, 'managed_event');
    assert.equal(started.relatedManagedSessions?.[0]?.sessionId, childId);

    const managedState = await managedSessions.getManagedSessionStateForTests(childId);
    assert.equal(managedState?.controllerRunId, started.runId);

    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'outside event' }], 'background');
    await new Promise(resolve => setTimeout(resolve, 50));

    const completed = await getToolScriptRunForTests(started.runId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.lastResult?.yieldReason, 'idle');
    assert.equal(completed?.lastResult?.releasedPendingInboxCount, 0);

    const child = await sessionManager.getSession(childId);
    assert.match(child.history[child.history.length - 1]?.parts?.[0]?.text || '', /controller woke/);
    assert.equal(await managedSessions.getManagedSessionStateForTests(childId), undefined);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('background ToolScript step_and_release controller run survives a managed child tool loop', async () => {
  await resetToolScriptRunsForTests();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = makeId('toolscript_bg_toolloop_parent');
  const childId = makeId('toolscript_bg_toolloop_child');
  const scriptName = `${makeId('script')}.py`;
  let childChatCalls = 0;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `event = wait_for_managed_event("${childId}", lease["leaseId"], lease["revision"])`,
    `result = step_and_release_managed_session("${childId}", lease["leaseId"], event["revision"], run_mode="idle", inbox_order="before", message="controller woke")`,
    'result',
  ].join('\n'));

  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    if (parts?.length) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    childChatCalls += 1;
    if (childChatCalls === 1) {
      const toolCall = {
        id: 'toolscript_bg_toolloop_call_1',
        name: 'get_session_messages',
        args: {
          sessionId: activeSession.id,
          start: 0,
          count: 20,
          previewLength: 200,
        },
      };
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ functionCall: toolCall }],
      });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }

    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: `bg toolloop handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` }],
    });
    return { text: 'ok' };
  };

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const started = await tool_start_toolscript_run({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(started.status, 'waiting');
    assert.equal(started.waitingReason, 'managed_event');

    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'outside event' }], 'background');
    await new Promise(resolve => setTimeout(resolve, 50));

    const completed = await getToolScriptRunForTests(started.runId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.lastResult?.yieldReason, 'idle');
    assert.equal(completed?.lastResult?.releasedPendingInboxCount, 0);
    assert.equal(childChatCalls, 2);
    assert.equal(await managedSessions.getManagedSessionStateForTests(childId), undefined);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('background ToolScript step_and_release controller run survives multiple managed child tool rounds', async () => {
  await resetToolScriptRunsForTests();
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const parentId = makeId('toolscript_bg_multitool_parent');
  const childId = makeId('toolscript_bg_multitool_child');
  const scriptName = `${makeId('script')}.py`;
  let childChatCalls = 0;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `event = wait_for_managed_event("${childId}", lease["leaseId"], lease["revision"])`,
    `result = step_and_release_managed_session("${childId}", lease["leaseId"], event["revision"], run_mode="idle", inbox_order="before", message="controller woke")`,
    'result',
  ].join('\n'));

  sessionManager.setSessionTriggerCallback((sessionId) => router.processSessionQueue(sessionId));
  (llm as any).chat = async (parts: any, activeSession: Session) => {
    if (parts?.length) {
      await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
    }
    childChatCalls += 1;
    if (childChatCalls === 1) {
      const toolCall = {
        id: 'toolscript_bg_multitool_call_1',
        name: 'get_session_messages',
        args: { sessionId: activeSession.id, start: 0, count: 20, previewLength: 200 },
      };
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }
    if (childChatCalls === 2) {
      const toolCall = {
        id: 'toolscript_bg_multitool_call_2',
        name: 'list_toolscript_runs',
        args: { limit: 20, status: 'running' },
      };
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: toolCall }] });
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }

    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: `bg multitool handled: ${parts?.map((part: any) => part.text || '').filter(Boolean).join(' | ') || ''}` }],
    });
    return { text: 'ok' };
  };

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const started = await tool_start_toolscript_run({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(started.status, 'waiting');
    assert.equal(started.waitingReason, 'managed_event');

    await sessionManager.queueSessionStructuredEvent(childId, [{ text: 'outside event' }], 'background');
    await new Promise(resolve => setTimeout(resolve, 50));

    const completed = await getToolScriptRunForTests(started.runId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.lastResult?.yieldReason, 'idle');
    assert.equal(completed?.lastResult?.releasedPendingInboxCount, 0);
    assert.equal(childChatCalls, 3);
    assert.equal(await managedSessions.getManagedSessionStateForTests(childId), undefined);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('list/get/cancel ToolScript run tools return structured run data', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_run_tools');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, 'answer = ask_agent("Need input")\nanswer');
  const session = await sessionManager.getSession(sessionId);

  try {
    const started = await tool_start_toolscript_run({ filePath: scriptName }, { sessionId, session });
    assert.equal(started.status, 'waiting');
    assert.equal(started.waitingReason, 'agent');
    assert.equal(started.mode, 'background');

    const listed = await tool_list_toolscript_runs({ limit: 10 }, { sessionId, session });
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0]?.runId, started.runId);
    assert.equal(listed.runs[0]?.waitingReason, 'agent');

    const fetched = await tool_get_toolscript_run({ runId: started.runId }, { sessionId, session });
    assert.equal(fetched.runId, started.runId);
    assert.equal(fetched.question, 'Need input');

    const cancelled = await tool_cancel_toolscript_run({ runId: started.runId }, { sessionId, session });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.cancelledAt);
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('ToolScript session_step rejects non-user message injection shapes', async () => {
  await resetToolScriptRunsForTests();
  const parentId = makeId('toolscript_manager_invalid_parent');
  const childId = makeId('toolscript_manager_invalid_child');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, [
    `lease = open_managed_session("${childId}")`,
    `session_step("${childId}", lease["leaseId"], lease["revision"], message={"role": "model", "parts": [{"text": "bad"}]})`,
  ].join('\n'));

  const parent = await sessionManager.getSession(parentId);
  await sessionManager.getSession(childId);

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId: parentId, session: parent });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /message\.role must be `user`/i);
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});
