import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { isWeWorkChannelConfigReady, WeWorkWebhookChannel } from './weworkChannel';

const aibotTextBody = {
  msgid: 'msg-1',
  aibotid: 'bot-1',
  chatid: 'chat-1',
  chattype: 'group',
  from: { userid: 'user-1' },
  response_url: 'https://example.test/response',
  msgtype: 'text',
  text: { content: '@Robot hello' },
};

function cloneBody(msgid: string) {
  return { ...aibotTextBody, msgid };
}

test('WeWork channel only enables passive stream aggregation when configured', async () => {
  const disabled = new WeWorkWebhookChannel({ name: 'wework-test', webhookUrl: 'https://example.test/webhook' });
  disabled.onMessage(async () => {});

  const disabledResult = await (disabled as any).processInboundBody(aibotTextBody, {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(disabledResult.handled, true);
  assert.equal(disabledResult.passiveResponse, undefined);

  const enabled = new WeWorkWebhookChannel({
    name: 'wework-test',
    webhookUrl: 'https://example.test/webhook',
    aibot: { stream: true },
  });
  enabled.onMessage(async () => {});

  const enabledResult = await (enabled as any).processInboundBody(aibotTextBody, {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(enabledResult.handled, true);
  assert.deepEqual(enabledResult.passiveResponse, {
    msgtype: 'stream',
    stream: {
      id: enabledResult.passiveResponse.stream.id,
      finish: false,
      content: '> 🤔 thinking',
    },
  });
});

test('WeWork channel config readiness supports pure callback and websocket modes', () => {
  assert.equal(isWeWorkChannelConfigReady({ webhookUrl: 'https://example.test/webhook' }), true);
  assert.equal(isWeWorkChannelConfigReady({
    listenPort: 3003,
    listenPath: '/wework/aibot',
    token: 'token',
    encodingAESKey: 'encoding-key',
  }), true);
  assert.equal(isWeWorkChannelConfigReady({
    aibot: { websocket: { enabled: true, botId: 'bot', secret: 'secret' } },
  }), true);
  assert.equal(isWeWorkChannelConfigReady({ listenPort: 3003, listenPath: '/missing-crypto' }), false);
});

test('WeWork channel deduplicates repeated callback msgid', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  let handled = 0;
  channel.onMessage(async () => { handled++; });

  const first = await (channel as any).processInboundBody(cloneBody('dup-msg'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  const second = await (channel as any).processInboundBody(cloneBody('dup-msg'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(handled, 1);
  assert.equal(second.passiveResponse.stream.id, first.passiveResponse.stream.id);
});

test('WeWork channel can start a passive stream for pure short-callback AIBot messages without response_url', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const { response_url: _responseUrl, ...body } = cloneBody('pure-callback');
  const result = await (channel as any).processInboundBody(body, { mode: 'webhook' }, true);

  assert.equal(result.handled, true);
  assert.equal(result.passiveResponse.msgtype, 'stream');
  assert.equal(result.passiveResponse.stream.finish, false);
  assert.equal(result.passiveResponse.stream.content, '> 🤔 thinking');
});

test('WeWork channel skips stream-bound broadcasts for non-matching conversations instead of falling back to webhook send', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    webhookUrl: 'https://example.invalid/webhook',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('skip-turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  await channel.sendMessage('other-chat', 'must not be posted to webhook', { weworkStreamId: first.passiveResponse.stream.id });

  const refresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: first.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
  assert.equal(refresh.passiveResponse.stream.content, '> 🤔 thinking');
  assert.equal(refresh.passiveResponse.stream.finish, false);
});

test('WeWork channel binds stream updates by stream id instead of latest conversation card', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  const second = await (channel as any).processInboundBody(cloneBody('turn-2'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  await channel.sendMessage('chat-1', 'old final', { weworkStreamId: first.passiveResponse.stream.id, turnFinal: true });
  await channel.sendMessage('chat-1', 'new queued notice', { weworkStreamId: second.passiveResponse.stream.id });

  const firstRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: first.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
  const secondRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: second.passiveResponse.stream.id } }, { mode: 'webhook' }, true);

  assert.equal(firstRefresh.passiveResponse.stream.content, 'old final');
  assert.equal(firstRefresh.passiveResponse.stream.finish, true);
  assert.equal(secondRefresh.passiveResponse.stream.content, 'new queued notice');
  assert.equal(secondRefresh.passiveResponse.stream.finish, false);
});

test('WeWork channel applies structured turn progress to the bound stream card', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('progress-turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  const streamId = first.passiveResponse.stream.id;

  await channel.sendMessage('chat-1', 'model 文本消息 1', { weworkStreamId: streamId });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: {
      type: 'tool-calls-start',
      calls: [
        { id: 'call-1', name: 'exec' },
        { id: 'call-2', name: 'read' },
      ],
    },
  });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: {
      type: 'tool-calls-finish',
      results: [
        { id: 'call-1', name: 'exec', status: 'success' },
        { id: 'call-2', name: 'read', status: 'success' },
      ],
    },
  });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: { type: 'llm-start' },
  });

  const refresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: streamId } }, { mode: 'webhook' }, true);
  assert.equal(refresh.passiveResponse.stream.content, 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | 🤔 thinking');
});

test('WeWork encrypted passive response can be decrypted back to the stream payload', () => {
  const encodingAESKey = crypto.randomBytes(32).toString('base64').replace(/=+$/u, '');
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    token: 'test-token',
    encodingAESKey,
  });
  const payload = {
    msgtype: 'stream',
    stream: { id: 'stream-1', finish: false, content: '> 🤔 thinking' },
  };

  const encrypted = (channel as any).buildPassiveHttpResponse(payload, { timestamp: '1710000000', nonce: 'nonce-1' });
  assert.equal(typeof encrypted.encrypt, 'string');
  assert.equal(typeof encrypted.msgsignature, 'string');

  const plaintext = (channel as any).crypto.decryptCallbackMessage(encrypted.encrypt);
  assert.deepEqual(JSON.parse(plaintext), payload);
  assert.equal((channel as any).crypto.verifySignature(encrypted.msgsignature, String(encrypted.timestamp), encrypted.nonce, encrypted.encrypt), true);
});
