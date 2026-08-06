import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { registerChannel, unregisterChannel, type Channel, type ChannelContext } from './channel';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { attachChannel, createChannelsStore, resetChannelsForTests, saveChannels, setChannelsStoreForTests } from './session/channels';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor } from './sessionTurnDelivery';

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
  for (const [id, fail] of [['telegram', false], ['secondary', true], ['webui', false], ['wework', false]] as const) registerChannel(id, channel(id, fail));
  attachChannel('telegram', 'room', 'owner'); attachChannel('secondary', 'other', 'owner');
  attachChannel('webui', 'browser', 'owner'); attachChannel('wework', 'stream-room', 'owner');
  await saveChannels();
  const replies: any[] = []; let resolved: ChannelContext | undefined = fakeContext('room', replies);
  const registry = new RpcServiceRegistry();
  registry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({
    expectedSourceSessionId: 'owner', resolveExactSourceContext: () => resolved,
  }));
  const transport = new LocalRpcTransport(registry); const client = new RpcClient(sessionTurnDeliveryServiceDescriptor, transport);
  try {
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'direct' }), { attempted: 1, delivered: 1 });
    assert.equal(replies[0].text, 'direct'); assert.equal(replies[0].options.turnFinal, true); assert.equal(sent.length, 0);

    resolved = fakeContext('wrong-room');
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source, outcome: 'response', text: 'fallback' }), { attempted: 3, delivered: 2 });
    assert.deepEqual(sent.map(item => item.id), ['telegram', 'secondary', 'wework']);
    assert.equal(sent.every(item => item.options.excludePlatforms.includes('webui')), true);

    resolved = undefined; sent.length = 0;
    const streamSource = { platform: 'wework', channelId: 'wework', channelType: 'wework', channelUserId: 'stream-room', conversationId: 'stream-room', weworkStreamId: 'stream-1' };
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source: streamSource, outcome: 'empty-final', text: '' }), { attempted: 1, delivered: 1 });
    assert.deepEqual(sent.map(item => item.id), ['wework']); assert.equal(sent[0].options.allowEmptyBroadcast, true);

    sent.length = 0;
    assert.deepEqual(await client.call('deliverCommittedFinal', { sourceSessionId: 'owner', source: { ...source, preferDirectReply: undefined }, outcome: 'error', text: 'failed turn' }), { attempted: 4, delivered: 3 });
    assert.equal(sent.some(item => item.id === 'webui'), true, 'error final preserves ordinary broadcast inclusion');
    await assert.rejects(() => client.call('deliverCommittedFinal', { sourceSessionId: 'wrong', source, outcome: 'response', text: 'x' }), { code: 'SESSION_TURN_DELIVERY_SOURCE_MISMATCH' });
  } finally {
    transport.close(); for (const id of ['telegram', 'secondary', 'webui', 'wework']) unregisterChannel(id);
    resetChannelsForTests(); setChannelsStoreForTests(null); await fs.remove(root);
  }
});
