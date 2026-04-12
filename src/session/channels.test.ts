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

test('channels persistence recovers from backup candidate after primary corruption', async () => {
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

    await fs.writeFile(filePath, '{broken-json');
    resetChannelsForTests();
    await loadChannels();

    assert.deepEqual(getChannelConfig('webui', 'alpha'), {
      sessionId: 'session-alpha',
      mode: 'push-only',
    });
    assert.equal(getChannelConfig('telegram', 'beta'), undefined);

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten.channels).sort(), ['webui:alpha']);
  });
});
