import test from 'node:test';
import assert from 'node:assert/strict';
import { Message } from './types';
import { formatMessagePreviewText } from './utils/messageFormat';
import { formatMessagePreviewLine, getMessagePreview } from './utils/messagePreview';
import { containsLoneSurrogate } from './utils/unicode';

function makeMessage(parts: Message['parts']): Message {
  return {
    role: 'model',
    parts,
    __meta: { seq: 1, timestamp: 1 },
  };
}

test('formatMessagePreviewText skips thinking by default and formats multiline continuations', () => {
  const message = makeMessage([{ text: 'line 1\nline 2', thinking: 'secret reasoning' }]);
  const preview = formatMessagePreviewText(message, 200);

  assert.equal(preview, 'line 1\n> line 2');
  assert.doesNotMatch(preview, /secret reasoning/);
});

test('getMessagePreview also skips thinking content', () => {
  const message = makeMessage([{ text: 'visible answer', thinking: 'hidden chain of thought' }]);
  const preview = getMessagePreview(message, 200);

  assert.equal(preview, 'visible answer');
  assert.doesNotMatch(preview, /hidden chain of thought/);
});

test('formatMessagePreviewLine does not duplicate continuation prefixes', () => {
  const message = makeMessage([{ text: 'line 1\nline 2\nline 3' }]);
  const line = formatMessagePreviewLine(message, 7, 200);

  assert.match(line, /\[7\] 🤖 model: line 1\n> line 2\n> line 3\n$/);
  assert.doesNotMatch(line, /> > /);
});

test('formatMessagePreviewText does not split surrogate pairs when truncating previews', () => {
  const message = makeMessage([{ text: `${'x'.repeat(10)}🦊 trailing` }]);
  const preview = formatMessagePreviewText(message, 11);

  assert.equal(containsLoneSurrogate(preview), false);
  assert.doesNotMatch(JSON.stringify(preview), /\\ud83e(?!\\udd8a)/i);
});

test('tool response preview truncation does not split surrogate pairs', () => {
  const message: Message = {
    role: 'tool',
    parts: [{
      functionResponse: {
        tool_use_id: 'call_test',
        name: 'read',
        response: { output: '# Foxwarm 🦊 extra' },
      },
    }],
  };

  const preview = formatMessagePreviewText(message, 200, { toolCharLimit: 11 });

  assert.equal(containsLoneSurrogate(preview), false);
  assert.doesNotMatch(JSON.stringify(preview), /\\ud83e(?!\\udd8a)/i);
});
