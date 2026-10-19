import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withQueueInputHint, buildSystemMessageParts, buildTimestampedSystemMessageParts, isSystemPayloadTextPart, withInputTimePart } from './systemMessageParts';
import { formatFoxwarmMessage, formatFoxwarmMessageOpen, formatFoxwarmSystemOpen, formatFoxwarmSystemTag, parseFoxwarmOpeningTag } from './promptWrappers';
import type { MessagePart } from '../types';

process.env.TZ = 'Asia/Shanghai';

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

test('input wrapper hints preserve source attributes and raw full-wrapper bodies without changing queue parts', () => {
  const attrs = { type: 'channel', channelType: 'test', time: 'original time', sender: 'a "quoted" <sender>', hint: 'existing guidance & details' };
  const body = '  user XML:\n<foxwarm-message type="channel" hint="user-owned">\nkeep this\n</foxwarm-message>\n  ';
  const parts = [{ system: formatFoxwarmMessage(attrs, body) }];
  const snapshot = structuredClone(parts);
  const prepared = withQueueInputHint(parts, 'extra guidance');
  assert.equal(prepared.length, parts.length);
  assert.deepEqual(parseFoxwarmOpeningTag(prepared[0].system)?.attrs, { ...attrs, queueInputHint: 'extra guidance' });
  assert.deepEqual(withQueueInputHint(prepared, 'extra guidance'), prepared, 'setting the attribute again does not duplicate it');
  assert.equal(prepared[0].system?.slice(prepared[0].system.indexOf('>') + 1), `\n${body}\n</foxwarm-message>`);
  assert.deepEqual(parts, snapshot);
});

test('input wrapper hints decorate only the multipart source opening without adding or reordering parts', () => {
  for (const source of [
    formatFoxwarmMessageOpen({ type: 'channel', time: 'original', hint: 'channel guidance' }),
    formatFoxwarmSystemOpen({ kind: 'external-input', externalId: 'external-1', time: 'original', hint: 'MCP guidance' }),
  ]) {
    const parts: MessagePart[] = [
      { system: '<foxwarm-system kind="session" currentSessionId="test" />' },
      { system: '<foxwarm-system kind="channel-mode" mode="send-only" />' },
      { system: '<foxwarm-system kind="time" localTime="original" />' },
      { system: source },
      { text: '<foxwarm-message type="channel" hint="body">user text</foxwarm-message>' },
      { inlineData: { mimeType: 'image/png', data: 'unchanged image bytes' } },
      { text: '<foxwarm-file name="notes.txt" path="notes.txt" />' },
      { system: source.startsWith('<foxwarm-message') ? '</foxwarm-message>' : '</foxwarm-system>' },
    ];
    const original = structuredClone(parts);
    const prepared = withQueueInputHint(parts, 'extra guidance');
    assert.equal(prepared.length, original.length);
    assert.deepEqual(prepared.slice(0, 3), original.slice(0, 3));
    assert.deepEqual(prepared.slice(4), original.slice(4));
    const attrs = parseFoxwarmOpeningTag(source)!.attrs;
    assert.deepEqual(parseFoxwarmOpeningTag(prepared[3].system)?.attrs, { ...attrs, queueInputHint: 'extra guidance' });
    assert.deepEqual(parts, original);
  }
});

test('input wrapper hints do not wrap bare input or search user bodies for source-like tags', () => {
  for (const parts of [
    [{ text: '<foxwarm-message type="channel" hint="user-owned">body</foxwarm-message>' }],
    [{ system: '<foxwarm-system kind="session">\n<foxwarm-message type="channel" hint="nested">body</foxwarm-message>\n</foxwarm-system>' }],
    [{ text: 'bare text' }, { system: '<foxwarm-message type="channel" hint="body fragment">' }],
  ]) {
    assert.deepEqual(withQueueInputHint(parts, 'extra guidance'), parts);
  }
});

test('queued event wrappers retain paired or self-closing structure and never decorate nested body tags', () => {
  const body = '\n<foxwarm-message type="inter-agent" hint="body-owned">event payload</foxwarm-message>\n';
  for (const source of [
    formatFoxwarmMessage({ type: 'task', taskId: 'test-task', time: 'original', hint: 'task guidance' }, body),
    `${formatFoxwarmSystemOpen({ kind: 'event', type: 'background-process-finished', time: 'original' })}${body}</foxwarm-system>`,
    `${formatFoxwarmSystemOpen({ kind: 'system', time: 'original' })}${body}</foxwarm-system>`,
    `${formatFoxwarmSystemOpen({ kind: 'event', type: 'wait-timeout', seconds: 5, time: 'original' })}${body}</foxwarm-system>`,
    formatFoxwarmSystemTag({ kind: 'event', type: 'node-online', time: 'original', hint: 'event guidance' }),
    '<foxwarm-message type="background" time="original" hint="event guidance" />',
  ]) {
    const prepared = withQueueInputHint([{ system: source }], 'queued event guidance')[0].system!;
    assert.deepEqual(parseFoxwarmOpeningTag(prepared)?.attrs, {
      ...parseFoxwarmOpeningTag(source)!.attrs, queueInputHint: 'queued event guidance',
    });
    assert.equal(prepared.endsWith('/>'), source.endsWith('/>'));
    assert.equal(prepared.slice(prepared.indexOf('>') + 1), source.slice(source.indexOf('>') + 1));
    assert.equal((prepared.match(/queueInputHint=/g) || []).length, 1);
  }
});
