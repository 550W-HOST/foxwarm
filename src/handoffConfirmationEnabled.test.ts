import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const recallPrefix = 'Before composing this inter-agent handoff, have I recalled the applicable communication rules, the user\'s actual request, and the scope this recipient needs?';
const confirmationPrefix = 'Before sending this inter-agent handoff, have I honestly checked that it is necessary, actionable, and not merely acknowledgement, duplication, or inherited-rule repetition; if I found that it should not be sent, did I omit or cancel it instead?';
const confirmationSuffix = 'I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.';
const recall = `${recallPrefix}\nI recalled the applicable communication rules, the user request, and the recipient scope for this test handoff.`;
const confirmation = `${confirmationPrefix}\nI checked that this enabled-mode handoff is necessary and actionable, not duplicate or inherited-rule acknowledgement, and that its message is useful to the recipient.\n${confirmationSuffix}`;

function envFor(dataRoot: string, configPath: string): NodeJS.ProcessEnv {
  return { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_CONFIG_PATH: configPath };
}

test('disabled startup config omits guidance and accepts ordinary handoffs without review fields', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-handoff-disabled-'));
  const configPath = path.join(dataRoot, 'state', 'config.yaml');
  await fs.outputFile(configPath, 'handoffConfirmation: false\n');
  const script = String.raw`
const assert = require('node:assert/strict');
const config = require('./lib/config');
const tools = require('./lib/tools');
const sessionManager = require('./lib/sessionManager');
const interSession = require('./lib/toolsSessionAgent/interSession');
const { tool_run_script } = require('./lib/toolscript');
const reminders = require('./lib/session/childSessionReminder');
(async () => {
  assert.equal(config.HANDOFF_CONFIRMATION_ENABLED, false);
  for (const name of ['send_to_session', 'create_child_session']) {
    const definition = tools.modelFacingDefinitions.find(item => item.name === name);
    assert.equal(definition.parameters.properties.handoffRecall, undefined);
    assert.equal(definition.parameters.properties.handoffConfirmation, undefined);
    assert.equal(definition.parameters.required.includes('handoffRecall'), false);
    assert.equal(definition.parameters.required.includes('handoffConfirmation'), false);
    assert.deepEqual(definition.parameters.properties.__cancelTool.enum, [true]);
  }
  assert.doesNotMatch(reminders.buildChildCompletionInstruction('parent/main'), /handoffRecall|handoffConfirmation/);
  assert.doesNotMatch(reminders.buildChildReminder('parent/main'), /handoffRecall|handoffConfirmation/);
  const sourceId = 'disabled-source-' + Date.now();
  const targetId = 'disabled-target-' + Date.now();
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.getSession(targetId);
  let childId;
  try {
    await interSession.tool_send_to_session({ sessionId: targetId, message: 'without review' }, { sessionId: sourceId, session: source });
    const created = await interSession.tool_create_child_session({ suffix: 'without-review' }, { sessionId: sourceId, session: source });
    childId = String(created.output || created).match(/\x60([^\x60]+)\x60/)?.[1];
    await tools.call_tool({ source: 'builtin', name: 'send_to_session', args: { sessionId: targetId, message: 'unified without review' } }, { sessionId: sourceId, session: source });
    const scriptResult = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":"' + targetId + '","message":"script without review"})' }, { sessionId: sourceId, session: source });
    assert.equal(scriptResult.status, 'completed');
  } finally {
    if (childId) await sessionManager.deleteSession(childId).catch(() => {});
    await sessionManager.deleteSession(targetId).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => {});
  }
  console.log('disabled-ok');
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], { cwd: process.cwd(), env: envFor(dataRoot, configPath), timeout: 30_000 });
    assert.match(stdout, /disabled-ok/);
  } finally {
    await fs.remove(dataRoot);
  }
});

test('enabled startup config enforces recall and confirmation schemas and runtime paths', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-handoff-enabled-'));
  const configPath = path.join(dataRoot, 'state', 'config.yaml');
  await fs.outputFile(configPath, 'handoffConfirmation: true\n');
  const script = String.raw`
const assert = require('node:assert/strict');
const config = require('./lib/config');
const tools = require('./lib/tools');
const llm = require('./lib/llm');
const sessionManager = require('./lib/sessionManager');
const interSession = require('./lib/toolsSessionAgent/interSession');
const controls = require('./lib/toolCallControls');
const { tool_run_script } = require('./lib/toolscript');
const { tool_search_tools } = require('./lib/tools/unifiedSearch');
(async () => {
  assert.equal(config.HANDOFF_CONFIRMATION_ENABLED, true);
  for (const name of ['send_to_session', 'create_child_session']) {
    const definition = tools.modelFacingDefinitions.find(item => item.name === name);
    const keys = Object.keys(definition.parameters.properties);
    assert(keys.indexOf('handoffRecall') < keys.indexOf('message'));
    assert.equal(keys.at(-3), 'handoffConfirmation');
    assert.equal(definition.parameters.required.includes('handoffRecall'), true);
    assert.equal(definition.parameters.required.includes('handoffConfirmation'), true);
    assert.deepEqual(definition.parameters.properties.__cancelTool.enum, [true]);
    assert.deepEqual(definition.parameters.properties.__cancelAllToolsThisTurn.enum, [true]);
  }
  const sourceId = 'enabled-source-' + Date.now();
  const targetId = 'enabled-target-' + Date.now();
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.getSession(targetId);
  try {
    await assert.rejects(() => interSession.tool_send_to_session({ sessionId: targetId, message: 'missing' }, { sessionId: sourceId, session: source }), /handoff recall/);
    await interSession.tool_send_to_session({ sessionId: targetId, handoffRecall: ${JSON.stringify(recall)}, message: 'valid', handoffConfirmation: ${JSON.stringify(confirmation)} }, { sessionId: sourceId, session: source });
    const targetAfterSend = await sessionManager.getSession(targetId);
    const targetQueueText = targetAfterSend.queue.flatMap(item => item.parts || []).map(part => part.text || part.system || '').join('\\n');
    assert.match(targetQueueText, /valid/);
    assert.doesNotMatch(targetQueueText, /handoffRecall|handoffConfirmation|Before composing this inter-agent handoff|Before sending this inter-agent handoff/);
    await assert.rejects(() => interSession.tool_create_child_session({ suffix: 'missing', handoffRecall: ${JSON.stringify(recall)}, handoffConfirmation: ${JSON.stringify(confirmation)}, message: 'late' }, { sessionId: sourceId, session: source }), /final argument property/);
    await assert.rejects(() => tools.call_tool({ source: 'builtin', name: 'send_to_session', args: { sessionId: targetId, message: 'missing unified' } }, { sessionId: sourceId, session: source }), /handoff recall/);
    const discovery = await tool_search_tools({ query: 'send_to_session', sources: ['builtin'], limit: 1, includeSchema: true }, { sessionId: sourceId, session: source });
    const declaration = discovery.output;
    assert(declaration.indexOf('handoffRecall') < declaration.indexOf('message'));
    assert(declaration.indexOf('handoffConfirmation') > declaration.indexOf('message'));
    assert.doesNotMatch(declaration, /__cancelTool|__cancelAllToolsThisTurn/);
    const canceled = await llm.executeTools([{ id: 'canceled', name: 'send_to_session', args: { sessionId: targetId, message: 'canceled', __cancelTool: true } }], { sessionId: sourceId, session: source }, source);
    assert.deepEqual(canceled.parts[0].functionResponse.response, { canceled: true, message: 'Tool call canceled before execution.' });
    const scriptResult = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":"' + targetId + '","message":"missing script"})' }, { sessionId: sourceId, session: source });
    assert.equal(scriptResult.status, 'failed');
    assert.match(String(scriptResult.error), /handoff recall/);
  } finally {
    await sessionManager.deleteSession(targetId).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => {});
  }
  console.log('enabled-ok');
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], { cwd: process.cwd(), env: envFor(dataRoot, configPath), timeout: 30_000 });
    assert.match(stdout, /enabled-ok/);
  } finally {
    await fs.remove(dataRoot);
  }
});

test('runtime startup rejects non-boolean handoff confirmation YAML through the canonical normalizer', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-handoff-invalid-'));
  const configPath = path.join(dataRoot, 'state', 'config.yaml');
  await fs.outputFile(configPath, 'handoffConfirmation: yes\n');
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, ['-e', "require('./lib/config')"], { cwd: process.cwd(), env: envFor(dataRoot, configPath), timeout: 10_000 }),
      (error: any) => /handoffConfirmation.*boolean/.test(String(error?.stderr || error?.message)),
    );
  } finally {
    await fs.remove(dataRoot);
  }
});
