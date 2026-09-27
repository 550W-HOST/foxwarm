const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const sessionManager = require('../lib/sessionManager');
const { executeTools } = require('../lib/llm');
const { tool_run_script, tool_continue_script } = require('../lib/toolscript');
const { getAgentDir } = require('../lib/config');

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function writeScript(fileName, content) {
  const fullPath = path.join(getAgentDir('main'), fileName);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}

function asMain(lines) {
  return ['def main(args):', ...lines.map(line => `    ${line}`)].join('\n');
}

async function main() {
  await sessionManager.loadSessions();

  const completedScript = `${makeId('toolscript_completed')}.py`;
  const askAgentScript = `${makeId('toolscript_ask_agent')}.py`;
  const requestModelScript = `${makeId('toolscript_request_model')}.py`;

  await writeScript(completedScript, asMain([
    'print("phase1-start")',
    'res = call_tool("search_tools", {"query": "read file", "sources": ["builtin"], "limit": 3, "includeSchema": False})',
    'print(res["output"].splitlines()[0])',
    'return {"status": "done", "output": res["output"]}',
  ]));

  await writeScript(askAgentScript, asMain([
    'print("before-question")',
    'answer = ask_agent("Reply with EXACT_SMOKE_ANSWER")',
    'print(answer)',
    'return {"answer": answer}',
  ]));

  await writeScript(requestModelScript, asMain([
    'res = request_model_without_context("Reply with exactly TOOLSCRIPT_MODEL_OK")',
    'print(res["text"])',
    'return res',
  ]));

  const sessionId = makeId('toolscript_live_smoke');
  const session = await sessionManager.getSession(sessionId);

  const fakeModelMessage = {
    role: 'model',
    parts: [{
      functionCall: {
        id: 'run-script-live-1',
        name: 'run_script',
        args: { filePath: completedScript },
      },
    }],
  };
  await sessionManager.appendSessionMessage(session, fakeModelMessage);
  const toolMessage = await executeTools([
    { id: 'run-script-live-1', name: 'run_script', args: { filePath: completedScript } },
  ], { sessionId, session }, session);
  await sessionManager.appendSessionMessage(session, toolMessage);

  const completedResponse = toolMessage.parts[0].functionResponse.response;
  assert.equal(completedResponse.status, 'completed');
  assert.match(completedResponse.stdout, /^phase1-start\nShowing 3 of \d+ matching tools\.\n$/);
  assert.deepEqual(completedResponse.executedTools, ['search_tools']);

  const persistedAfterCompleted = await sessionManager.getExistingSession(sessionId);
  const historyRoles = persistedAfterCompleted.history.map((m) => m.role);
  assert.deepEqual(historyRoles, ['model', 'tool']);
  const historyJson = JSON.stringify(persistedAfterCompleted.history);
  assert.ok(!historyJson.includes('functionResponse":{"tool_use_id":"call_'), 'nested internal tool responses should not be persisted in session history');
  assert.ok(!historyJson.includes('"name":"search_tools","args"'), 'internal search_tools functionCall should not be persisted in session history');

  const paused = await tool_run_script({ filePath: askAgentScript }, { sessionId, session });
  assert.equal(paused.status, 'waiting');
  assert.equal(paused.waitingReason, 'agent');
  assert.equal(paused.question, 'Reply with EXACT_SMOKE_ANSWER');
  assert.equal(paused.stdout, 'before-question\n');

  const resumed = await tool_continue_script({
    runId: paused.runId,
    continuationId: paused.continuationId,
    input: 'EXACT_SMOKE_ANSWER',
  }, { sessionId, session });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.result, { answer: 'EXACT_SMOKE_ANSWER' });
  assert.equal(resumed.stdout, 'EXACT_SMOKE_ANSWER\n');

  const requestModelResult = await tool_run_script({ filePath: requestModelScript }, { sessionId, session });

  const output = {
    completed: {
      status: completedResponse.status,
      stdout: completedResponse.stdout,
      executedTools: completedResponse.executedTools,
      result: completedResponse.result,
      persistedHistoryRoles: historyRoles,
    },
    askAgent: {
      waitingStatus: paused.status,
      question: paused.question,
      resumedStatus: resumed.status,
      resumedResult: resumed.result,
    },
    requestModelWithoutContext: {
      status: requestModelResult.status,
      stdout: requestModelResult.stdout,
      result: requestModelResult.result,
      error: requestModelResult.error || null,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
