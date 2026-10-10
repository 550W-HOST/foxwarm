import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'fs-extra';
import { APP_CONFIG_PATH, getActiveModelsConfigPath } from './config';
import { AccessConfigRuntime, normalizeAccessConfig } from './accessConfig';
import { ConfigInstaller } from './configInstaller';
import { HttpServer, setHttpServer } from './httpServer';
import { WebUIChannel } from './channels/webuiChannel';
import { getChannelInstance, unregisterChannel } from './channel';
import { initializeChannelRuntime, reloadManagedChannels, startManagedChannel } from './channelRuntime';
import { validateAppConfigYaml, validateModelsConfigYaml } from './setupConfig';
import * as sessionManager from './sessionManager';
import { initializeSessionRuntime, shutdownSessionRuntime } from './sessionRuntime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function heldReloadFixture() {
  const polls = new Set<http.ServerResponse>();
  let closing = false;
  const pollStarted = deferred();
  const upstream = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.includes('get_bot_qrcode')) {
      response.end(JSON.stringify({ qrcode: 'synthetic-qr', qrcode_img_content: 'synthetic-qr-content' }));
    } else if (request.url?.includes('get_qrcode_status')) {
      response.end(JSON.stringify({ status: 'confirmed', bot_token: 'synthetic-login-token', ilink_user_id: 'new-user' }));
    } else if (closing) {
      response.end(JSON.stringify({ ret: 0, msgs: [] }));
    } else {
      polls.add(response);
      response.once('close', () => polls.delete(response));
      pollStarted.resolve();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const initial = `url: https://old.example.invalid
access:
  identities:
    reader: { token: old-token, surfaces: { webui: { sessions: [main/*] } } }
channels:
  local-weixin: { type: weixin, token: synthetic-weixin, baseUrl: ${upstreamUrl}, longPollTimeoutMs: 30000 }
`;
  await fs.outputFile(APP_CONFIG_PATH, initial);
  await fs.outputFile(getActiveModelsConfigPath(), 'providers: { seed: { providerType: openai, models: [old-model] } }\ndefault: seed/old-model\n');
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  initializeChannelRuntime(async () => {});
  await startManagedChannel('local-weixin');
  await pollStarted.promise;
  const access = new AccessConfigRuntime(normalizeAccessConfig(validateAppConfigYaml(initial).access));
  const installer = new ConfigInstaller({ access, startupConfig: validateAppConfigYaml(initial), appPath: APP_CONFIG_PATH,
    modelsPath: getActiveModelsConfigPath, instanceToken: () => 'synthetic-admin', reloadChannels: reloadManagedChannels });
  installer.setHttpAvailable(true);
  // Observe supported installation admission without changing the queue or reload.
  let admissions = 0;
  const entered = new Map<number, ReturnType<typeof deferred>>();
  const observed = {
    install: (...args: Parameters<ConfigInstaller['install']>) => {
      entered.get(++admissions)?.resolve();
      return installer.install(...args);
    },
  } as ConfigInstaller;
  const expectAdmission = (number: number) => {
    const signal = deferred(); entered.set(number, signal); return signal.promise;
  };
  const server = new HttpServer(0, 'synthetic-admin');
  setHttpServer(server);
  await server.start();
  const base = `http://127.0.0.1:${(server as any).httpServer.address().port}`;
  const channel = new WebUIChannel({ token: 'synthetic-admin', enableTrigger: false, router: { handleMessage: async () => {} } as any,
    accessRuntime: access, configInstaller: observed });
  await channel.start();
  const requests: Promise<any>[] = [];
  const save = (endpoint: string, body: any) => {
    const request = fetch(`${base}/api/setup/${endpoint}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async response => { const result: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; });
    requests.push(request);
    return request;
  };
  const withoutChannel = initial.slice(0, initial.indexOf('channels:')) + 'channels: {}\n';
  const newer = withoutChannel.replace('old-token', 'rotated-token').replace('old.example.invalid', 'new.example.invalid');
  const releasePolls = () => {
    for (const response of [...polls]) {
      polls.delete(response);
      response.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: '' }));
    }
  };
  const beginHeldSave = async () => {
    const published = deferred();
    const unsubscribe = access.subscribe(() => { published.resolve(); });
    const admission = expectAdmission(1);
    const pending = save('config', { yaml: withoutChannel });
    await admission;
    await published.promise;
    unsubscribe();
    assert.equal(await fs.readFile(APP_CONFIG_PATH, 'utf8'), withoutChannel);
    // Real Weixin stop waits for the held local getupdates HTTP response.
    return { pending };
  };
  return { access, upstreamUrl, newer, save, expectAdmission, beginHeldSave, releasePolls,
    async finish(...pending: Promise<any>[]) {
      releasePolls();
      const results = await Promise.all(pending);
      for (const result of results.filter(item => item.saved)) assert.deepEqual(result.notApplied, []);
      return results;
    },
    async close() {
      closing = true;
      releasePolls();
      await Promise.allSettled(requests);
      const stops = ['local-weixin', 'login-weixin'].flatMap(id => {
        const instance = getChannelInstance(id);
        return instance ? [instance.stop().finally(() => unregisterChannel(id))] : [];
      });
      releasePolls();
      await Promise.all(stops);
      await channel.stop();
      await server.stop();
      setHttpServer(null);
      await shutdownSessionRuntime();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

test('queued Channels save preserves a preceding full Config token, URL, and raw surrounding text', { timeout: 30_000 }, async () => {
  const fixture = await heldReloadFixture();
  try {
    const { pending: first } = await fixture.beginHeldSave();
    const secondAdmitted = fixture.expectAdmission(2);
    const second = fixture.save('config', { yaml: `# Preserve the latest document\n${fixture.newer}` });
    await secondAdmitted;
    const thirdAdmitted = fixture.expectAdmission(3);
    const third = fixture.save('channels', { channels: {} });
    await thirdAdmitted;
    await fixture.finish(first, second, third);
    const raw = await fs.readFile(APP_CONFIG_PATH, 'utf8');
    const config = validateAppConfigYaml(raw);
    assert.equal(config.url, 'https://new.example.invalid');
    assert.equal(fixture.access.snapshot.identities.reader.token, 'rotated-token');
    assert.match(raw, /^# Preserve the latest document/);
    assert.deepEqual(config.channels, {});
  } finally { await fixture.close(); }
});

test('queued structured Models save merges the latest providers and extension fields', { timeout: 30_000 }, async () => {
  const fixture = await heldReloadFixture();
  try {
    const { pending: first } = await fixture.beginHeldSave();
    const secondAdmitted = fixture.expectAdmission(2);
    const second = fixture.save('models', { yaml: 'customSetting: latest\nproviders: { fresh: { providerType: openai, models: [new-model] }, seed: { providerType: openai, models: [old-model], customField: latest } }\ndefault: fresh/new-model\n' });
    await secondAdmitted;
    const thirdAdmitted = fixture.expectAdmission(3);
    const third = fixture.save('models', { providerKey: 'seed', providerType: 'openai', models: 'structured-model', defaultModel: 'seed/structured-model' });
    await thirdAdmitted;
    await fixture.finish(first, second, third);
    const config = validateModelsConfigYaml(await fs.readFile(getActiveModelsConfigPath(), 'utf8'));
    assert.deepEqual(Object.keys(config.providers).sort(), ['fresh', 'seed']);
    assert.equal(config.providers.seed.customField, 'latest');
    assert.equal(config.customSetting, 'latest');
    assert.deepEqual(config.providers.seed.models, ['structured-model']);
    assert.equal(config.default, 'seed/structured-model');
  } finally { await fixture.close(); }
});

test('queued Weixin login merges only its channel against the latest app configuration', { timeout: 30_000 }, async () => {
  const fixture = await heldReloadFixture();
  try {
    const login = await fixture.save('weixin/login/start', { channelId: 'login-weixin', baseUrl: fixture.upstreamUrl });
    const { pending: first } = await fixture.beginHeldSave();
    const secondAdmitted = fixture.expectAdmission(2);
    const latest = fixture.newer.replace('channels: {}', `channels:\n  other-weixin: { type: weixin, enabled: false, customField: retained }\n  login-weixin: { type: weixin, enabled: false, allowedUsers: [latest-user], customField: latest }`);
    const second = fixture.save('config', { yaml: latest });
    await secondAdmitted;
    const thirdAdmitted = fixture.expectAdmission(3);
    const third = fixture.save('weixin/login/wait', { sessionKey: login.sessionKey, channelId: 'login-weixin', baseUrl: fixture.upstreamUrl });
    await thirdAdmitted;
    const results = await fixture.finish(first, second, third);
    assert.equal(results[2].connected, true);
    const config = validateAppConfigYaml(await fs.readFile(APP_CONFIG_PATH, 'utf8'));
    assert.equal(config.url, 'https://new.example.invalid');
    assert.equal(fixture.access.snapshot.identities.reader.token, 'rotated-token');
    const channels = config.channels as any;
    assert.equal(channels['other-weixin'].customField, 'retained');
    assert.equal(channels['login-weixin'].customField, 'latest');
    assert.deepEqual(channels['login-weixin'].allowedUsers, ['latest-user', 'new-user']);
    assert.equal(channels['login-weixin'].token, 'synthetic-login-token');
  } finally { await fixture.close(); }
});
