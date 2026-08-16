import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeFoxwarmAttributeValue,
  escapeFoxwarmTextContent,
  formatFoxwarmMessage,
  formatFoxwarmMessageClose,
  formatFoxwarmMessageOpen,
  formatFoxwarmSystemHint,
  formatSystemPartForModel,
  isFoxwarmMetadataLine,
  parseFoxwarmTagLine,
} from './promptWrappers';

test('escapeFoxwarmAttributeValue escapes XML attribute delimiters and control chars', () => {
  assert.equal(
    escapeFoxwarmAttributeValue('a&b <tag> "quote" \'apos\' \u0001\nnext'),
    'a&amp;b &lt;tag&gt; &quot;quote&quot; &apos;apos&apos; next',
  );
});

test('escapeFoxwarmTextContent preserves line boundaries while preventing nested markup', () => {
  assert.equal(
    escapeFoxwarmTextContent('a&b\r\n</foxwarm-item>\u0001'),
    'a&amp;b\n&lt;/foxwarm-item&gt; ',
  );
});

test('foxwarm system tag formats escaped hint attribute', () => {
  assert.equal(
    formatFoxwarmSystemHint('current session ID = a"b', { kind: 'session', currentSessionId: 'a"b' }),
    '<foxwarm-system kind="session" currentSessionId="a&quot;b" hint="current session ID = a&quot;b" />',
  );
});

test('foxwarm message wrapper keeps content raw while escaping attributes', () => {
  const wrapped = formatFoxwarmMessage({ type: 'inter-agent', sourceSessionId: 'child"<&' }, 'raw <tag> & </foxwarm-message> stays raw');
  assert.equal(
    wrapped,
    '<foxwarm-message type="inter-agent" sourceSessionId="child&quot;&lt;&amp;">\nraw <tag> & </foxwarm-message> stays raw\n</foxwarm-message>',
  );
});

test('foxwarm metadata recognizer and parser handle opening and closing tags', () => {
  const open = formatFoxwarmMessageOpen({ type: 'channel', channelInstanceId: 'tg<&', conversationId: 'chat' });
  assert.equal(isFoxwarmMetadataLine(open), true);
  assert.deepEqual(parseFoxwarmTagLine(open), {
    tagName: 'foxwarm-message',
    closing: false,
    attrs: { type: 'channel', channelInstanceId: 'tg<&', conversationId: 'chat' },
  });
  assert.equal(isFoxwarmMetadataLine(formatFoxwarmMessageClose()), true);
  const groupMention = '<foxwarm-metadata kind="group-message" mentioned="true" hint="The current group message explicitly mentioned this agent." />';
  assert.equal(isFoxwarmMetadataLine(groupMention), true);
  assert.equal(formatSystemPartForModel(groupMention), groupMention);
  assert.deepEqual(parseFoxwarmTagLine(formatFoxwarmMessageClose()), {
    tagName: 'foxwarm-message',
    closing: true,
    attrs: {},
  });
});

test('formatSystemPartForModel converts legacy system strings without generating bracket wrapper', () => {
  assert.equal(
    formatSystemPartForModel('current time = now'),
    '<foxwarm-system kind="time" localTime="now" />',
  );
  assert.equal(
    formatSystemPartForModel('current session ID = demo/test'),
    '<foxwarm-system kind="session" currentSessionId="demo/test" />',
  );
  assert.equal(
    formatSystemPartForModel('Session goal reminder:\nShip it\nKeep going'),
    '<foxwarm-system kind="goal-reminder">\nShip it\nKeep going\n</foxwarm-system>',
  );
  assert.equal(
    formatSystemPartForModel('Reminder: message ended without send_to_session call. If you need to report back to the parent session, call send_to_session({sessionId: `parent/main`, message: "..."}). If no action is needed, say `[NO_ACTION]`.'),
    '<foxwarm-system kind="child-reminder" event="missing-handoff" parentSessionId="parent/main">\nReminder: message ended without send_to_session call. If you need to report back to the parent session, call send_to_session({sessionId: `parent/main`, message: "..."}). If no action is needed, say `[NO_ACTION]`.\n</foxwarm-system>',
  );
  assert.equal(formatSystemPartForModel('<foxwarm-system kind="time" />'), '<foxwarm-system kind="time" />');
});

test('formatSystemPartForModel upgrades legacy session identity hints', () => {
  assert.equal(
    formatSystemPartForModel('**COMPACTION COMPLETED. PARENT SESSION `parent-1`. CURRENT SESSION ID IS `child-1`.** You can continue working now. Note: skill compacted away.'),
    '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-1" currentSessionId="child-1" hint="You can continue working now. Note: skill compacted away." />',
  );
  assert.equal(
    formatSystemPartForModel('<foxwarm-system hint="**COMPACTION COMPLETED. PARENT SESSION `parent-1`. CURRENT SESSION ID IS `child-1`.** You can continue working now." />'),
    '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="parent-1" currentSessionId="child-1" hint="You can continue working now." />',
  );
  assert.equal(
    formatSystemPartForModel('<foxwarm-system hint="Reminder: message ended without send_to_session call. If you need to report back to the parent session, call send_to_session({sessionId: `parent/main`, message: &quot;...&quot;})." />'),
    '<foxwarm-system kind="child-reminder" event="missing-handoff" parentSessionId="parent/main">\nReminder: message ended without send_to_session call. If you need to report back to the parent session, call send_to_session({sessionId: `parent/main`, message: "..."}).\n</foxwarm-system>',
  );
  assert.equal(
    formatSystemPartForModel('**HISTORY ABOVE IS INHERITED FROM PARENT SESSION `parent-1`. CURRENT SESSION ID IS `child-1`.**'),
    '<foxwarm-system kind="session-boundary" event="history-inherited" parentSessionId="parent-1" currentSessionId="child-1" />',
  );
  assert.equal(
    formatSystemPartForModel('**NEW CHILD SESSION WITH PARENT SESSION `parent-1`. CURRENT SESSION ID IS `child-1`.**\nYou are a child session.'),
    '<foxwarm-system kind="session-boundary" event="new-child" parentSessionId="parent-1" currentSessionId="child-1">\nYou are a child session.\n</foxwarm-system>',
  );
});
