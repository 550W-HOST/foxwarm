import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { AccessConfigRuntime, normalizeAccessConfig } from './accessConfig';
import { ConfigInstaller } from './configInstaller';

const identity = (token: string) => ({ identities: { reader: { token, surfaces: { webui: { sessions: ['main/*'] } } } } });

test('configuration installation preserves raw documents, rejects before saving, and reports partial application and pending restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-install-'));
  const appPath = path.join(dir, 'config.yaml');
  const modelsPath = path.join(dir, 'models.yaml');
  const access = new AccessConfigRuntime(normalizeAccessConfig(undefined));
  let failReload = false;
  let reloads = 0;
  const installer = new ConfigInstaller({ access, startupConfig: {}, appPath, modelsPath: () => modelsPath,
    instanceToken: () => 'synthetic-superuser',
    reloadChannels: async () => { reloads++; if (failReload) throw new Error('synthetic failure'); return { stopped: [], started: [], statuses: [] }; },
  });
  try {
    const raw = '# Preserve quoting and ordering\nbot: { name: "new-name" }\naccess:\n  identities:\n    reader:\n      token: synthetic-reader\n      surfaces: { webui: { sessions: [main/*] } }\nchannels: {}\n';
    const installed = await installer.install('config', Buffer.from(raw));
    assert.equal(await fs.readFile(appPath, 'utf8'), raw);
    assert.equal(access.snapshot.identities.reader.token, 'synthetic-reader');
    assert.deepEqual(installed.restartRequired, ['bot']);
    const snapshot = access.snapshot;
    for (const invalid of ['access: { identities: { broken: {} } }', 'access:\n  identities:\n    reader:\n      token: synthetic-superuser\n      surfaces: { mcp: {} }']) {
      await assert.rejects(() => installer.install('config', invalid));
      assert.equal(access.snapshot, snapshot);
      assert.equal(await fs.readFile(appPath, 'utf8'), raw);
    }
    const models = '# exact models text\nproviders:\n  synthetic:\n    providerType: openai\n    models: [synthetic-model]\ndefault: synthetic/synthetic-model\n';
    await installer.install('models', models);
    assert.equal(await fs.readFile(modelsPath, 'utf8'), models);
    await assert.rejects(() => installer.install('models', 'providers: { bad: { providerType: failover, targets: [] } }'));
    assert.equal(await fs.readFile(modelsPath, 'utf8'), models);

    failReload = true;
    const partial = await installer.install('config', raw.replace('synthetic-reader', 'synthetic-rotated'));
    assert.equal(partial.saved, true);
    assert.deepEqual(partial.notApplied, ['channels']);
    assert.deepEqual(partial.restartRequired, ['bot']);
    assert.equal(access.snapshot.identities.reader.token, 'synthetic-rotated');
    assert.equal(reloads, 2);

    const unsubscribe = access.subscribe(() => { throw new Error('synthetic close failure'); });
    const cleanupFailure = await installer.install('config', raw);
    assert.deepEqual(cleanupFailure.notApplied, ['access.connections', 'channels']);
    assert.equal(access.snapshot.identities.reader.token, 'synthetic-reader');
    unsubscribe();
  } finally { await fs.remove(dir); }
});

test('live access change sets are surface-specific and an unavailable HTTP listener is reported truthfully', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-access-'));
  const access = new AccessConfigRuntime(normalizeAccessConfig(identity('reader-token')));
  const changes: { webui: string[]; mcp: string[] }[] = [];
  access.subscribe(change => { changes.push({ webui: [...change.webui], mcp: [...change.mcp] }); });
  const installer = new ConfigInstaller({ access, startupConfig: { url: 'https://synthetic.example.invalid/foxwarm' }, appPath: path.join(dir, 'config.yaml'),
    modelsPath: () => path.join(dir, 'models.yaml'), instanceToken: () => '',
    reloadChannels: async () => ({ stopped: [], started: [], statuses: [] }),
  });
  try {
    const raw = 'url: https://synthetic.example.invalid/foxwarm/\naccess:\n  identities:\n    reader:\n      token: reader-token\n      surfaces: { mcp: {}, webui: { sessions: [main/only] } }\n';
    const unavailable = await installer.install('config', raw);
    assert.deepEqual(unavailable.restartRequired, ['access.surfaces.mcp']);
    assert.deepEqual(changes[0], { webui: ['reader'], mcp: [] });
    installer.setHttpAvailable(true);
    assert.deepEqual((await installer.install('config', raw)).restartRequired, []);
    assert.deepEqual(changes[1], { webui: [], mcp: [] });
  } finally { await fs.remove(dir); }
});
