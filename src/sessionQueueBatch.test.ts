import test from 'node:test';
import assert from 'node:assert/strict';
import { initArchiveStore } from './session/archiveStore';
import * as sessionManager from './sessionManager';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import type { CurrentSessionTurnEffects } from './llm';
import type { Message, QueueItem, Session } from './types';

function makeSession(id: string): Session {
  return { id, agent: 'main', history: [], queue: [], busy: true, persistentMemorySnapshot: '', systemPromptFiles: [], snapshotUpdatedAt: Date.now(), stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: Date.now() } } as Session;
}

test('selected compatible prefix appends once with separate canonical rows and client identities', async () => {
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
  const selected = (runner as any).drainLeadingQueuedTurnInputs(session) as { items: QueueItem[] };
  await (runner as any).appendQueuedTurnInputs(session, session.id, selected.items);
  assert.equal(persists, 1);
  assert.equal(session.history.length, 2);
  assert.equal(published.length, 2);
  assert.deepEqual(session.history.map(message => message.__meta?.clientMessageId), ['client-1', 'client-2']);
  assert.deepEqual(session.history.map(message => message.__meta?.seq), [1, 2]);
});
