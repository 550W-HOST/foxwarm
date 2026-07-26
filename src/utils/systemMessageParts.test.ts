import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemMessageParts, buildTimestampedSystemMessageParts, isSystemPayloadTextPart, withInputTimePart } from './systemMessageParts';

test('buildSystemMessageParts wraps legacy timer-style system text into one system part', () => {
  const parts = buildSystemMessageParts('Scheduled timer fired (id: timer-1)\nrun nightly sync');
  assert.deepEqual(parts, [
    { system: '<foxwarm-system kind="system">\nScheduled timer fired (id: timer-1)\nrun nightly sync\n</foxwarm-system>' },
  ]);
});

test('buildSystemMessageParts wraps background process payload in one foxwarm-system part', () => {
  const parts = buildSystemMessageParts('Background Process Finished\ncommand: `npm run build`\nExit code: 0');
  assert.deepEqual(parts, [
    { system: '<foxwarm-system kind="event" type="background-process-finished">\ncommand: `npm run build`\nExit code: 0\n</foxwarm-system>' },
  ]);
});

test('buildSystemMessageParts canonicalizes single-line system messages as one wrapped system part', () => {
  const parts = buildSystemMessageParts('retrying last request');
  assert.deepEqual(parts, [
    { system: '<foxwarm-system kind="event" type="retrying-last-request">\nretrying last request\n</foxwarm-system>' },
  ]);
});

test('buildSystemMessageParts keeps generated foxwarm-message body inside one system part', () => {
  const parts = buildSystemMessageParts('<foxwarm-message type="timer">\nrun nightly sync\n</foxwarm-message>');
  assert.deepEqual(parts, [
    { system: '<foxwarm-message type="timer">\nrun nightly sync\n</foxwarm-message>' },
  ]);
});

test('isSystemPayloadTextPart still recognizes legacy split payload parts', () => {
  assert.equal(isSystemPayloadTextPart({ text: 'payload', systemPayload: true }), true);
  assert.equal(isSystemPayloadTextPart({ text: 'ordinary' }), false);
});

test('timestamped input helpers add time to one outer source wrapper', () => {
  const timestamp = new Date('2026-07-27T05:00:00+08:00');
  assert.deepEqual(buildTimestampedSystemMessageParts('wake', timestamp), [
    { system: '<foxwarm-system kind="system" time="2026-07-27 05:00:00 +0800">\nwake\n</foxwarm-system>' },
  ]);
  assert.deepEqual(withInputTimePart([{ text: 'managed input' }], timestamp), [
    { system: '<foxwarm-message type="event" time="2026-07-27 05:00:00 +0800" hint="structured session input">' },
    { text: 'managed input' },
    { system: '</foxwarm-message>' },
  ]);
  assert.deepEqual(withInputTimePart([{ system: '<foxwarm-message type="timer" time="already">\nrun\n</foxwarm-message>' }], timestamp), [
    { system: '<foxwarm-message type="timer" time="already">\nrun\n</foxwarm-message>' },
  ]);
});
