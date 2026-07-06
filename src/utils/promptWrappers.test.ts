import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeFoxwarmAttributeValue,
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
  assert.deepEqual(parseFoxwarmTagLine(formatFoxwarmMessageClose()), {
    tagName: 'foxwarm-message',
    closing: true,
    attrs: {},
  });
});

test('formatSystemPartForModel converts legacy system strings without generating bracket wrapper', () => {
  assert.equal(
    formatSystemPartForModel('current time = now'),
    '<foxwarm-system hint="current time = now" />',
  );
  assert.equal(formatSystemPartForModel('<foxwarm-system kind="time" />'), '<foxwarm-system kind="time" />');
});
