import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('QQ Bot config is included in managed runtime status and disabled reloads', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-runtime-'));
  const configPath = path.join(tempDir, 'config.yaml');
  await fs.writeFile(configPath, [
    'channels:',
    '  qq-primary:',
    '    type: qqbot',
    '    enabled: false',
    '    appId: app-id',
    '    clientSecret: secret',
    '    allowedUsers:',
    '      - user-openid',
  ].join('\n'));
  process.env.FOXWARM_CONFIG_PATH = configPath;
  t.after(async () => {
    delete process.env.FOXWARM_CONFIG_PATH;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const runtime = await import('./channelRuntime');
  runtime.initializeChannelRuntime(async () => {});

  assert.deepEqual(runtime.getManagedChannelIds(), ['qq-primary']);
  assert.deepEqual(runtime.getChannelRuntimeStatus('qq-primary'), {
    channelId: 'qq-primary',
    type: 'qqbot',
    managed: true,
    running: false,
    channelName: undefined,
    configured: true,
    enabled: false,
    details: ['appId=configured', 'clientSecret=configured', 'allowedUsers=1'],
    lastError: undefined,
  });

  const reload = await runtime.reloadManagedChannels();
  assert.deepEqual(reload.stopped, []);
  assert.deepEqual(reload.started, []);
  assert.equal(reload.statuses.length, 1);
  assert.equal(reload.statuses[0].type, 'qqbot');
});
