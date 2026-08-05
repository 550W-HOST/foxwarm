import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import type { Message, Session } from '../types';
import { tool_get_session_messages } from './archiveRecall';

function createSession(id: string, history: Message[]): Session {
  return {
    id,
    agent: 'main',
    history,
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function createParityHistory(): Message[] {
  const messages: Message[] = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: `ordinary-${index}${index === 4 ? ' filter-needle' : ''}` }],
  } as Message));
  messages.push({
    role: 'model',
    parts: [{ text: 'display-only-secret' }],
    modelVisible: false,
    __meta: {},
  } as Message);
  messages.push({
    role: 'model',
    parts: [{ functionCall: { id: 'call-1', name: 'read', args: { filePath: 'demo.txt' } } }],
  } as Message);
  messages.push({
    role: 'tool',
    parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'tool-output-detail' } } }],
  } as Message);
  return messages;
}

test('detached get_session_messages is byte-compatible without global session reads', async () => {
  const session = createSession(`detached_messages_${Date.now()}`, createParityHistory());
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getMessages: sessionManager.getSessionMessages,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (sessionManager as any).getExistingSession = async () => session;
  (sessionManager as any).getSessionMessages = async (_id: string, start?: number, count?: number) => {
    const startIndex = start || 0;
    return session.history.slice(startIndex, count === undefined ? session.history.length : startIndex + count);
  };
  const cases: any[] = [
    { sessionId: session.id },
    { sessionId: session.id, start: -3, count: 2 },
    { sessionId: session.id, start: 8, count: 100 },
    { sessionId: session.id, start: 99, count: 3 },
    { sessionId: session.id, start: 0, count: 12, contentFilter: 'filter-needle', previewLength: 1000 },
    { sessionId: session.id, start: 0, count: 12, toolDetail: 'full', previewLength: 5000 },
  ];

  try {
    const legacy = await Promise.all(cases.map(args => tool_get_session_messages(args, { sessionId: session.id } as any)));
    (sessionManager as any).getExistingSession = async () => { throw new Error('global session lookup forbidden'); };
    (sessionManager as any).getSessionMessages = async () => { throw new Error('global message lookup forbidden'); };
    const trustedCtx: any = { sessionId: session.id, session, persistCurrentSession: async () => {} };
    const detached = await Promise.all(cases.map(args => tool_get_session_messages(args, trustedCtx)));
    assert.deepEqual(detached, legacy);
    assert.doesNotMatch(String(detached[5]), /display-only-secret/);
    assert.match(String(detached[5]), /tool-output-detail/);
    assert.match(String(detached[3]), /No messages found/);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSessionMessages = originals.getMessages;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('detached isolated get_session_messages preserves the existing denial', async () => {
  const session = createSession(`detached_isolated_messages_${Date.now()}`, [{ role: 'user', parts: [{ text: 'secret' }] }]);
  const originals = {
    getExisting: sessionManager.getExistingSession,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  (sessionManager as any).getExistingSession = async () => { throw new Error('ID isolation lookup forbidden'); };
  (sessionManager as any).isSessionEffectivelyIsolated = (candidate: Session | undefined) => candidate === session;
  try {
    await assert.rejects(() => tool_get_session_messages({ sessionId: session.id }, {
      sessionId: session.id, session, persistCurrentSession: async () => {},
    } as any), { message: 'Isolated session cannot use get_session_messages tool.' });
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('get_session_messages no-hook and mismatched contexts retain the legacy target path', async () => {
  const targetId = `legacy_messages_${Date.now()}`;
  const globalSession = createSession(targetId, [{ role: 'user', parts: [{ text: 'global-visible' }] }]);
  const clone = createSession(targetId, [{ role: 'user', parts: [{ text: 'clone-secret' }] }]);
  const mismatch = createSession(`${targetId}_clone`, [{ role: 'user', parts: [{ text: 'mismatch-secret' }] }]);
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getMessages: sessionManager.getSessionMessages,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  let getExistingCount = 0;
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (sessionManager as any).getExistingSession = async (id: string) => {
    getExistingCount += 1;
    return id === targetId ? globalSession : null;
  };
  (sessionManager as any).getSessionMessages = async (id: string, start?: number, count?: number) => {
    if (id !== targetId) return [];
    const startIndex = start || 0;
    return globalSession.history.slice(startIndex, count === undefined ? undefined : startIndex + count);
  };

  try {
    const noHook = String(await tool_get_session_messages({ sessionId: targetId }, { sessionId: targetId, session: clone } as any));
    const mismatched = String(await tool_get_session_messages({ sessionId: targetId }, {
      sessionId: targetId, session: mismatch, persistCurrentSession: async () => {},
    } as any));
    const crossTarget = String(await tool_get_session_messages({ sessionId: targetId }, {
      sessionId: 'caller-id', session: createSession('caller-id', []), persistCurrentSession: async () => {},
    } as any));
    for (const output of [noHook, mismatched, crossTarget]) {
      assert.match(output, /global-visible/);
      assert.doesNotMatch(output, /clone-secret|mismatch-secret/);
    }
    assert.ok(getExistingCount >= 6, 'legacy isolation and target lookups should remain active');
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSessionMessages = originals.getMessages;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});
