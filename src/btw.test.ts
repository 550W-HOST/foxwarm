import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as llm from './llm';
import { runBtwRequest, BTW_USAGE } from './btw';
import { COMMANDS } from './commands';
import * as sessionManager from './sessionManager';
import * as tools from './tools';
import * as toolsSessionAgent from './toolsSessionAgent';
import * as vector from './vector';
import { resolveCompactionSplitIndex } from './session/history';
import { shouldIgnoreMessageInCompactCandidates } from './session/layeredContext';
import { createDisplayOnlyModelMessage } from './session/messageVisibility';
import { estimateSessionSummary } from './tokenCount';
import { formatSessionMessagesPreview } from './utils/messagePreview';
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

test('/btw command acks immediately and writes async result as display-only history without mutating model-visible input', async () => {
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
    session.broadcast = (text: string) => { broadcasts.push(String(text)); };

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
    assert.equal(after.history.length, 2, 'BTW result should be persisted as a display-only history message');
    assert.deepEqual(after.history[0], originalFirstMessage);
    assert.equal(after.history[1].role, 'model');
    assert.equal(after.history[1].modelVisible, false);
    assert.equal(after.history[1].__meta?.noticeType, 'btw');
    assert.match(after.history[1].parts[0].text || '', /\[BTW result\]/);
    assert.match(after.history[1].parts[0].text || '', /btw text answer/);
    assert.equal(broadcasts.length, 1);
    assert.match(broadcasts[0], /\[BTW result\]/);
    assert.match(broadcasts[0], /btw text answer/);
    assert.equal(after.history.some(message => message.role === 'user' && message.parts.some(part => part.text === 'side question')), false);
    assert.match(formatSessionMessagesPreview(sessionId, after.history, 0, after.history.length), /model \[display-only\]:/);

    const toolPreview = await toolsSessionAgent.tool_get_session_messages({ sessionId }, { sessionId, session: after } as any);
    assert.match(toolPreview, /model \[display-only\]: \[display-only message hidden\]/);
    assert.doesNotMatch(toolPreview, /btw text answer/);

    const archivePreview = await toolsSessionAgent.tool_recall({ sessionId, target: 'msg#1-2' }, { sessionId, session: after } as any);
    assert.match(archivePreview, /model \[display-only\]: \[display-only message hidden\]/);
    assert.doesNotMatch(archivePreview, /btw text answer/);

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
    session.broadcast = (text: string) => { broadcasts.push(String(text)); };

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
    assert.equal(updatedSession.history.length, originalHistory.length + 1);
    assert.deepEqual(updatedSession.history.slice(0, originalHistory.length), originalHistory);
    assert.equal(updatedSession.history[updatedSession.history.length - 1].modelVisible, false);
    assert.match(updatedSession.history[updatedSession.history.length - 1].parts[0].text || '', /BTW aborted/);
    assert.match(updatedSession.history[updatedSession.history.length - 1].parts[0].text || '', /`exec`/);
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

test('display-only messages persist in history but are omitted from model-facing LLM input and token/vector estimates', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;

  (axios as any).post = async (_url: string, data: any) => {
    capturedBody = data;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      },
    };
  };

  try {
    const displayOnly = createDisplayOnlyModelMessage('hidden btw result', { noticeType: 'test' });
    const ordinaryUser: Message = { role: 'user', parts: [{ text: 'visible ordinary user text' }] };
    const ordinaryModel: Message = { role: 'model', parts: [{ text: 'visible ordinary model text' }] };
    const session = {
      id: makeId('btw_visibility'),
      agent: 'main',
      history: [ordinaryUser, displayOnly, ordinaryModel],
      persistentMemorySnapshot: 'system prompt',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      model: 'anthropic/claude-sonnet-4-5',
    } as Session;

    await llm.chat(null, session, 0, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const providerPayload = JSON.stringify(capturedBody);
    assert.match(providerPayload, /visible ordinary user text/);
    assert.match(providerPayload, /visible ordinary model text/);
    assert.doesNotMatch(providerPayload, /hidden btw result/);

    const preview = formatSessionMessagesPreview(session.id, [ordinaryUser, displayOnly, ordinaryModel], 0, 3);
    assert.match(preview, /hidden btw result/);
    assert.match(preview, /model \[display-only\]:/);

    const tokenSummary = estimateSessionSummary({ history: [ordinaryUser, displayOnly], persistentMemorySnapshot: '' });
    const visibleOnlySummary = estimateSessionSummary({ history: [ordinaryUser], persistentMemorySnapshot: '' });
    assert.deepEqual(tokenSummary, visibleOnlySummary);

    const segments = vector.buildArchiveSegments([
      { v: 1, kind: 'message', sessionId: session.id, agent: 'main', seq: 1, timestamp: Date.now(), role: 'model', message: displayOnly },
      { v: 1, kind: 'message', sessionId: session.id, agent: 'main', seq: 2, timestamp: Date.now(), role: 'user', message: ordinaryUser },
    ] as any);
    assert.equal(JSON.stringify(segments).includes('hidden btw result'), false);
    assert.equal(JSON.stringify(segments).includes('visible ordinary user text'), true);

    assert.equal(shouldIgnoreMessageInCompactCandidates(displayOnly), true);
    assert.equal(resolveCompactionSplitIndex([ordinaryUser, displayOnly, ordinaryModel], 0), 3);
    assert.equal(resolveCompactionSplitIndex([ordinaryUser, ordinaryModel], 0), 2);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('manual compact drops display-only messages outside the force-kept range and can compact visible messages across them', async () => {
  const originalChat = llm.chat;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const sessionId = makeId('btw_compact_display_only');
  let compactPrompt = '';

  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  try {
    await sessionManager.createSession(sessionId, {
      id: sessionId,
      agent: 'main',
      history: [],
      persistentMemorySnapshot: 'test system prompt',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      vectorIndexPosition: 0,
      nextMessageSeq: 1,
      currentNode: 'master',
    });
    const session = await sessionManager.getSession(sessionId);
    await sessionManager.appendSessionMessage(session, createDisplayOnlyModelMessage('display only secret before compact range', { noticeType: 'test' }));
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts: [{ text: `visible-before ${'alpha '.repeat(5000)}` }],
    });
    await sessionManager.appendSessionMessage(session, createDisplayOnlyModelMessage('display only secret inside compact range', { noticeType: 'test' }));
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts: [{ text: `visible-after ${'omega '.repeat(5000)}` }],
    });
    await sessionManager.appendSessionMessage(session, createDisplayOnlyModelMessage('display only secret after compact range', { noticeType: 'test' }));

    (llm as any).chat = async (parts: MessagePart[] | null) => {
      compactPrompt = parts?.map(part => part.system || part.text || '').join('\n') || '';
      const toolCall = {
        id: 'compact_plan_1',
        name: 'submit_compact_plan',
        args: {
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 2,
            sourceEnd: 4,
            summary: 'summary of visible before and visible after; display-only notice omitted',
          }]),
        },
      };
      return { text: '', allParts: [{ functionCall: toolCall }], toolCalls: [toolCall] };
    };

    await sessionManager.processSessionCompactionRequest(sessionId, {
      keepPercent: 0,
      completionMarker: 'Compaction completed.',
    }, 'await');

    const compacted = await sessionManager.getSession(sessionId);
    const rendered = JSON.stringify(compacted.history);
    assert.doesNotMatch(compactPrompt, /display only secret before compact range/);
    assert.doesNotMatch(compactPrompt, /display only secret inside compact range/);
    assert.doesNotMatch(compactPrompt, /display only secret after compact range/);
    assert.match(compactPrompt, /visible-before/);
    assert.match(compactPrompt, /visible-after/);
    assert.doesNotMatch(rendered, /display only secret/);
    assert.match(rendered, /summary of visible before and visible after/);
    assert.equal(compacted.history.some(message => message.modelVisible === false), false);
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
