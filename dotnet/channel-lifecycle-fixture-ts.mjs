// Reference runtime's cross-instance stop while reload is joining an existing Weixin handler.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = await mkdtemp(join(tmpdir(), 'foxwarm-channel-lifecycle-'));
await mkdir(join(root, 'state'));
await writeFile(join(root, 'state/config.yaml'), JSON.stringify({ channels: { alpha: { type: 'telegram', enabled: false }, weixin: { type: 'weixin', enabled: false } } }));
process.env.FOXWARM_DATA_DIR = root;
const require = createRequire(import.meta.url);
const runtime = require(resolve(process.env.FOXWARM_TS_ROOT || '.', 'lib/channelRuntime.js'));
const registry = require(resolve(process.env.FOXWARM_TS_ROOT || '.', 'lib/channel.js'));
let beginStop, finishHandler;
const entered = new Promise(done => { beginStop = done; });
const handler = new Promise(done => { finishHandler = done; });
runtime.initializeChannelRuntime(async () => {});
registry.registerChannel('alpha', { name: 'alpha', platform: 'telegram', async stop() {}, async start() {}, async sendMessage() {}, async sendTyping() {}, onMessage() {} });
registry.registerChannel('weixin', { name: 'weixin', platform: 'weixin', async stop() { beginStop(); await handler; }, async start() {}, async sendMessage() {}, async sendTyping() {}, onMessage() {} });
try {
  const reloading = runtime.reloadManagedChannels();
  await entered;
  const command = await runtime.stopManagedChannel('alpha');
  assert.equal(command.stopped, false);
  finishHandler();
  const result = await reloading;
  assert.deepEqual(result.stopped, ['alpha', 'weixin']);
  console.log('CHANNEL_LIFECYCLE_FIXTURE:' + JSON.stringify({ crossInstanceControlCompletes: true, stopped: result.stopped }));
} finally { finishHandler(); await rm(root, { recursive: true, force: true }); }
