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

test('handoff schemas expose only exact optional waitAfterHandoff booleans', () => {
  for (const name of ['send_to_session', 'create_child_session']) {
    const definition = definitions.find(item => item.name === name)!;
    assert.equal(definition.parameters.properties.waitAfterHandoff?.type, 'boolean');
    assert.equal(definition.parameters.required?.includes('waitAfterHandoff'), false);
    assert.equal(definition.parameters.properties.waitForReply, undefined);
    const description = definition.parameters.properties.waitAfterHandoff?.description || '';
    assert.match(description, /after a successful .*handoff, finish this turn and enter a generic any-event wait/i);
    assert.match(description, /replies are delivered normally whether this is true or false/i);
    assert.match(description, /not target-filtered or a completion wait/i);
  }
});

test('handoff runtime validates waitAfterHandoff and does not compatibility-read waitForReply', async () => {
  const sourceId = makeId('handoff_rename_source');
  const targetId = makeId('handoff_rename_target');
  const source = await resetSession(sourceId);
  await resetSession(targetId);
  try {
    await assert.rejects(
      () => tool_send_to_session({ sessionId: targetId, message: 'bad', waitAfterHandoff: 'yes' }, { sessionId: sourceId, session: source }),
      /waitAfterHandoff must be a boolean/i,
    );
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'bad', message: 'bad', waitAfterHandoff: 'yes' }, { sessionId: sourceId, session: source }),
      /waitAfterHandoff must be a boolean/i,
    );

    const legacySend: any = await tool_send_to_session(
      { sessionId: targetId, message: 'legacy name is ignored', waitForReply: true },
      { sessionId: sourceId, session: source },
    );
    assert.equal(typeof legacySend, 'string');

    const legacyCreate: any = await tool_create_child_session(
      { suffix: 'legacy', waitForReply: true },
      { sessionId: sourceId, session: source },
    );
    assert.equal(typeof legacyCreate, 'string');
    const [childId] = sessionManager.getChildSessionIds(sourceId);
    await sessionManager.deleteSession(childId).catch(() => false);
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
    const result: any = await tool_send_to_session({ sessionId: targetId, message: 'hello', waitAfterHandoff: true }, { sessionId: sourceId, session: source });
    assert.deepEqual(result.__toolPostAction, { waitForReply: true });
    assert.match(result.output, /Message sent/);

    await assert.rejects(
      () => tool_send_to_session({ sessionId: makeId('missing'), message: 'hello', waitAfterHandoff: true }, { sessionId: sourceId, session: source }),
      /not found/i,
    );
  } finally {
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await sessionManager.deleteSession(targetId).catch(() => false);
  }
});

test('create_child_session waitAfterHandoff validates initial message and awaits send success', async () => {
  const parentId = makeId('create_wait_parent');
  const parent = await resetSession(parentId);
  try {
    await assert.rejects(
      () => tool_create_child_session({ suffix: 'no-message', waitAfterHandoff: true }, { sessionId: parentId, session: parent }),
      /requires a non-empty initial message/i,
    );
    assert.deepEqual(sessionManager.getChildSessionIds(parentId), []);

    const result: any = await tool_create_child_session(
      { suffix: 'worker', message: 'do work', waitAfterHandoff: true },
      { sessionId: parentId, session: parent },
    );
    assert.deepEqual(result.__toolPostAction, { waitForReply: true });
    const [childId] = sessionManager.getChildSessionIds(parentId);
    assert.equal(typeof childId, 'string');
    const child = await sessionManager.getSession(childId);
    assert.equal(child.queue.length, 1);
    await sessionManager.deleteSession(childId).catch(() => false);
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
        { suffix: 'worker', message: 'do work', waitAfterHandoff: true },
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

test('router appends every result, arms flagged generic wait despite a sibling error, and stops without another LLM call', async () => {
  const sourceId = makeId('router_wait_source');
  const targetId = makeId('router_wait_target');
  const source = await resetSession(sourceId);
  const target = await resetSession(targetId);
  target.busy = true;
  const router = new MessageRouter() as any;
  router.turnRunner.continueWithQueuedWork = async () => false;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: MessagePart[] | null, active: Session) => {
    calls++;
    await appendStubUser(active, parts);
    const sendCall = { id: 'flagged-send', name: 'send_to_session', args: { sessionId: targetId, message: 'work', waitAfterHandoff: true } };
    const errorCall = { id: 'sibling-error', name: 'read', args: { filePath: `/missing-handoff-${Date.now()}` } };
    await appendStubModel(active, [{ functionCall: sendCall }, { functionCall: errorCall }]);
    return { text: '', toolCalls: [sendCall, errorCall] };
  };
  try {
    await router.turnRunner.runSessionTurn(sourceId, { parts: [{ text: 'handoff' }], session: source });
    assert.equal(calls, 1);
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
      const call = { id: 'fast-send', name: 'send_to_session', args: { sessionId: targetId, message: 'work', waitAfterHandoff: true } };
      await appendStubModel(active, [{ functionCall: call }]);
      return { text: '', toolCalls: [call] };
    }
    await appendStubModel(active, [{ text: 'reply consumed' }]);
    return { text: 'reply consumed' };
  };

  try {
    await router.turnRunner.runSessionTurn(sourceId, { parts: [{ text: 'handoff' }], session: source });
    assert.equal(calls, 2);
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
