import '../testEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import { AccessConfigRuntime, normalizeAccessConfig } from '../accessConfig';
import { APP_CONFIG_PATH, getActiveModelsConfigPath } from '../config';
import { ConfigInstaller } from '../configInstaller';
import { HttpServer } from '../httpServer';
import { registerWebUiSetupRoutes } from './webuiSetup';

const llm = require('../llm') as typeof import('../llm');

async function setupFixture() {
  const token = 'synthetic-setup-admin';
  const rawConfig = '# Preserve app comments\nchannels: {}\n';
  await fs.outputFile(APP_CONFIG_PATH, rawConfig);
  await fs.remove(getActiveModelsConfigPath());
  const installer = new ConfigInstaller({
    access: new AccessConfigRuntime(normalizeAccessConfig(undefined)),
    startupConfig: {},
    appPath: APP_CONFIG_PATH,
    modelsPath: getActiveModelsConfigPath,
    instanceToken: () => token,
    reloadChannels: async () => ({ stopped: [], started: [], statuses: [] }),
  });
  const server = new HttpServer(0, token);
  server.setWebUiIdentityVerifier(value => value === 'synthetic-setup-reader'
    ? { role: 'webui', identityId: 'reader', sessionIds: ['main/example'] }
    : null);
  registerWebUiSetupRoutes(server, installer);
  await server.start();
  const base = `http://127.0.0.1:${(server as any).httpServer.address().port}`;
  const request = (route: string, body?: unknown, bearer: string = token) => fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { rawConfig, request, close: () => server.stop() };
}

test('Setup and model catalog routes reject anonymous and restricted WebUI identities before handling requests', async () => {
  const fixture = await setupFixture();
  try {
    const routes: [string, unknown?][] = [
      ['/api/models'], ['/api/setup/status'], ['/api/setup/models', {}],
      ['/api/setup/models/list', {}], ['/api/setup/models/test', {}],
      ['/api/setup/config', {}],
      ['/api/setup/weixin/login/start', {}], ['/api/setup/weixin/login/wait', {}],
    ];
    for (const [route, body] of routes) {
      assert.equal((await fixture.request(route, body, '')).status, 401, route);
      assert.equal((await fixture.request(route, body, 'synthetic-setup-reader')).status, 403, route);
    }
    assert.equal(await fs.readFile(APP_CONFIG_PATH, 'utf8'), fixture.rawConfig);
    assert.equal(await fs.pathExists(getActiveModelsConfigPath()), false);
  } finally { await fixture.close(); }
});

test('Setup status and model catalog reflect raw model saves, current selection, and validation failures', async () => {
  const fixture = await setupFixture();
  try {
    const before = await fixture.request('/api/setup/status');
    assert.equal(before.status, 200);
    const initial = await before.json() as any;
    assert.equal(initial.oobe, true);
    assert.equal(initial.models.exists, false);
    assert.equal(initial.config.rawYaml, fixture.rawConfig);
    assert.equal(initial.config.appConfigPath, APP_CONFIG_PATH);
    assert.equal(initial.config.channelCount, 0);
    assert.equal(initial.config.channelsYaml, '{}\n');

    const yaml = '# Keep model formatting\nproviders:\n  local: {providerType: openai-completions, apiKey: synthetic-secret, models: [first, second]}\ndefault: local/first\n';
    const saved = await fixture.request('/api/setup/models', { yaml });
    assert.equal(saved.status, 200);
    const result = await saved.json() as any;
    assert.equal(result.success, true);
    assert.equal(result.models.oobe, false);
    assert.equal(result.models.rawYaml, yaml);
    assert.equal(result.payload.defaultKey, 'local/first');
    const catalog = await fixture.request('/api/models?current=local%2Fsecond');
    assert.equal(catalog.status, 200);
    const payload = await catalog.json() as any;
    assert.equal(payload.currentKey, 'local/second');
    assert.deepEqual(payload.models.map((entry: any) => entry.key), ['local/first', 'local/second']);
    assert.equal(JSON.stringify(payload).includes('synthetic-secret'), false);
    const status = await (await fixture.request('/api/setup/status')).json() as any;
    assert.equal(status.oobe, false);
    assert.equal(status.models.rawYaml, yaml);

    const invalid = await fixture.request('/api/setup/models', { yaml: 'providers: [' });
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json() as any).error, 'string');
    assert.equal(await fs.readFile(getActiveModelsConfigPath(), 'utf8'), yaml);
  } finally { await fixture.close(); }
});

test('Setup model probes use transient selection without Session notifications and distinguish text from request errors', async t => {
  const fixture = await setupFixture();
  const calls: Parameters<typeof llm.requestLlmOnce>[0][] = [];
  let failure = false;
  t.mock.method(llm, 'requestLlmOnce', async (options: Parameters<typeof llm.requestLlmOnce>[0]) => {
    calls.push(options);
    if (failure) throw new Error('Synthetic provider failure');
    return { text: 'Error: is ordinary successful model text' };
  });
  const body = { providerKey: 'draft', providerType: 'openai-completions', baseUrl: 'https://provider.invalid/v1',
    apiKey: 'synthetic-probe-key', models: 'first, second', testModel: ' second ' };
  try {
    const response = await fixture.request('/api/setup/models/test', body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, text: 'Error: is ordinary successful model text', usage: null });
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.modelEntryOverride.model, 'second');
    assert.equal(options.modelEntryOverride.providerKey, 'draft');
    assert.equal(options.modelEntryOverride.apiKey, body.apiKey);
    assert.equal(options.modelEntryOverride.baseUrl, body.baseUrl);
    assert.equal(options.notifySessionEvents, false);
    assert.equal(options.registerAbortController, false);
    assert.equal(options.maxRetries, 1);
    assert.equal(options.timeoutMs, 30000);
    assert.equal(options.purpose, 'setup-test');
    assert.deepEqual(options.toolDefinitions, []);

    failure = true;
    const failed = await fixture.request('/api/setup/models/test', body);
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { success: false, error: 'Synthetic provider failure' });
    const unsupported = await fixture.request('/api/setup/models/test', { ...body, providerType: 'failover' });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(await unsupported.json(), { success: false, error: 'Provider type `failover` cannot be tested. Choose a concrete protocol.' });
    assert.equal(calls.length, 2);
    assert.equal(await fs.pathExists(getActiveModelsConfigPath()), false);
  } finally { await fixture.close(); }
});
