import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createChannelsStore,
  getChannelConfig,
  importLegacyChannelAttachments,
  loadChannels,
  resetChannelsForTests,
  setChannelsStoreForTests,
} from './channels';

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
