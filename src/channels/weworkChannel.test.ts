import test from 'node:test';
import assert from 'node:assert/strict';
import { WeWorkWebhookChannel } from './weworkChannel';

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
    aibot: { stream: true, streamInitialContent: 'working' },
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
      content: 'working',
    },
  });
});
