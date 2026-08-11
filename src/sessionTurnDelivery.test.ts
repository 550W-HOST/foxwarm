import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { registerChannel, unregisterChannel, type Channel, type ChannelContext } from './channel';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { attachChannel, createChannelsStore, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor } from './sessionTurnDelivery';
import { QQBotChannel } from './channels/qqbotChannel';

const source = {
  platform: 'telegram', channelId: 'telegram', channelType: 'telegram',
  channelUserId: 'room', conversationId: 'room', preferDirectReply: true as const,
};

function fakeContext(conversationId = 'room', replies: any[] = []): ChannelContext {
  return {
    platform: 'telegram', channelId: 'telegram', channelType: 'telegram', channelUserId: conversationId, conversationId,
    preferDirectReply: true, reply: async (text, options) => { replies.push({ text, options }); }, sendTyping: async () => {},
  };
}

test('committed-final handler uses exact direct context and awaited attachment fallback semantics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-delivery-'));
  setChannelsStoreForTests(createChannelsStore(path.join(root, 'channels.json'))); resetChannelsForTests();
  const sent: any[] = [];
  const channel = (id: string, fail = false): Channel => ({
    name: id, platform: id, start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
    sendMessage: async (conversationId, text, options) => {
      sent.push({ id, conversationId, text, options }); if (fail) throw new Error(`${id} failed`);
    },
  });
  for (const [id, fail] of [['telegram', false], ['secondary', true], ['webui', false], ['wework', false], ['qqbot', false]] as const) registerChannel(id, channel(id, fail));
  attachChannel('telegram', 'room', 'owner'); attachChannel('secondary', 'other', 'owner');
  attachChannel('webui', 'browser', 'owner'); attachChannel('wework', 'stream-room', 'owner');
  await saveChannels();
  const replies: any[] = []; let resolved: ChannelContext | undefined = fakeContext('room', replies); let resolverError: Error | undefined; let resolverCalls = 0;
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({
    expectedSourceSessionId: 'owner', resolveExactSourceContext: () => {
      resolverCalls += 1; if (resolverError) throw resolverError; return resolved;
    },
  }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'direct' }), { attempted: 1, delivered: 1 });
    assert.equal(replies[0].text, 'direct'); assert.equal(replies[0].options.turnFinal, true); assert.equal(sent.length, 0);
    assert.equal(resolverCalls, 1);

    resolved = fakeContext('wrong-room');
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'fallback' }), { attempted: 3, delivered: 2 });
    assert.deepEqual(sent.map(item => item.id), ['telegram', 'secondary', 'wework']);
    assert.equal(sent.every(item => item.options.excludePlatforms.includes('webui')), true);

    sent.length = 0; resolverError = new Error('lookup unavailable');
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'lookup fallback' }), { attempted: 3, delivered: 2 });
    assert.equal(sent.filter(item => item.id === 'telegram').length, 1);
    resolverError = undefined;

    sent.length = 0; let directAttempts = 0;
    resolved = { ...fakeContext('room'), reply: async () => { directAttempts += 1; throw new Error('direct ambiguous'); } };
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'direct fails' }), { attempted: 1, delivered: 0 });
    assert.equal(directAttempts, 1); assert.equal(sent.length, 0);

    resolved = undefined; sent.length = 0;
    const streamSource = { platform: 'wework', channelId: 'wework', channelType: 'wework', channelUserId: 'stream-room', conversationId: 'stream-room', weworkStreamId: 'stream-1' };
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source: streamSource, outcome: 'empty-final', text: '' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(sent.map(item => item.id), ['wework']); assert.equal(sent[0].options.allowEmptyBroadcast, true);

    sent.length = 0;
    const resolverCallsBeforeFalse = resolverCalls;
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source: { ...source, preferDirectReply: undefined }, outcome: 'error', text: 'failed turn' }), { attempted: 4, delivered: 3 });
    assert.equal(resolverCalls, resolverCallsBeforeFalse);
    assert.equal(sent.some(item => item.id === 'webui'), true, 'error final preserves ordinary broadcast inclusion');
    await assert.rejects(() => client.call('deliverCommittedFinal', { sourceSessionId: 'wrong', source, outcome: 'response', text: 'x' }), { code: 'SESSION_TURN_DELIVERY_SOURCE_MISMATCH' });

    const emptyRegistry = new RpcServiceRegistry();
    emptyRegistry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'empty-owner' }));
    const emptyTransport = new LocalRpcTransport(emptyRegistry); const emptyClient = new RpcClient(sessionTurnDeliveryServiceDescriptor, emptyTransport);
    try {
      assert.deepEqual(await emptyClient.call('deliverCommittedFinal', { sourceSessionId: 'empty-owner', source: { platform: 'test', channelUserId: 'none' }, outcome: 'response', text: 'nobody' }), { attempted: 0, delivered: 0 });
    } finally { emptyTransport.close(); }

    attachChannel('qqbot', 'qq-room', 'qq-owner'); await saveChannels();
    const qqSource = { platform: 'qqbot', channelId: 'qqbot', channelType: 'qqbot', channelUserId: 'qq-room', conversationId: 'qq-room', qqbotMessageId: 'qq-msg-1', preferDirectReply: true as const };
    let qqContext: ChannelContext | undefined = {
      platform: 'qqbot', channelId: 'qqbot', channelType: 'qqbot', channelUserId: 'qq-room', conversationId: 'qq-room',
      qqbotMessageId: 'qq-msg-1', preferDirectReply: true, reply: async (text, options) => { replies.push({ text, options }); }, sendTyping: async () => {},
    };
    const qqRegistry = new RpcServiceRegistry();
    qqRegistry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'qq-owner', resolveExactSourceContext: () => qqContext }));
    const qqTransport = new LocalRpcTransport(qqRegistry); const qqClient = new RpcClient(sessionTurnDeliveryServiceDescriptor, qqTransport);
    try {
      assert.deepEqual(await qqClient.call('deliverCommittedFinal', { sourceSessionId: 'qq-owner', source: qqSource, outcome: 'response', text: 'qq direct' }), { attempted: 1, delivered: 1 });
      assert.equal(replies.at(-1).options.qqbotMessageId, 'qq-msg-1');
      qqContext = { ...qqContext!, qqbotMessageId: 'concurrent-wrong-msg' };
      sent.length = 0;
      assert.deepEqual(await qqClient.call('deliverCommittedFinal', { sourceSessionId: 'qq-owner', source: qqSource, outcome: 'response', text: 'qq fallback' }), { attempted: 1, delivered: 1 });
      assert.equal(sent[0].id, 'qqbot'); assert.equal(sent[0].options.qqbotMessageId, 'qq-msg-1');
    } finally { qqTransport.close(); }
  } finally {
    transport.close(); for (const id of ['telegram', 'secondary', 'webui', 'wework', 'qqbot']) unregisterChannel(id);
    resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});

test('Worker intermediate delivery preserves QQ latest passive ID and monotonic sequence before final', async () => {
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
  const source = {
    platform: 'qqbot', channelId: 'qq-worker-delivery', channelType: 'qqbot',
    channelUserId: 'c2c:openid-worker', conversationId: 'c2c:openid-worker',
    qqbotMessageId: 'stale-fallback-id',
  };
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({ expectedSourceSessionId: 'worker-owner' }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverIntermediateText', { sourceSessionId: 'worker-owner', source, text: 'intermediate-1' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(await client.call('deliverIntermediateText', { sourceSessionId: 'worker-owner', source, text: 'intermediate-2' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'worker-owner', source, outcome: 'response', text: 'final' }), { attempted: 1, delivered: 1 });
    const messages = calls.filter(call => new URL(call.url).pathname.endsWith('/messages'));
    assert.deepEqual(messages.map(call => call.body.msg_id), ['latest-passive-id', 'latest-passive-id', 'latest-passive-id']);
    assert.deepEqual(messages.map(call => call.body.msg_seq), [1, 2, 3]);
    assert.deepEqual(messages.map(call => call.body.content), ['intermediate-1', 'intermediate-2', 'final']);
  } finally {
    transport.close(); unregisterChannel('qq-worker-delivery'); resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});
