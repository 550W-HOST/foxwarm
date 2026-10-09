import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import { Channel, registerChannel, unregisterChannel } from '../channel';
import * as sessionManager from '../sessionManager';
import { callTool, call_tool, definitions, send_to_channel as tool_send_to_channel } from '../tools';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';
import { tool_send_file } from '../toolsSessionAgent';

test('send_to_channel tool schema uses channelTargetId and drops channelId parameter', () => {
  const def = definitions.find(entry => entry.name === 'send_to_channel');
  assert.ok(def, 'send_to_channel definition should exist');
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelTargetId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(def?.parameters?.properties || {}, 'channelId'), false);
  assert.deepEqual(def?.parameters?.required, ['channelTargetId', 'message']);
});

test('direct and unified send_to_channel deliver to registered, unattached targets and retain authorization and platform errors', async () => {
  const sourceSessionId = `channel_management_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sourceSessionId);
  const sent: Array<{ conversationId: string; message: string }> = [];
  const channel: Channel = {
    name: 'unattached-send', platform: 'test',
    start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (conversationId, message) => {
      if (message === 'platform failure') throw new Error('Platform requires recent inbound context');
      sent.push({ conversationId, message });
    },
  };
  registerChannel(channel.name, channel);
  const channelTargetId = `${channel.name}:group:room-42`;
  const ctx = { sessionId: sourceSessionId, session };

  try {
    assert.equal(sessionManager.getSessionByChannel(channel.name, 'group:room-42'), undefined);
    for (const send of [
      (message: string) => tool_send_to_channel({ channelTargetId, message }, ctx),
      (message: string) => callTool('send_to_channel', { channelTargetId, message }, ctx),
      (message: string) => call_tool({ toolId: 'builtin:send_to_channel', args: { channelTargetId, message } }, ctx),
    ]) {
      assert.equal(await send('hello'), `Message sent to channel target \`${channelTargetId}\``);
    }
    assert.deepEqual(sent, Array.from({ length: 3 }, () => ({ conversationId: 'group:room-42', message: 'hello' })));
    assert.equal(sessionManager.getSessionByChannel(channel.name, 'group:room-42'), undefined);

    await assert.rejects(
      () => callTool('send_to_channel', { channelTargetId, message: 'platform failure' }, ctx),
      /Platform requires recent inbound context/,
    );

    await assert.rejects(
      () => tool_send_to_channel(
        { channelId: 'mainbot:conversation-42', message: 'legacy' },
        { sessionId: sourceSessionId },
      ),
      /channelTargetId is required/,
    );

    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-channel-send
  match: { tool: { source: builtin, name: send_to_channel } }
  action: deny
`));
    for (const send of [
      () => tool_send_to_channel({ channelTargetId, message: 'denied' }, ctx),
      () => callTool('send_to_channel', { channelTargetId, message: 'denied' }, ctx),
      () => call_tool({ toolId: 'builtin:send_to_channel', args: { channelTargetId, message: 'denied' } }, ctx),
    ]) await assert.rejects(send, /denies builtin capability/i);
    assert.equal(sent.length, 3);
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    unregisterChannel(channel.name);
    await sessionManager.deleteSession(sourceSessionId).catch(() => false);
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
    /sessionId or channelTargetId/,
  );
});

test('tool_send_file defaults sessionId to current session when omitted', async () => {
  const originalStat = fs.stat;
  const originalSendFileToSession = sessionManager.sendFileToSession;

  try {
    (fs as any).stat = async () => ({
      isFile: () => true,
      size: 12,
    });

    let capturedSessionId: string | undefined;
    (sessionManager as any).sendFileToSession = async (sessionId: string) => {
      capturedSessionId = sessionId;
      return {
        deliveredChannels: ['webui:current'] as string[],
        skippedChannels: [] as Array<{ channelId: string; reason: string }>,
        failedChannels: [] as Array<{ channelId: string; error: string }>,
      };
    };

    const result = await tool_send_file({ filePath: '/tmp/demo.txt' }, { sessionId: 'current-session' } as any);
    assert.equal(capturedSessionId, 'current-session');
    assert.equal(typeof result, 'object');
    assert.equal((result as any).fullPath, '/tmp/demo.txt');
  } finally {
    (fs as any).stat = originalStat;
    (sessionManager as any).sendFileToSession = originalSendFileToSession;
  }
});

test('tool_send_file returns generic success result with fullPath instead of failing when only WebUI session delivery is available', async () => {
  const originalStat = fs.stat;
  const originalSendFileToSession = sessionManager.sendFileToSession;

  try {
    (fs as any).stat = async () => ({
      isFile: () => true,
      size: 12,
    });

    (sessionManager as any).sendFileToSession = async () => ({
      deliveredChannels: [] as string[],
      skippedChannels: [{ channelId: 'webui:test-session', reason: 'channel does not support file sending yet' }],
      failedChannels: [] as Array<{ channelId: string; error: string }>,
    });

    const result = await tool_send_file({ sessionId: 'test-session', filePath: '/tmp/demo.txt' });
    assert.equal(typeof result, 'object');
    assert.equal((result as any).fullPath, '/tmp/demo.txt');
    assert.match(String((result as any).output || ''), /File `demo.txt` sent for session `test-session`/);
  } finally {
    (fs as any).stat = originalStat;
    (sessionManager as any).sendFileToSession = originalSendFileToSession;
  }
});
