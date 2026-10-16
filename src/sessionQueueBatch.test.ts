import test from 'node:test';
import assert from 'node:assert/strict';
import { initArchiveStore } from './session/archiveStore';
import * as sessionManager from './sessionManager';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { CurrentSessionTurnEffects } from './llm';
import type { Message, QueueItem, Session } from './types';
import { formatFoxwarmMessage, formatFoxwarmSystemOpen } from './utils/promptWrappers';

function makeSession(id: string): Session {
  return { id, agent: 'main', history: [], queue: [], busy: true, persistentMemorySnapshot: '', systemPromptFiles: [], snapshotUpdatedAt: Date.now(), stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: Date.now() } } as Session;
}

test('selected ordinary prefix appends once with separate canonical rows and client identities', async () => {
  await initArchiveStore();
  const session = makeSession(`queue-batch-${Date.now()}`);
  const items: QueueItem[] = [
    { type: 'user', parts: [{ text: 'first' }], clientMessageId: 'client-1' },
    { type: 'user', parts: [{ text: 'second' }], clientMessageId: 'client-2' },
  ];
  session.queue.push(...items);
  let persists = 0;
  let published: Message[] = [];
  const effects = {
    placement: 'local',
    appendMessage: async () => { throw new Error('unexpected single append'); },
    appendMessages: async () => { throw new Error('unexpected ordinary append'); },
    appendQueuedMessages: async (owner: Session, messages: Message[]) => sessionManager.appendQueuedSessionMessagesForSession(owner, messages, async () => { persists += 1; }, (_owner, canonical) => { published = canonical; }),
    persistSession: async () => {}, updateBusy: async () => {}, startWait: async () => ({ id: 'unused', startedAt: Date.now() }),
    notifyHistoryUpdate: () => {}, notifySessionEvent: () => {}, setRuntimeState: () => {}, clearRuntimeState: () => {},
    registerAbortController: () => {}, clearAbortController: () => {}, clearWaitById: async () => false,
  } as unknown as CurrentSessionTurnEffects;
  const runner = new SessionTurnRunner(new LocalSessionTurnHost(effects, session));
  const selected = (runner as any).drainLeadingQueuedTurnInputs(session) as QueueItem[];
  await (runner as any).appendQueuedTurnInputs(session, session.id, selected);
  assert.equal(persists, 1);
  assert.equal(session.history.length, 2);
  assert.equal(published.length, 2);
  assert.deepEqual(session.history.map(message => message.__meta?.clientMessageId), ['client-1', 'client-2']);
  assert.deepEqual(session.history.map(message => message.__meta?.seq), [1, 2]);
});

test('queued source hints commit once after an append failure without modifying the queued originals', async t => {
  await initArchiveStore();
  const session = makeSession(`queue-hint-retry-${Date.now()}`);
  const items: QueueItem[] = [
    { type: 'user', queuedInput: true, clientMessageId: 'channel', parts: [
      { system: formatFoxwarmMessage({ type: 'channel', time: 'original', hint: 'channel guidance' }, 'channel input') },
    ] },
    { type: 'user', queuedInput: true, message: { role: 'user', __meta: { timestamp: 123456 }, parts: [
      { system: formatFoxwarmSystemOpen({ kind: 'external-input', externalId: 'external-1', time: 'original', hint: 'MCP guidance' }) },
      { text: 'external input' },
      { system: '</foxwarm-system>' },
    ] } },
  ];
  const originals = structuredClone(items);
  session.queue.push(...items);
  let rejectPersist = true;
  const host = new LocalSessionTurnHost();
  t.mock.method(host, 'appendQueuedSessionMessages', async (owner: Session, messages: Message[]) => {
    await sessionManager.appendQueuedSessionMessagesForSession(owner, messages, async () => {
      if (rejectPersist) throw new Error('append rejected');
    }, () => {});
  });
  const runner = new SessionTurnRunner(host);
  const appendSelected = () => (runner as any).appendQueuedTurnInputs(session, session.id,
    (runner as any).drainLeadingQueuedTurnInputs(session));
  await assert.rejects(appendSelected, /append rejected/);
  assert.deepEqual(session.queue, originals);
  assert.equal(session.history.length, 0);
  rejectPersist = false;
  await appendSelected();
  assert.equal(session.history.length, 2);
  for (const message of session.history) {
    assert.equal((JSON.stringify(message.parts).match(/Queued input:/g) || []).length, 1);
  }
  assert.equal(session.history[0].__meta?.clientMessageId, 'channel');
  assert.equal(session.history[1].__meta?.timestamp, 123456);
  assert.deepEqual(items, originals, 'only the canonical copies receive appended guidance');
});
