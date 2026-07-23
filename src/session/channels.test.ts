import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Channel, registerChannel, unregisterChannel } from '../channel';
import {
  attachChannel,
  attachChannelDurably,
  createChannelsStore,
  createSessionBroadcast,
  getChannelConfig,
  getSessionByChannel,
  importLegacyChannelAttachments,
  loadChannels,
  resetChannelsForTests,
  saveChannels,
  setChannelsStoreForTests,
} from './channels';

test('durable channel attach rolls back memory when persistence fails', async () => {
  await withTempDir(async dirPath => {
    const store = createChannelsStore(path.join(dirPath, 'channels.json'));
    const originalWrite = store.write.bind(store);
    let fail = true;
    (store as any).write = async (...args: any[]) => {
      if (fail) {
        fail = false;
        throw new Error('injected channel persistence failure');
      }
      return originalWrite(...args);
    };
    setChannelsStoreForTests(store);
    await assert.rejects(
      attachChannelDurably('failure-channel', 'failure-conversation', 'failure-session'),
      /injected channel persistence failure/,
    );
    assert.equal(getSessionByChannel('failure-channel', 'failure-conversation'), undefined);
    assert.equal(await attachChannelDurably('failure-channel', 'failure-conversation', 'failure-session'), 'failure-session');
  });
});

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-channels-store-'));
  try {
    await run(dirPath);
  } finally {
    resetChannelsForTests();
    setChannelsStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

async function listBackupMatches(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name === `${base}.bak` || name.startsWith(`${base}.`) && name.endsWith('.bak')).map((name) => path.join(dir, name));
}

test('channels persistence uses lightweight no-backup writes and normalizes legacy push-only mode to send-only', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'channels.json');
    setChannelsStoreForTests(createChannelsStore(filePath));
    resetChannelsForTests();

    await importLegacyChannelAttachments({
      'webui:alpha': { sessionId: 'session-alpha', mode: 'push-only' },
    });
    await importLegacyChannelAttachments({
      'webui:alpha': { sessionId: 'session-alpha', mode: 'push-only' },
      'telegram:beta': { sessionId: 'session-beta' },
    });

    resetChannelsForTests();
    await loadChannels();

    assert.deepEqual(getChannelConfig('webui', 'alpha'), {
      sessionId: 'session-alpha',
      mode: 'send-only',
    });
    assert.deepEqual(getChannelConfig('telegram', 'beta'), {
      sessionId: 'session-beta',
    });

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten.channels).sort(), ['telegram:beta', 'webui:alpha']);
    assert.deepEqual(createChannelsStore(filePath).listCandidatePaths(), [filePath]);
    assert.deepEqual(await listBackupMatches(filePath), []);
  });
});

test('createSessionBroadcast can target an empty platform finalization broadcast', async () => {
  await withTempDir(async (dirPath) => {
  setChannelsStoreForTests(createChannelsStore(path.join(dirPath, 'channels.json')));
  resetChannelsForTests();
  const sent: Array<{ channelId: string; conversationId: string; text: string; options: any }> = [];

  const makeChannel = (channelId: string): Channel => ({
    name: channelId,
    platform: channelId,
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    sendMessage: async (conversationId: string, text: string, options?: any) => {
      sent.push({ channelId, conversationId, text, options });
    },
  });

  registerChannel('wework-a', makeChannel('wework-a'));
  registerChannel('wework-b', makeChannel('wework-b'));
  try {
    attachChannel('wework-a', 'chat-a', 'session-1');
    attachChannel('wework-b', 'chat-b', 'session-1');
    await saveChannels();

    createSessionBroadcast('session-1')('', {
      allowEmptyBroadcast: true,
      targetChannel: { channelId: 'wework-a', conversationId: 'chat-a' },
      weworkStreamId: 'stream-a',
      turnFinal: true,
    });

    assert.deepEqual(sent.map(item => `${item.channelId}:${item.conversationId}`), ['wework-a:chat-a']);
    assert.equal(sent[0].text, '');
    assert.equal(sent[0].options.weworkStreamId, 'stream-a');
  } finally {
    unregisterChannel('wework-a');
    unregisterChannel('wework-b');
    resetChannelsForTests();
  }
  });
});
