import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueuedPreviewMessages, composeQueuedPreviewProjection, MAX_QUEUED_PREVIEW_ITEMS } from './webuiQueuePreview';

const item = (text: string): any => ({ type: 'background', parts: [{ text }] });

test('queue preview projection is bounded and sanitizes attachment bodies', () => {
  const queue = Array.from({ length: MAX_QUEUED_PREVIEW_ITEMS + 3 }, (_, index) => ({
    type: 'user',
    parts: [{ text: `row ${index}` }, { inlineData: { mimeType: 'image/png', data: 'secret-body' } }],
  })) as any;
  const messages = buildQueuedPreviewMessages(queue);
  assert.equal(messages.length, MAX_QUEUED_PREVIEW_ITEMS);
  assert.equal(JSON.stringify(messages).includes('secret-body'), false);
  assert.match(JSON.stringify(messages), /attachment preview omitted/);
});

test('worker hot projection composes later durable mailbox inputs in queue order', () => {
  const hot = buildQueuedPreviewMessages([item('hot A'), item('hot B')]);
  const projection = composeQueuedPreviewProjection({
    hotQueuedMessages: hot,
    hotQueueLength: 2,
    pendingQueue: [item('pending C'), item('pending D')],
  });
  assert.equal(projection.queueLength, 4);
  assert.equal(projection.queuedPreviewOmittedCount, 0);
  assert.match(JSON.stringify(projection.queuedMessages), /hot A.*hot B.*pending C.*pending D/);
  assert.equal(projection.queuedMessages[2].__meta?.queueIndex, 2);
});
