import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from './sessionManager';
import { definitions } from './tools';
import { tool_send_file, tool_send_to_channel } from './toolsSessionAgent';

test('send_to_channel tool schema uses channelTargetId and drops channelId parameter', () => {
  const def = definitions.find(entry => entry.name === 'send_to_channel');
  assert.ok(def, 'send_to_channel definition should exist');
  assert.ok(def?.description.includes('channelTargetId'));
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelTargetId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelId'), false);
  assert.deepEqual(def?.parameters?.required, ['channelTargetId', 'message']);
});

test('tool_send_to_channel sends via channelTargetId and no longer accepts channelId arg', async () => {
  const original = sessionManager.sendToChannelTargetId;
  let capturedTarget: string | undefined;
  let capturedMessage: string | undefined;

  try {
    (sessionManager as any).sendToChannelTargetId = async (channelTargetId: string, message: string) => {
      capturedTarget = channelTargetId;
      capturedMessage = message;
    };

    const result = await tool_send_to_channel({ channelTargetId: 'mainbot:conversation-42', message: 'hello' });
    assert.equal(result, 'Message sent to channel target `mainbot:conversation-42`');
    assert.equal(capturedTarget, 'mainbot:conversation-42');
    assert.equal(capturedMessage, 'hello');

    await assert.rejects(
      () => tool_send_to_channel({ channelId: 'mainbot:conversation-42', message: 'legacy' }),
      /channelTargetId is required/,
    );
  } finally {
    (sessionManager as any).sendToChannelTargetId = original;
  }
});

test('send_file tool schema uses channelTargetId and drops channelId parameter', () => {
  const def = definitions.find(entry => entry.name === 'send_file');
  assert.ok(def, 'send_file definition should exist');
  assert.ok(def?.description.includes('channelTargetId'));
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelTargetId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelId'), false);
});

test('tool_send_file no longer accepts legacy channelId arg', async () => {
  await assert.rejects(
    () => tool_send_file({ channelId: 'mainbot:conversation-42', filePath: 'dummy.txt' }),
    /Exactly one of sessionId or channelTargetId is required/,
  );
});
