import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';

import { executeTools } from './llm';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';
import { tool_continue_script, tool_run_script, getToolScriptRunForTests, resetToolScriptRunsForTests } from './toolscript';

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

test('request_model_without_context uses an empty transient session and no tools', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_model');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, 'request_model_without_context("ping")');

  const session = await sessionManager.getSession(sessionId);
  const originalChat = llm.chat;
  let captured: { historyLength?: number; snapshot?: string; toolDefinitionsLength?: number; inputText?: string } = {};

  (llm as any).chat = async (parts: any, transientSession: any, _iteration: number, options: any) => {
    captured = {
      historyLength: transientSession.history.length,
      snapshot: transientSession.persistentMemorySnapshot,
      toolDefinitionsLength: Array.isArray(options?.toolDefinitions) ? options.toolDefinitions.length : -1,
      inputText: Array.isArray(parts) ? parts.map((part: any) => part.text || '').join('\n') : '',
    };
    if (options?.appendMessage) {
      await options.appendMessage({ role: 'user', parts });
      await options.appendMessage({ role: 'model', parts: [{ text: 'pong' }] });
    }
    return { text: 'pong', toolCalls: [] as any[] };
  };

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { text: 'pong' });
    assert.equal(captured.historyLength, 0);
    assert.equal((captured.snapshot || '').trim(), '');
    assert.equal(captured.toolDefinitionsLength, 0);
    assert.equal(captured.inputText, 'ping');
  } finally {
    (llm as any).chat = originalChat;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});
