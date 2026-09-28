import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { registerChannel, unregisterChannel, type Channel } from './channel';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { attachChannel, createChannelsStore, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor } from './sessionTurnDelivery';
import { QQBotChannel } from './channels/qqbotChannel';
import { WeWorkWebhookChannel } from './channels/weworkChannel';

test('turn delivery broadcasts without source targeting and sends empty finals only to lifecycle-capable channels', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-delivery-'));
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  const sent: any[] = [];
  const lifecycles: any[] = [];
  const channel = (id: string, fail = false, lifecycle = false): Channel => ({
    name: id, platform: id, start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (conversationId, text, options) => {
      sent.push({ id, conversationId, text, options }); if (fail) throw new Error(`${id} failed`);
    },
    ...(lifecycle ? { handleTurnLifecycle: async (conversationId: string, options: any) => { lifecycles.push({ id, conversationId, options }); } } : {}),
  });
  for (const [id, fail, lifecycle] of [
    ['telegram', false, false], ['secondary', true, false], ['webui', false, false], ['wework', false, true],
  ] as const) registerChannel(id, channel(id, fail, lifecycle));
  attachChannel('telegram', 'room', 'owner'); attachChannel('secondary', 'other', 'owner');
  attachChannel('webui', 'browser', 'owner'); attachChannel('wework', 'stream-room', 'owner');
  await saveChannels();
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'owner' }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', turnId: 'turn-1', outcome: 'response', text: 'final' }), { attempted: 3, delivered: 2 });
    assert.deepEqual(sent.map(item => item.id), ['telegram', 'secondary', 'wework']);
    assert.ok(sent.every(item => item.options.excludePlatforms.includes('webui') && item.options.channelProgressTurnId === 'turn-1'));

    sent.length = 0;
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', turnId: 'turn-1', outcome: 'empty-final', text: '' }), { attempted: 1, delivered: 1 });
    assert.equal(sent.length, 0, 'empty lifecycle finals never call ordinary sendMessage');
    assert.deepEqual(lifecycles, [{ id: 'wework', conversationId: 'stream-room', options: {
      allowEmptyBroadcast: true, channelProgressTurnId: 'turn-1', turnFinal: true,
    } }]);

    sent.length = 0;
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', outcome: 'error', text: 'failed turn' }), { attempted: 4, delivered: 3 });
    assert.equal(sent.some(item => item.id === 'webui'), true, 'error final preserves ordinary broadcast inclusion');
    await assert.rejects(() => (client.call as any)('deliverIntermediateText', {
      sourceSessionId: 'owner', turnId: 'turn-legacy', text: 'legacy source rejected',
      source: { platform: 'wework', channelUserId: 'legacy-room', preferDirectReply: true },
    }), { code: 'SESSION_TURN_DELIVERY_INVALID' });
    await assert.rejects(() => client.call('deliverCommittedFinal', { sourceSessionId: 'wrong', outcome: 'response', text: 'x' }), { code: 'SESSION_TURN_DELIVERY_SOURCE_MISMATCH' });
  } finally {
    transport.close(); for (const id of ['telegram', 'secondary', 'webui', 'wework']) unregisterChannel(id);
    resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});

test('Worker broadcasts use each QQ attachment latest passive ID without serialized turn source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-delivery-qq-intermediate-'));
  const calls: Array<{ url: string; body: any }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = String(url);
    if (urlText.includes('getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }), { status: 200 });
    calls.push({ url: urlText, body: JSON.parse(String(init?.body || '{}')) });
    return new Response('{}', { status: 200 });
  };
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-worker-delivery', { fetch });
  (channel as any).stopped = false; (channel as any).connectionGeneration = 1;
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'latest-passive-id', content: 'inbound', author: { user_openid: 'openid-worker' },
  });
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  registerChannel('qq-worker-delivery', channel);
  attachChannel('qq-worker-delivery', 'c2c:openid-worker', 'worker-owner'); await saveChannels();
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'worker-owner' }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverIntermediateText', { sourceSessionId: 'worker-owner', turnId: 'turn-qq', text: 'intermediate-1' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(await client.call('deliverIntermediateText', { sourceSessionId: 'worker-owner', turnId: 'turn-qq', text: 'intermediate-2' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'worker-owner', turnId: 'turn-qq', outcome: 'response', text: 'final' }), { attempted: 1, delivered: 1 });
    const messages = calls.filter(call => new URL(call.url).pathname.endsWith('/messages'));
    assert.deepEqual(messages.map(call => call.body.msg_id), ['latest-passive-id', 'latest-passive-id', 'latest-passive-id']);
    const sequences = messages.map(call => call.body.msg_seq);
    assert.ok(Number.isInteger(sequences[0]) && sequences[0] > 0);
    assert.deepEqual(sequences.slice(1).map((value, index) => value - sequences[index]), [1, 1]);
  } finally {
    transport.close(); unregisterChannel('qq-worker-delivery'); resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});

test('one source-blind final reaches two WeWork cards, QQ passive context, and another attachment once each', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-delivery-multi-adapter-'));
  const qqCalls: any[] = [];
  const qq = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-multi', {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }), { status: 200 });
      qqCalls.push(JSON.parse(String(init?.body || '{}')));
      return new Response('{}', { status: 200 });
    },
  });
  (qq as any).stopped = false; (qq as any).connectionGeneration = 1;
  await (qq as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'qq-latest-multi', content: 'qq inbound', author: { user_openid: 'qq-user' },
  });
  const weworkA = new WeWorkWebhookChannel({ name: 'wework-a-multi', aibot: { stream: true } });
  const weworkB = new WeWorkWebhookChannel({ name: 'wework-b-multi', aibot: { stream: true } });
  weworkA.onMessage(async () => {}); weworkB.onMessage(async () => {});
  const inbound = (msgid: string, chatid: string) => ({
    msgid, msgtype: 'text', aibotid: 'bot-1', chatid, chattype: 'group',
    from: { userid: 'user-1' }, text: { content: 'inbound' }, response_url: `https://example.test/${msgid}`,
  });
  const cardA = await (weworkA as any).processInboundBody(inbound('wework-a-inbound', 'chat-a'), { mode: 'webhook', responseUrl: 'https://example.test/a' }, true);
  const cardB = await (weworkB as any).processInboundBody(inbound('wework-b-inbound', 'chat-b'), { mode: 'webhook', responseUrl: 'https://example.test/b' }, true);
  const otherSends: string[] = [];
  const other: Channel = {
    name: 'other-multi', platform: 'telegram', start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (_conversationId, text) => { otherSends.push(text); },
  };
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  for (const [id, channel] of [['wework-a-multi', weworkA], ['wework-b-multi', weworkB], ['qq-multi', qq], ['other-multi', other]] as const) registerChannel(id, channel);
  attachChannel('wework-a-multi', 'chat-a', 'multi-owner');
  attachChannel('wework-b-multi', 'chat-b', 'multi-owner');
  attachChannel('qq-multi', 'c2c:qq-user', 'multi-owner');
  attachChannel('other-multi', 'room', 'multi-owner');
  await saveChannels();
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'multi-owner' }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverCommittedFinal', {
      sourceSessionId: 'multi-owner', turnId: 'multi-turn', outcome: 'response', text: 'one answer',
    }), { attempted: 4, delivered: 4 });
    const refreshA = await (weworkA as any).processInboundBody({ msgtype: 'stream', stream: { id: cardA.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
    const refreshB = await (weworkB as any).processInboundBody({ msgtype: 'stream', stream: { id: cardB.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
    assert.deepEqual([refreshA.passiveResponse.stream.content, refreshB.passiveResponse.stream.content], ['one answer', 'one answer']);
    assert.equal(refreshA.passiveResponse.stream.finish, true); assert.equal(refreshB.passiveResponse.stream.finish, true);
    assert.deepEqual(qqCalls.filter(body => body.content === 'one answer').map(body => body.msg_id), ['qq-latest-multi']);
    assert.deepEqual(otherSends, ['one answer']);
  } finally {
    transport.close();
    for (const id of ['wework-a-multi', 'wework-b-multi', 'qq-multi', 'other-multi']) unregisterChannel(id);
    resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});
