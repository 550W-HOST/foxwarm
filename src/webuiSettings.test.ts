import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getLegacyWebUiSettingsPath, getWebUiSettingsPath, readWebUiSettings, writeWebUiSettings } from './webuiSettings';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-settings-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('webui settings path is rooted under data state dir, not program base dir', async () => {
  await withTempDir(async (dirPath) => {
    const baseDir = path.join(dirPath, 'program');
    const dataRoot = path.join(dirPath, 'data');
    const stateDir = path.join(dataRoot, 'state');
    const settingsPath = getWebUiSettingsPath(stateDir);
    const legacySettingsPath = getLegacyWebUiSettingsPath(baseDir);

    await fs.ensureDir(baseDir);
    const saved = writeWebUiSettings({ instanceName: '  Demo\nInstance  ', tabIcon: '  🚀  ' }, { settingsPath });

    assert.deepEqual(saved, { instanceName: 'Demo Instance', tabIcon: '🚀' });
    assert.equal(settingsPath, path.join(stateDir, 'webui.json'));
    assert.equal(legacySettingsPath, path.join(baseDir, 'state', 'webui.json'));
    assert.equal(await fs.pathExists(settingsPath), true);
    assert.equal(await fs.pathExists(legacySettingsPath), false);
    assert.deepEqual(await fs.readJson(settingsPath), { instanceName: 'Demo Instance', tabIcon: '🚀' });
  });
});

test('webui settings migrate from legacy base-dir state path when data state file is missing', async () => {
  await withTempDir(async (dirPath) => {
    const settingsPath = path.join(dirPath, 'data', 'state', 'webui.json');
    const legacySettingsPath = path.join(dirPath, 'program', 'state', 'webui.json');
    await fs.ensureDir(path.dirname(legacySettingsPath));
    await fs.writeJson(legacySettingsPath, { instanceName: 'Legacy Instance', tabIcon: '🧪' });

    const loaded = readWebUiSettings({ settingsPath, legacySettingsPath });

    assert.deepEqual(loaded, { instanceName: 'Legacy Instance', tabIcon: '🧪' });
    assert.deepEqual(await fs.readJson(settingsPath), { instanceName: 'Legacy Instance', tabIcon: '🧪' });
    assert.deepEqual(await fs.readJson(legacySettingsPath), { instanceName: 'Legacy Instance', tabIcon: '🧪' });
  });
});

test('webui settings prefer data state path over legacy base-dir path', async () => {
  await withTempDir(async (dirPath) => {
    const settingsPath = path.join(dirPath, 'data', 'state', 'webui.json');
    const legacySettingsPath = path.join(dirPath, 'program', 'state', 'webui.json');
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.ensureDir(path.dirname(legacySettingsPath));
    await fs.writeJson(settingsPath, { instanceName: 'State Instance', tabIcon: '📌' });
    await fs.writeJson(legacySettingsPath, { instanceName: 'Legacy Instance', tabIcon: '🧪' });

    const loaded = readWebUiSettings({ settingsPath, legacySettingsPath });

    assert.deepEqual(loaded, { instanceName: 'State Instance', tabIcon: '📌' });
  });
});
