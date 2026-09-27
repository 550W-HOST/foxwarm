import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('disabled startup config omits guidance and accepts direct, unified, and ToolScript handoffs without confirmation', async () => {
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
    assert.equal(definition.parameters.properties.confirmation, undefined);
    assert.equal(definition.parameters.required.includes('confirmation'), false);
    assert.deepEqual(definition.parameters.properties.__cancelTool.enum, [true]);
  }
  assert.doesNotMatch(reminders.buildChildCompletionInstruction('parent/main'), /confirmation/);
  assert.doesNotMatch(reminders.buildChildReminder('parent/main'), /confirmation/);
  const sourceId = 'disabled-source-' + Date.now();
  const targetId = 'disabled-target-' + Date.now();
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.getSession(targetId);
  let childId;
  try {
    await interSession.tool_send_to_session({ sessionId: targetId, message: 'without confirmation' }, { sessionId: sourceId, session: source });
    await interSession.tool_send_to_session({ confirmation: 'malformed but ignored', sessionId: targetId, message: 'ignored confirmation' }, { sessionId: sourceId, session: source });
    const created = await interSession.tool_create_child_session({ suffix: 'without-confirmation' }, { sessionId: sourceId, session: source });
    childId = String(created.output || created).match(/\x60([^\x60]+)\x60/)?.[1];
    await tools.call_tool({ source: 'builtin', name: 'send_to_session', args: { sessionId: targetId, message: 'unified without confirmation' } }, { sessionId: sourceId, session: source });
    const scriptResult = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":"' + targetId + '","message":"script without confirmation"})' }, { sessionId: sourceId, session: source });
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
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_CONFIG_PATH: configPath },
      timeout: 30_000,
    });
    assert.match(stdout, /disabled-ok/);
  } finally {
    await fs.remove(dataRoot);
  }
});

test('enabled startup config enforces schemas and direct, unified, and ToolScript handoffs', async () => {
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
    assert.equal(keys.at(-3), 'confirmation');
    assert.equal(definition.parameters.required.includes('confirmation'), true);
    assert.deepEqual(definition.parameters.properties.__cancelTool.enum, [true]);
    assert.deepEqual(definition.parameters.properties.__cancelAllToolsThisTurn.enum, [true]);
  }
  const sourceId = 'enabled-source-' + Date.now();
  const targetId = 'enabled-target-' + Date.now();
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.getSession(targetId);
  const confirmation = controls.INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX + '\nI checked this enabled-mode test handoff for target, scope, content, and communication rules.\n' + controls.INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX;
  try {
    await assert.rejects(() => interSession.tool_send_to_session({ sessionId: targetId, message: 'missing' }, { sessionId: sourceId, session: source }), /prefix and suffix/);
    await interSession.tool_send_to_session({ sessionId: targetId, message: 'valid', confirmation }, { sessionId: sourceId, session: source });
    await assert.rejects(() => interSession.tool_create_child_session({ suffix: 'missing' }, { sessionId: sourceId, session: source }), /prefix and suffix/);
    await assert.rejects(() => tools.call_tool({ source: 'builtin', name: 'send_to_session', args: { sessionId: targetId, message: 'missing unified' } }, { sessionId: sourceId, session: source }), /prefix and suffix/);
    const discovery = await tool_search_tools({ query: 'send_to_session', sources: ['builtin'], limit: 1, includeSchema: true }, { sessionId: sourceId, session: source });
    const declaration = discovery.output;
    const afterSendIndex = declaration.indexOf('afterSend?:');
    const confirmationIndex = declaration.indexOf('confirmation:');
    assert(afterSendIndex >= 0 && confirmationIndex > afterSendIndex, declaration);
    assert.doesNotMatch(declaration, /__cancelTool|__cancelAllToolsThisTurn/);
    const canceled = await llm.executeTools([{ id: 'canceled', name: 'send_to_session', args: { sessionId: targetId, message: 'canceled', __cancelTool: true } }], { sessionId: sourceId, session: source }, source);
    assert.deepEqual(canceled.parts[0].functionResponse.response, { canceled: true, message: 'Tool call canceled before execution.' });
    const scriptResult = await tool_run_script({ code: 'def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":"' + targetId + '","message":"missing script"})' }, { sessionId: sourceId, session: source });
    assert.equal(scriptResult.status, 'failed');
    assert.match(String(scriptResult.error), /prefix and suffix/);
  } finally {
    await sessionManager.deleteSession(targetId).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => {});
  }
  console.log('enabled-ok');
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`;
  try {
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_CONFIG_PATH: configPath },
      timeout: 30_000,
    });
    assert.match(stdout, /enabled-ok/);
  } finally {
    await fs.remove(dataRoot);
  }
});

test('enabled startup config preserves Main and Session-worker handoff parity', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-handoff-enabled-worker-'));
  const configPath = path.join(dataRoot, 'state', 'config.yaml');
  await fs.outputFile(configPath, 'handoffConfirmation: true\n');
  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_CONFIG_PATH: configPath };
    delete childEnv.NODE_TEST_CONTEXT;
    const { stdout } = await execFileAsync(process.execPath, ['--test', 'lib/sessionWorkerCrossSession.test.js'], {
      cwd: process.cwd(),
      env: childEnv,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /pass 3/);
    assert.match(stdout, /fail 0/);
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
      () => execFileAsync(process.execPath, ['-e', "require('./lib/config')"], {
        cwd: process.cwd(),
        env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_CONFIG_PATH: configPath },
        timeout: 10_000,
      }),
      (error: any) => /handoffConfirmation.*boolean/.test(String(error?.stderr || error?.message)),
    );
  } finally {
    await fs.remove(dataRoot);
  }
});
