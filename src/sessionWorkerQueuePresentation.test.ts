import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionWorkerPresentationServiceHandler } from './sessionWorkerPresentationService';

test('worker queue history append stays one validated presentation batch', async () => {
  const received: any[] = [];
  const handler = createSessionWorkerPresentationServiceHandler({
    expected: { sessionId: 'agent/main', generation: 2, incarnationId: 'inc' },
    broadcastMessage: () => { throw new Error('unexpected individual message'); },
    broadcastQueueHistoryAppend: (_sessionId, append) => { received.push(append); },
    notifySessionEvent: () => {},
  });
  await handler.queueHistoryAppend({
    sessionId: 'agent/main', generation: 2, incarnationId: 'inc',
    append: {
      messages: [
        { role: 'user', parts: [{ text: 'A' }], __meta: { seq: 1, clientMessageId: 'a' } },
        { role: 'user', parts: [{ text: 'B' }], __meta: { seq: 2, clientMessageId: 'b' } },
      ],
      queuedMessages: [{ role: 'user', parts: [{ text: 'pending C' }], __meta: { queuedPreview: true } }],
      hotQueueLength: 1, lastAppliedMailboxId: 7, messageCount: 2, historyVersion: 0, latestSeq: 2,
    },
  } as any, {} as any);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].messages.map((message: any) => message.__meta.clientMessageId), ['a', 'b']);
});
