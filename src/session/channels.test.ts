import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Channel, registerChannel, unregisterChannel } from '../channel';
import { APP_CONFIG_PATH } from '../config';
import {
  attachChannel,
  attachChannelDurably,
  createChannelsStore,
  createSessionBroadcast,
  getChannelConfig,
  getSessionByChannel,
  importLegacyChannelAttachments,
  loadChannels,
  finishChannelTurnProgress,
  reportChannelTurnProgress,
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

test('createSessionBroadcast sends empty final lifecycle to every capable attachment without empty messages', async () => {
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
    handleTurnLifecycle: async (conversationId: string, options?: any) => {
      sent.push({ channelId, conversationId, text: '<lifecycle>', options });
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
      turnFinal: true,
    });

    assert.deepEqual(sent.map(item => `${item.channelId}:${item.conversationId}`), ['wework-a:chat-a', 'wework-b:chat-b']);
    assert.ok(sent.every(item => item.text === '<lifecycle>' && item.options.turnFinal === true));
  } finally {
    unregisterChannel('wework-a');
    unregisterChannel('wework-b');
    resetChannelsForTests();
  }
  });
});

test('configured progress targets exclude WebUI and use source-blind turn metadata', async () => {
  await withTempDir(async dirPath => {
    setChannelsStoreForTests(createChannelsStore(path.join(dirPath, 'channels.json')));
    const previousConfig = await fs.pathExists(APP_CONFIG_PATH) ? await fs.readFile(APP_CONFIG_PATH, 'utf8') : undefined;
    await fs.ensureDir(path.dirname(APP_CONFIG_PATH));
    await fs.writeFile(APP_CONFIG_PATH, `channels:\n  qq:\n    type: qqbot\n    channelProgress: { intervalMs: 30000 }\n  telegram:\n    type: telegram\n    channelProgress: { intervalMs: 60000 }\n  webui:\n    type: webui\n    channelProgress: { intervalMs: 30000 }\n  wework:\n    type: wework\n    channelProgress: { intervalMs: 30000 }\n`);
    const sent: Array<{ id: string; text: string; options: any }> = [];
    const lifecycle: any[] = [];
    const register = (id: string, platform = id) => registerChannel(id, {
      name: id, platform, start: async () => {}, stop: async () => {}, onMessage: () => {}, sendTyping: async () => {},
      sendMessage: async (_conversationId, text, options) => { sent.push({ id, text, options }); },
      ...(id === 'wework' ? {
        isTurnLifecycleActive: () => true,
        handleTurnLifecycle: async (_conversationId: string, options: any) => { lifecycle.push(options); },
      } : {}),
    });
    for (const [id, platform] of [['qq', 'qqbot'], ['telegram', 'telegram'], ['webui', 'webui'], ['wework', 'wework']] as const) register(id, platform);
    try {
      for (const id of ['qq', 'telegram', 'webui', 'wework']) attachChannel(id, 'room', 'progress-session');
      reportChannelTurnProgress('progress-session', 'native-turn', {
        type: 'tool-calls-start', calls: [{ id: 'read-1', name: 'read' }],
      });
      await finishChannelTurnProgress('native-turn');
      assert.deepEqual(sent.map(item => item.id).sort(), ['qq', 'telegram']);
      assert.deepEqual(lifecycle, [{
        channelProgressTurnId: 'native-turn',
        channelTurnProgress: { type: 'tool-calls-start', calls: [{ id: 'read-1', name: 'read' }] },
      }]);
      const qq = sent.find(item => item.id === 'qq')!;
      assert.equal(qq.text, '⏳ Tools: read ×1');
      assert.deepEqual(qq.options, { channelProgressTurnId: 'native-turn' });
      assert.equal(sent.some(item => item.id === 'webui'), false);
    } finally {
      for (const id of ['qq', 'telegram', 'webui', 'wework']) unregisterChannel(id);
      if (previousConfig === undefined) await fs.remove(APP_CONFIG_PATH);
      else await fs.writeFile(APP_CONFIG_PATH, previousConfig);
    }
  });
});
