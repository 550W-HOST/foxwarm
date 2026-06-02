import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getWebUiSettingsPath, readWebUiSettings, writeWebUiSettings } from './webuiSettings';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-settings-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('webui settings path is rooted under data state dir', async () => {
  await withTempDir(async (dirPath) => {
    const stateDir = path.join(dirPath, 'data', 'state');
    const settingsPath = getWebUiSettingsPath(stateDir);

    const saved = writeWebUiSettings({ instanceName: '  Demo\nInstance  ', tabIcon: '  🚀  ' }, { settingsPath });

    assert.deepEqual(saved, { instanceName: 'Demo Instance', tabIcon: '🚀' });
    assert.equal(settingsPath, path.join(stateDir, 'webui.json'));
    assert.equal(await fs.pathExists(settingsPath), true);
    assert.deepEqual(await fs.readJson(settingsPath), { instanceName: 'Demo Instance', tabIcon: '🚀' });
  });
});

test('webui settings returns defaults when file does not exist', async () => {
  await withTempDir(async (dirPath) => {
    const settingsPath = path.join(dirPath, 'nonexistent', 'webui.json');

    const loaded = readWebUiSettings({ settingsPath });

    assert.deepEqual(loaded, { instanceName: '', tabIcon: '' });
  });
});

test('webui settings reads existing file correctly', async () => {
  await withTempDir(async (dirPath) => {
    const settingsPath = path.join(dirPath, 'state', 'webui.json');
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, { instanceName: 'My Instance', tabIcon: '📌' });

    const loaded = readWebUiSettings({ settingsPath });

    assert.deepEqual(loaded, { instanceName: 'My Instance', tabIcon: '📌' });
  });
});
