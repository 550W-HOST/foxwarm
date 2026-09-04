import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { executeTools } from './llm';
import * as sessionManager from './sessionManager';
import { call_tool, modelFacingDefinitions } from './tools';
import { tool_create_child_session, tool_send_to_session } from './toolsSessionAgent/interSession';
import { tool_run_script } from './toolscript';
import {
  INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX,
  INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER,
  INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX,
  validateInterAgentHandoffConfirmation,
} from './toolCallControls';
import type { FunctionCall, Session } from './types';

function unique(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function confirmation(review = 'The handoff is necessary, accurate, self-contained, scoped to the target, and follows the communication rules.'): string {
  return `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n${review}\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`;
}

function responses(message: any): any[] {
  return message.parts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse.response);
}

async function makeSession(id: string, cwd?: string): Promise<Session> {
  const session = await sessionManager.getSession(id) as Session;
  session.currentNode = 'master';
  session.cwd = cwd;
  session.verbose = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  await sessionManager.saveSession(id);
  return session;
}

test('ordinary model-facing schemas append cancellation controls and keep handoff confirmation before them', () => {
  const compact = modelFacingDefinitions.find(definition => definition.name === 'submit_compact_plan')!;
  assert.equal(compact.parameters.properties.__cancelTool, undefined);
  assert.equal(compact.parameters.properties.__cancelAllToolsThisTurn, undefined);

  for (const definition of modelFacingDefinitions.filter(item => item.name !== 'submit_compact_plan')) {
    const keys = Object.keys(definition.parameters.properties);
    assert.deepEqual(keys.slice(-2), ['__cancelTool', '__cancelAllToolsThisTurn']);
    assert.deepEqual(definition.parameters.properties.__cancelTool.enum, [true]);
    assert.deepEqual(definition.parameters.properties.__cancelAllToolsThisTurn.enum, [true]);
  }

  for (const name of ['create_child_session', 'send_to_session']) {
    const definition = modelFacingDefinitions.find(item => item.name === name)!;
    const keys = Object.keys(definition.parameters.properties);
    assert.equal(keys.at(-3), 'confirmation');
    assert(definition.parameters.required?.includes('confirmation'));
    assert.match(String(definition.parameters.properties.confirmation.description), /do not copy this placeholder verbatim/);
  }
});

test('a later whole-batch cancellation blocks an earlier exec without resolving or starting calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-cancel-all-'));
  const marker = path.join(root, 'marker');
  const sessionId = unique('cancel_all');
  const session = await makeSession(sessionId, root);
  const starts: string[] = [];
  try {
    const result = await executeTools([
      { id: 'danger', name: 'exec', args: { command: `touch ${JSON.stringify(marker)}` } },
      { id: 'cancel', name: 'not_a_real_tool', args: { __cancelAllToolsThisTurn: true } },
    ], { sessionId, session, onToolStart: ({ name }: any) => starts.push(name) }, session);
    assert.equal(await fs.pathExists(marker), false);
    assert.deepEqual(starts, []);
    assert.deepEqual(responses(result), [
      { canceled: true, message: 'Tool call canceled before execution.' },
      { canceled: true, message: 'Tool call canceled before execution.' },
    ]);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('single-call cancellation skips only that call and strips controls before sibling execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-cancel-one-'));
  const canceledMarker = path.join(root, 'canceled');
  const siblingMarker = path.join(root, 'sibling');
  const sessionId = unique('cancel_one');
  const session = await makeSession(sessionId, root);
  const starts: string[] = [];
  try {
    const result = await executeTools([
      { id: 'cancel', name: 'exec', args: { command: `touch ${JSON.stringify(canceledMarker)}`, __cancelTool: true } },
      { id: 'sibling', name: 'exec', args: { command: `touch ${JSON.stringify(siblingMarker)}` } },
    ], { sessionId, session, onToolStart: ({ name }: any) => starts.push(name) }, session);
    assert.equal(await fs.pathExists(canceledMarker), false);
    assert.equal(await fs.pathExists(siblingMarker), true);
    assert.deepEqual(starts, ['exec']);
    assert.equal(responses(result)[0].canceled, true);
    assert.match(responses(result)[1].output, /Exit code: 0/);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('wrong reserved control values fail only that call while siblings still execute', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-cancel-invalid-'));
  const marker = path.join(root, 'sibling');
  const sessionId = unique('cancel_invalid');
  const session = await makeSession(sessionId, root);
  try {
    const result = await executeTools([
      { id: 'invalid', name: 'not_a_real_tool', args: { __cancelTool: false } },
      { id: 'sibling', name: 'exec', args: { command: `touch ${JSON.stringify(marker)}` } },
    ], { sessionId, session }, session);
    assert.equal(responses(result)[0].error.type, 'invalid_tool_control_argument');
    assert.equal(await fs.pathExists(marker), true);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('handoff preflight errors skip only that call while a sibling still executes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-confirm-invalid-'));
  const marker = path.join(root, 'sibling');
  const sessionId = unique('confirm_invalid');
  const session = await makeSession(sessionId, root);
  const starts: string[] = [];
  try {
    const result = await executeTools([
      { id: 'invalid-handoff', name: 'send_to_session', args: { sessionId: 'missing', message: 'no confirmation' } },
      { id: 'sibling', name: 'exec', args: { command: `touch ${JSON.stringify(marker)}` } },
    ], { sessionId, session, onToolStart: ({ name }: any) => starts.push(name) }, session);
    assert.equal(responses(result)[0].error.type, 'invalid_inter_agent_handoff_confirmation');
    assert.equal(await fs.pathExists(marker), true);
    assert.deepEqual(starts, ['exec']);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('the same cancellation preflight works with an authoritative Session-worker owner', async () => {
  const sessionId = unique('cancel_worker');
  const session = await makeSession(sessionId);
  try {
    const result = await executeTools([
      { id: 'worker-cancel', name: 'not_a_real_tool', args: { __cancelTool: true } },
    ], { sessionId, session }, session, {
      currentSessionEffects: {
        placement: 'session-worker',
        persistSession: async () => {},
      } as any,
    });
    assert.deepEqual(responses(result), [{ canceled: true, message: 'Tool call canceled before execution.' }]);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('handoff confirmation validates exact framing, non-empty review, and final-property placement', () => {
  const valid = { sessionId: 'target', message: 'hello', confirmation: confirmation() };
  assert.doesNotThrow(() => validateInterAgentHandoffConfirmation(valid));
  assert.throws(() => validateInterAgentHandoffConfirmation({ sessionId: 'target', message: 'hello' }), /prefix and suffix/);
  assert.throws(() => validateInterAgentHandoffConfirmation({ ...valid, confirmation: `wrong\nreview\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}` }), /prefix and suffix/);
  assert.throws(() => validateInterAgentHandoffConfirmation({ ...valid, confirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\nreview\nwrong` }), /prefix and suffix/);
  assert.throws(() => validateInterAgentHandoffConfirmation({ ...valid, confirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n \n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}` }), /non-empty/);
  assert.throws(() => validateInterAgentHandoffConfirmation({ ...valid, confirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n${INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER}\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}` }), /replace the documented placeholder/);
  assert.throws(() => validateInterAgentHandoffConfirmation({ confirmation: confirmation(), sessionId: 'target', message: 'hello' }), /final argument property/);
});

test('direct handoff handlers require confirmation, including child creation without a message', async () => {
  const parentId = unique('confirm_parent');
  const targetId = unique('confirm_target');
  const parent = await makeSession(parentId);
  await makeSession(targetId);
  let childId: string | undefined;
  try {
    await assert.rejects(() => tool_send_to_session({ sessionId: targetId, message: 'hello' }, { sessionId: parentId, session: parent }), /prefix and suffix/);
    const sendResult: any = await tool_send_to_session({ sessionId: targetId, message: 'hello', confirmation: confirmation() }, { sessionId: parentId, session: parent });
    assert.match(typeof sendResult === 'string' ? sendResult : sendResult.output, /Message sent/);

    await assert.rejects(() => tool_create_child_session({ suffix: 'missing' }, { sessionId: parentId, session: parent }), /prefix and suffix/);
    const createResult: any = await tool_create_child_session({ suffix: 'confirmed', confirmation: confirmation() }, { sessionId: parentId, session: parent });
    const output = typeof createResult === 'string' ? createResult : createResult.output;
    childId = output.match(/`([^`]+)`/)?.[1];
    assert.match(output, /Child session created/);
  } finally {
    if (childId) await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('a canceled handoff bypasses confirmation checks and still produces a paired tool response', async () => {
  const sessionId = unique('cancel_handoff');
  const session = await makeSession(sessionId);
  try {
    const call: FunctionCall = { id: 'send-canceled', name: 'send_to_session', args: { sessionId: 'missing', message: 'bad', __cancelTool: true } };
    const result = await executeTools([call], { sessionId, session }, session);
    assert.equal(result.parts.length, 1);
    assert.equal(result.parts[0].functionResponse?.tool_use_id, call.id);
    assert.deepEqual(result.parts[0].functionResponse?.response, { canceled: true, message: 'Tool call canceled before execution.' });
    assert.equal((result as any).__toolLoopControl, undefined);
    assert.equal((result as any).__toolPostAction, undefined);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('unified and ToolScript handoffs reuse the direct confirmation guard', async () => {
  const sourceId = unique('confirm_nested_source');
  const targetId = unique('confirm_nested_target');
  const source = await makeSession(sourceId);
  await makeSession(targetId);
  try {
    await assert.rejects(() => call_tool({
      source: 'builtin',
      name: 'send_to_session',
      args: { sessionId: targetId, message: 'missing confirmation' },
    }, { sessionId: sourceId, session: source }), /prefix and suffix/);

    const unified: any = await call_tool({
      source: 'builtin',
      name: 'send_to_session',
      args: { sessionId: targetId, message: 'confirmed unified', confirmation: confirmation() },
    }, { sessionId: sourceId, session: source });
    assert.match(String(unified?.output ?? unified), /Message sent/);

    await assert.rejects(() => call_tool({
      source: 'builtin',
      name: 'send_to_session',
      args: { sessionId: targetId, message: 'nested control is concrete payload', __cancelTool: true, confirmation: confirmation() },
    }, { sessionId: sourceId, session: source }), /unsupported argument.*__cancelTool/);

    const missing = await tool_run_script({
      code: `def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":${JSON.stringify(targetId)},"message":"missing script confirmation"})`,
    }, { sessionId: sourceId, session: source });
    assert.equal(missing.status, 'failed');
    assert.match(String(missing.error), /prefix and suffix/);

    const confirmed = await tool_run_script({
      code: `def main(args):\n    return call_tool(source="builtin", name="send_to_session", args={"sessionId":${JSON.stringify(targetId)},"message":"confirmed script","confirmation":${JSON.stringify(confirmation())}})`,
    }, { sessionId: sourceId, session: source });
    assert.equal(confirmed.status, 'completed');
    assert.match(String((confirmed.result as any)?.output ?? confirmed.result), /Message sent/);
  } finally {
    await sessionManager.deleteSession(targetId).catch(() => false);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});
