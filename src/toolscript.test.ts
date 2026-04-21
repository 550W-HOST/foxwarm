import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';

import { executeTools } from './llm';
import * as llm from './llm';
import { MessageRouter } from './messageRouter';
import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';
import { tool_continue_script, tool_run_script, getToolScriptRunForTests, resetToolScriptRunsForTests } from './toolscript';
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
    assert.equal(paused.status, 'paused_for_agent');
    assert.equal(paused.question, 'What now?');
    assert.ok(paused.runId);
    assert.ok(paused.continuationId);
    assert.equal(paused.stdout, 'before\n');
    assert.deepEqual(paused.executedTools, []);

    const persisted = await getToolScriptRunForTests(paused.runId);
    assert.equal(persisted?.status, 'paused_for_agent');
    assert.equal(persisted?.pendingQuestion, 'What now?');
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
