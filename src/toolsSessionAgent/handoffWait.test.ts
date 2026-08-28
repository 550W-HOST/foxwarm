import assert from 'node:assert/strict';
import test from 'node:test';
import * as llm from '../llm';
import { MessageRouter } from '../messageRouter';
import * as sessionManager from '../sessionManager';
import { definitions } from '../tools';
import { tool_create_child_session, tool_send_to_session } from '../toolsSessionAgent';
import type { MessagePart, Session } from '../types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function resetSession(id: string, parentSessionId?: string): Promise<Session> {
  const session = await sessionManager.getSession(id) as Session;
  session.history = [];
  session.queue = [];
  session.busy = false;
  session.stopping = false;
  session.parentSessionId = parentSessionId;
  session.meta = { lastMessageTime: Date.now() };
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  await sessionManager.saveSession(id);
  return session;
}

async function appendStubUser(session: Session, parts: MessagePart[] | null): Promise<void> {
  if (parts) await sessionManager.appendSessionMessage(session, { role: 'user', parts });
}

async function appendStubModel(session: Session, parts: MessagePart[]): Promise<void> {
  await sessionManager.appendSessionMessage(session, { role: 'model', parts });
}

test('handoff schemas expose one exact optional afterSend behavior', () => {
  for (const name of ['send_to_session', 'create_child_session']) {
    const definition = definitions.find(item => item.name === name)!;
    assert.deepEqual(definition.parameters.properties.afterSend?.enum, ['continue', 'finish', 'wait']);
    assert.equal(definition.parameters.required?.includes('afterSend'), false);
    assert.equal(definition.parameters.properties.waitAfterHandoff, undefined);
    assert.equal(definition.parameters.properties.noFurtherAssistantReply, undefined);
    assert.equal(definition.parameters.properties.waitForReply, undefined);
    const description = definition.parameters.properties.afterSend?.description || '';
    assert.match(description, /continue/i);
    assert.match(description, /finish/i);
    assert.match(description, /wait/i);
  }
});

test('handoff runtime validates afterSend, preserves hidden legacy controls, and rejects conflicts', async () => {
  const sourceId = makeId('handoff_rename_source');
  const targetId = makeId('handoff_rename_target');
  const source = await resetSession(sourceId);
  await resetSession(targetId);
  try {
    await assert.rejects(
      () => tool_send_to_session({ sessionId: targetId, message: 'bad', afterSend: 'later' }, { sessionId: sourceId, session: source }),
      /afterSend must be one of/i,
    );
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'bad', message: 'bad', afterSend: 'later' }, { sessionId: sourceId, session: source }),
      /afterSend must be one of/i,
    );
    await assert.rejects(
      () => tool_send_to_session({ sessionId: targetId, message: 'bad legacy', waitAfterHandoff: 'yes' }, { sessionId: sourceId, session: source }),
      /waitAfterHandoff must be a boolean/i,
    );
    await assert.rejects(
      () => tool_send_to_session({ sessionId: targetId, message: 'conflict', afterSend: 'finish', waitAfterHandoff: true }, { sessionId: sourceId, session: source }),
      /cannot be combined with legacy/i,
    );
    const legacy: any = await tool_send_to_session(
      { sessionId: targetId, message: 'legacy wait', waitAfterHandoff: true },
      { sessionId: sourceId, session: source },
    );
    assert.equal(legacy.__toolPostAction.waitForReply, true);
    const legacyFinish: any = await tool_send_to_session(
      { sessionId: targetId, message: 'legacy finish', noFurtherAssistantReply: true },
      { sessionId: sourceId, session: source },
    );
    assert.equal(legacyFinish.__toolLoopControl.stopCurrentTurn, true);
    assert.deepEqual(legacyFinish.__toolPostAction, { finishAfterSend: true });

    await assert.rejects(() => tool_send_to_session(
      { sessionId: targetId, message: 'legacy name is rejected', waitForReply: true },
      { sessionId: sourceId, session: source },
    ), /unsupported argument.*waitForReply/i);
    await assert.rejects(() => tool_create_child_session(
      { suffix: 'legacy', waitForReply: true },
      { sessionId: sourceId, session: source },
    ), /unknown key: waitForReply/i);
  } finally {
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('send_to_session requests post-batch wait only after successful delivery', async () => {
  const sourceId = makeId('handoff_source');
  const targetId = makeId('handoff_target');
  const source = await resetSession(sourceId);
  await resetSession(targetId);
  try {
    const result: any = await tool_send_to_session({ sessionId: targetId, message: 'hello', afterSend: 'wait' }, { sessionId: sourceId, session: source });
    assert.deepEqual(result.__toolPostAction, { waitForReply: true, successfulSendToSessionTarget: targetId });
    assert.match(result.output, /Message sent/);

    await assert.rejects(
      () => tool_send_to_session({ sessionId: makeId('missing'), message: 'hello', afterSend: 'wait' }, { sessionId: sourceId, session: source }),
      /not found/i,
    );
  } finally {
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('create_child_session afterSend wait validates initial message and awaits send success', async () => {
  const parentId = makeId('create_wait_parent');
  const parent = await resetSession(parentId);
  try {
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'no-message', afterSend: 'wait' }, { sessionId: parentId, session: parent }),
      /requires a non-empty initial message/i,
    );
    assert.deepEqual(sessionManager.getChildSessionIds(parentId), []);

    const result: any = await tool_create_child_session(
      { suffix: 'worker', message: 'do work', afterSend: 'wait' },
      { sessionId: parentId, session: parent },
    );
    const [childId] = sessionManager.getChildSessionIds(parentId);
    assert.deepEqual(result.__toolPostAction, { waitForReply: true, successfulSendToSessionTarget: childId });
    assert.equal(typeof childId, 'string');
    const child = await sessionManager.getSession(childId);
    assert.equal(child.queue.length, 1);
    await sessionManager.deleteSession(childId).catch(() => false);

    const finish: any = await tool_create_child_session(
      { suffix: 'fire-and-finish', message: 'start independently', afterSend: 'finish' },
      { sessionId: parentId, session: parent },
    );
    assert.equal(finish.__toolLoopControl?.stopCurrentTurn, true);
    assert.deepEqual(finish.__toolPostAction, { finishAfterSend: true });
    const [finishChildId] = sessionManager.getChildSessionIds(parentId);
    const finishChild = await sessionManager.getSession(finishChildId);
    assert.equal(finishChild.queue.length, 1);
    await sessionManager.deleteSession(finishChildId).catch(() => false);
  } finally {
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('create_child_session send failure returns no wait request', async () => {
  const parentId = makeId('create_send_failure_parent');
  const parent = await resetSession(parentId);
  const originalSend = sessionManager.sendToSession;
  (sessionManager as any).sendToSession = async () => { throw new Error('injected initial send failure'); };
  try {
    await assert.rejects(
      () => tool_create_child_session(
        { suffix: 'worker', message: 'do work', afterSend: 'wait' },
        { sessionId: parentId, session: parent },
      ),
      /injected initial send failure/,
    );
    const [childId] = sessionManager.getChildSessionIds(parentId);
    assert.equal(typeof childId, 'string');
    assert.notEqual(await sessionManager.getExistingSession(childId), null);
    await sessionManager.deleteSession(childId).catch(() => false);
  } finally {
    (sessionManager as any).sendToSession = originalSend;
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('router appends every result, arms flagged activity wait despite a sibling error, and stops without another LLM call', async () => {
  const sourceId = makeId('router_wait_source');
  const targetId = makeId('router_wait_target');
  const source = await resetSession(sourceId);
  const target = await resetSession(targetId);
  target.busy = true;
  const router = new MessageRouter() as any;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    const sendCall = { id: 'flagged-send', name: 'send_to_session', args: { sessionId: targetId, message: 'work', afterSend: 'wait' } };
    const errorCall = { id: 'sibling-error', name: 'read', args: { filePath: `/missing-handoff-${Date.now()}` } };
    await appendStubModel(active, [{ functionCall: sendCall }, { functionCall: errorCall }]);
    return { text: '', toolCalls: [sendCall, errorCall] };
  };
  try {
    source.queue.push({ type: 'user', parts: [{ text: 'handoff' }] });
    await sessionManager.saveSession(sourceId);
    await router.processSessionQueue(sourceId);
    assert.equal(calls, 1);
    assert.equal(source.busy, false);
    assert.equal(typeof source.meta.wait?.id, 'string');
    assert.equal(source.history[source.history.length - 1].role, 'tool');
    assert.equal(source.history[source.history.length - 1].parts.length, 2);
    assert.equal(target.queue.length, 1);
  } finally {
    (llm as any).chat = originalChat;
    target.busy = false;
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('completed child report finishes idle without arming a wait or another LLM call', async () => {
  const parentId = makeId('finish_parent');
  const childId = makeId('finish_child');
  const parent = await resetSession(parentId);
  const child = await resetSession(childId, parentId);
  child.childHandoffState = { boundary: 'report-required', resolved: false };
  parent.busy = true;
  await sessionManager.saveSession(childId);
  const router = new MessageRouter() as any;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    const report = { id: 'final-report', name: 'send_to_session', args: { sessionId: parentId, message: 'done', afterSend: 'finish' } };
    await appendStubModel(active, [{ functionCall: report }]);
    return { text: '', toolCalls: [report] };
  };
  try {
    child.queue.push({ type: 'user', parts: [{ text: 'complete the task' }] });
    await sessionManager.saveSession(childId);
    await router.processSessionQueue(childId);
    assert.equal(calls, 1);
    assert.equal(child.busy, false);
    assert.equal(child.meta.wait, undefined);
    assert.equal(child.childHandoffState?.resolved, true);
    assert.equal(child.history.at(-1)?.role, 'tool');
    assert.equal(parent.queue.length, 1);
  } finally {
    (llm as any).chat = originalChat;
    parent.busy = false;
    await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(parentId).catch(() => false);
  }
});

test('afterSend finish remains terminal after a sibling error and appends the complete tool batch once', async () => {
  const sourceId = makeId('finish_error_source');
  const targetId = makeId('finish_error_target');
  const source = await resetSession(sourceId);
  const target = await resetSession(targetId);
  target.busy = true;
  const router = new MessageRouter() as any;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    const finishCall = { id: 'finish-send', name: 'send_to_session', args: { sessionId: targetId, message: 'done', afterSend: 'finish' } };
    const errorCall = { id: 'finish-sibling-error', name: 'read', args: { filePath: `/missing-finish-${Date.now()}` } };
    await appendStubModel(active, [{ functionCall: finishCall }, { functionCall: errorCall }]);
    return { text: '', toolCalls: [finishCall, errorCall] };
  };
  try {
    source.queue.push({ type: 'user', parts: [{ text: 'finish after delivery' }] });
    await sessionManager.saveSession(sourceId);
    await router.processSessionQueue(sourceId);
    assert.equal(calls, 1);
    assert.equal(source.busy, false);
    assert.equal(source.meta.wait, undefined);
    assert.equal(target.queue.length, 1);
    assert.equal(source.history.filter(message => message.role === 'model').length, 1);
    const toolMessage = source.history.at(-1)!;
    assert.equal(toolMessage.role, 'tool');
    assert.deepEqual(toolMessage.parts.map(part => part.functionResponse?.name), ['send_to_session', 'read']);
    assert.equal(toolMessage.parts[0].functionResponse?.response?.error, undefined);
    assert.notEqual(toolMessage.parts[1].functionResponse?.response?.error, undefined);
  } finally {
    (llm as any).chat = originalChat;
    target.busy = false;
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('fast reply queued before wait arm wakes immediately after the flagged handoff stops', async () => {
  const sourceId = makeId('fast_reply_source');
  const targetId = makeId('fast_reply_target');
  const source = await resetSession(sourceId);
  const target = await resetSession(targetId);
  target.busy = true;
  const router = new MessageRouter() as any;
  const originalChat = llm.chat;
  const originalSend = sessionManager.sendToSession;
  let calls = 0;

  (sessionManager as any).sendToSession = async (sessionId: string, message: string, fromSessionId?: string) => {
    const result = await originalSend(sessionId, message, fromSessionId);
    if (sessionId === targetId) {
      await originalSend(sourceId, 'fast reply', targetId);
    }
    return result;
  };
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    if (calls === 1) {
      const call = { id: 'fast-send', name: 'send_to_session', args: { sessionId: targetId, message: 'work', afterSend: 'wait' } };
      await appendStubModel(active, [{ functionCall: call }]);
      return { text: '', toolCalls: [call] };
    }
    await appendStubModel(active, [{ text: 'reply consumed' }]);
    return { text: 'reply consumed' };
  };

  try {
    source.queue.push({ type: 'user', parts: [{ text: 'handoff' }] });
    await sessionManager.saveSession(sourceId);
    await router.processSessionQueue(sourceId);
    assert.equal(calls, 2);
    assert.equal(source.busy, false);
    assert.equal(source.meta.wait, undefined);
    const toolIndex = source.history.findIndex(message => message.role === 'tool');
    const fastReplyIndex = source.history.findIndex(message => message.role === 'user' && message.parts.some(part => String(part.system || part.text || '').includes('fast reply')));
    assert(toolIndex >= 0 && fastReplyIndex > toolIndex);
  } finally {
    (llm as any).chat = originalChat;
    (sessionManager as any).sendToSession = originalSend;
    target.busy = false;
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('handoff wait aggregates only successful flagged resolved targets across mixed send/create batches', async () => {
  const sourceId = makeId('mixed_handoff_source');
  const flaggedId = makeId('mixed_handoff_flagged');
  const ordinaryId = makeId('mixed_handoff_ordinary');
  const source = await resetSession(sourceId);
  const flagged = await resetSession(flaggedId); flagged.busy = true;
  const ordinary = await resetSession(ordinaryId); ordinary.busy = true;
  const router = new MessageRouter() as any;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    const toolCalls = [
      { id: 'ordinary-first', name: 'send_to_session', args: { sessionId: ordinaryId, message: 'ordinary' } },
      { id: 'flagged-send', name: 'send_to_session', args: { sessionId: flaggedId, message: 'flagged', afterSend: 'wait' } },
      { id: 'flagged-create', name: 'create_child_session', args: { suffix: 'worker', message: 'created flagged', afterSend: 'wait' } },
      { id: 'failed-flagged', name: 'send_to_session', args: { sessionId: makeId('missing'), message: 'fails', afterSend: 'wait' } },
    ];
    await appendStubModel(active, toolCalls.map(functionCall => ({ functionCall })));
    return { text: '', toolCalls };
  };
  try {
    source.queue.push({ type: 'user', parts: [{ text: 'mixed handoff' }] });
    await sessionManager.saveSession(sourceId);
    await router.processSessionQueue(sourceId);
    const childId = `${sourceId}_worker`;
    assert.equal(calls, 1);
    assert.deepEqual(new Set(source.meta.wait?.waitAnySessions), new Set([flaggedId, childId]));
    assert.equal(source.meta.wait?.waitAnySessions?.includes(ordinaryId), false);
    await sessionManager.deleteSession(childId).catch(() => false);
  } finally {
    (llm as any).chat = originalChat;
    flagged.busy = false; ordinary.busy = false;
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(flaggedId).catch(() => false);
    await sessionManager.deleteSession(ordinaryId).catch(() => false);
  }
});
