import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemMessageParts, isSystemPayloadTextPart } from './systemMessageParts';

test('buildSystemMessageParts keeps scheduled timer header in system part and payload in plain text part', () => {
  const parts = buildSystemMessageParts('Scheduled timer fired (id: timer-1)\nrun nightly sync');

  assert.deepEqual(parts, [
    { system: 'Scheduled timer fired (id: timer-1)' },
    { text: 'run nightly sync', systemPayload: true },
  ]);
  assert.equal(isSystemPayloadTextPart(parts[1]), true);
});

test('buildSystemMessageParts keeps background process header separate from multiline payload', () => {
  const parts = buildSystemMessageParts('Background Process Finished\ncommand: `npm run build`\nExit code: 0');

  assert.deepEqual(parts, [
    { system: 'Background Process Finished' },
    { text: 'command: `npm run build`\nExit code: 0', systemPayload: true },
  ]);
});

test('buildSystemMessageParts keeps single-line messages as a single system part', () => {
  const parts = buildSystemMessageParts('retrying last request');

  assert.deepEqual(parts, [{ system: 'retrying last request' }]);
  assert.equal(isSystemPayloadTextPart(parts[0]), false);
});