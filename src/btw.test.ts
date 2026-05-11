import test from 'node:test';
import assert from 'node:assert/strict';
import * as llm from './llm';
import { runBtwRequest, BTW_USAGE } from './btw';
import { COMMANDS } from './commands';
import * as sessionManager from './sessionManager';
import * as tools from './tools';
import * as vector from './vector';
import type { Message, MessagePart, Session } from './types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: any) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for condition');
}

async function createTestSession(sessionId: string): Promise<Session> {
  await sessionManager.createSession(sessionId, {
    id: sessionId,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: 'test system prompt',
    stats: {
      totalCachedTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastUsage: null,
    },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    vectorIndexPosition: 0,
    nextMessageSeq: 1,
    currentNode: 'master',
  });
  const session = await sessionManager.getSession(sessionId);
  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts: [{ text: 'original real history message' }],
  });
  return session;
}

async function appendTempConversation(activeSession: Session, parts: MessagePart[] | null, text: string, options?: { appendMessage?: (message: Message) => Promise<void> }): Promise<void> {
  if (parts) {
    await options?.appendMessage?.({ role: 'user', parts });
  }
  await options?.appendMessage?.({ role: 'model', parts: [{ text }] });
}

test('/btw command returns usage without a message', async () => {
  const replies: string[] = [];

  await COMMANDS['/btw'].handler(
    { reply: (text: string) => { replies.push(String(text)); } } as any,
    [],
    'btw_usage_session',
    { id: 'btw_usage_session' } as any,
  );

  assert.deepEqual(replies, [BTW_USAGE]);
});

test('/btw command acks immediately and broadcasts async text result without mutating real history', async () => {
  const originalChat = llm.chat;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const sessionId = makeId('btw_async');
  const chatGate = makeDeferred<void>();
  const chatStarted = makeDeferred<void>();
  const toolNamesBefore = tools.modelFacingDefinitions.map(def => def.name);
  let tempHistoryAtCall: Message[] = [];
  let requestPartsAtCall: MessagePart[] | null = null;

  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  try {
    const session = await createTestSession(sessionId);
    const originalFirstMessage = structuredClone(session.history[0]);
    const broadcasts: string[] = [];
    session.broadcast = async (text: string) => { broadcasts.push(String(text)); };

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session, _iteration: number, options?: { appendMessage?: (message: Message) => Promise<void> }) => {
      requestPartsAtCall = structuredClone(parts);
      tempHistoryAtCall = structuredClone(activeSession.history);
      chatStarted.resolve();
      await chatGate.promise;
      await appendTempConversation(activeSession, parts, 'btw text answer', options);
      return { text: 'btw text answer', allParts: [{ text: 'btw text answer' }] };
    };

    const replies: string[] = [];
    await COMMANDS['/btw'].handler(
      { reply: (text: string) => { replies.push(String(text)); } } as any,
      ['side', 'question'],
      sessionId,
      session,
    );

    assert.deepEqual(replies, ['📝 BTW request started. I’ll post the result here when it finishes.']);
    await chatStarted.promise;

    const during = await sessionManager.getSession(sessionId);
    assert.equal(during.history.length, 1, 'real session should not receive the temporary /btw input while model call is pending');
    assert.deepEqual(during.history[0], originalFirstMessage);
    assert.equal(tempHistoryAtCall.length, 1);
    assert.deepEqual(tempHistoryAtCall[0], originalFirstMessage);
    assert.ok(requestPartsAtCall?.some(part => typeof part.system === 'string' && part.system.includes('Do not call tools in BTW mode')));
    assert.ok(requestPartsAtCall?.some(part => part.text === 'side question'));

    chatGate.resolve();

    await waitFor(async () => {
      return broadcasts.some(text => text.includes('btw text answer'));
    });

    const after = await sessionManager.getSession(sessionId);
    assert.equal(after.history.length, 1, 'BTW result should be broadcast without being appended to real history');
    assert.deepEqual(after.history[0], originalFirstMessage);
    assert.equal(broadcasts.length, 1);
    assert.match(broadcasts[0], /\[BTW result\]/);
    assert.match(broadcasts[0], /btw text answer/);
    assert.equal(after.history.some(message => message.role === 'user' && message.parts.some(part => part.text === 'side question')), false);
    assert.equal(after.history.some(message => message.parts.some(part => part.text?.includes('btw text answer'))), false);
    assert.deepEqual(tools.modelFacingDefinitions.map(def => def.name), toolNamesBefore);
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('/btw does not execute tool calls returned by the model', async () => {
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const sessionId = makeId('btw_tool');
  let executeToolsCalled = false;

  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  try {
    const session = await createTestSession(sessionId);
    const originalHistory = structuredClone(session.history);
    const broadcasts: string[] = [];
    session.broadcast = async (text: string) => { broadcasts.push(String(text)); };

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session, _iteration: number, options?: { appendMessage?: (message: Message) => Promise<void> }) => {
      if (parts) {
        await options?.appendMessage?.({ role: 'user', parts });
      }
      await options?.appendMessage?.({
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'exec', args: { command: 'echo should-not-run' } } }],
      });
      return {
        text: '',
        allParts: [{ functionCall: { id: 'call_1', name: 'exec', args: { command: 'echo should-not-run' } } }],
        toolCalls: [{ id: 'call_1', name: 'exec', args: { command: 'echo should-not-run' } }],
      };
    };
    (llm as any).executeTools = async () => {
      executeToolsCalled = true;
      throw new Error('executeTools should not be called for /btw');
    };

    const result = await runBtwRequest(sessionId, 'please run a command');
    const updatedSession = await sessionManager.getSession(sessionId);

    assert.equal(result.toolDenied, true);
    assert.equal(executeToolsCalled, false);
    assert.deepEqual(updatedSession.history, originalHistory);
    assert.equal(broadcasts.length, 1);
    assert.match(broadcasts[0], /BTW aborted/);
    assert.match(broadcasts[0], /`exec`/);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
