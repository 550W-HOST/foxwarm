import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOAuthFetch } from './mcpOAuthHttp';
import { McpOAuthService, setMcpOAuthServiceForTests, oauthPublicUrl } from './mcpOAuth';
import { createMcpOAuthFixture } from './mcpOAuthTestFixture';
import * as client from './mcpClient';
import { closeMcpCallerConnections } from './mcpCallerConnections';
import { HttpServer } from './httpServer';
import { registerMcpOAuthRoutes } from './mcpOAuthRoutes';
import { McpInboundHttpService } from './mcpInboundHttp';
import { McpInboundMcpCatalog } from './mcpInboundCatalog';
import { normalizeAccessConfig } from './accessConfig';
import { setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function environment() {
  const remote = await createMcpOAuthFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-mcp-oauth-'));
  const store = client.createMcpConfigStore(path.join(directory, 'mcp.json'));
  client.setMcpConfigStoreForTests(store);
  const serviceOptions = { filePath: path.join(directory, 'mcp-oauth.json'), publicBaseUrl: 'https://localhost/preview',
    getServer: async (name: string) => (await client.getServers())[name] };
  const service = new McpOAuthService(serviceOptions);
  setMcpOAuthServiceForTests(service);
  remote.state.fetchClientMetadata = async url => {
    assert.equal(url, service.clientMetadata().client_id);
    return service.clientMetadata();
  };
  await client.upsertServer('remote', { transport: 'streamable-http', url: remote.resource, oauth: { scope: 'read' }, headers: { 'X-API-Key': 'resource-only-api-key' } });
  const authorize = async (name = 'remote', target = service) => {
    const config = (await client.getServers())[name];
    const url = await target.begin(name, config);
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 303);
    const callback = new URL(response.headers.get('location'));
    return { callback, finish: () => target.finish(Object.fromEntries(callback.searchParams)) };
  };
  return { ...remote, directory, service, serviceOptions, authorize,
    cleanup: async () => {
      await closeMcpCallerConnections();
      await remote.close();
      setMcpOAuthServiceForTests(undefined);
      client.setMcpConfigStoreForTests(null);
      fs.rmSync(directory, { recursive: true, force: true });
    } };
}
const owner = (id: string) => ({ kind: 'session' as const, id, isActive: () => true });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('starting consent retains a concurrently rotated grant in memory and durable storage', async () => {
  const env = await environment();
  const crypto = globalThis.crypto || require('node:crypto').webcrypto;
  const digest = crypto.subtle.digest;
  const entered = deferred();
  const release = deferred();
  try {
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    const context = await client.callTool('remote', 'state', { value: 'retained context' }, { owner: alpha });
    const original = env.service.credentials('remote')[0];
    crypto.subtle.digest = async (...args: any[]) => {
      const bytes = await digest.apply(crypto.subtle, args);
      entered.resolve();
      await release.promise;
      return bytes;
    };
    const begin = env.service.begin('remote', (await client.getServers()).remote);
    await entered.promise;
    env.state.force401 = 1;
    await client.callTool('remote', 'state', {}, { owner: alpha });
    const rotated = env.service.credentials('remote')[0];
    assert.equal(rotated !== original, true);
    release.resolve();
    await begin;
    assert.equal(env.service.credentials('remote')[0] === rotated, true);
    const saved = JSON.parse(fs.readFileSync(env.serviceOptions.filePath, 'utf8')).servers.remote.tokens.access_token;
    assert.equal(saved === rotated, true);
    env.state.force401 = 1;
    const after = await client.callTool('remote', 'state', {}, { owner: alpha });
    assert.equal(after.context, context.context);
    assert.equal(after.value, 'retained context');
    assert.equal(env.state.refreshes, 2);
  } finally { crypto.subtle.digest = digest; release.resolve(); await env.cleanup(); }
});

for (const error of [false, true]) {
  test(`an operation withholds its actually used intermediate token in ${error ? 'errors' : 'results'} after another caller rotates`, async () => {
    const env = await environment();
    const entered = deferred();
    const release = deferred();
    let echoed: string;
    try {
      await (await env.authorize()).finish();
      const alpha = owner('alpha');
      const beta = owner('beta');
      await client.callTool('remote', 'state', {}, { owner: alpha });
      await client.callTool('remote', 'state', {}, { owner: beta });
      const original = env.service.credentials('remote')[0];
      env.state.delayedTool = async access => {
        echoed = access;
        entered.resolve();
        await release.promise;
        return { text: access, error };
      };
      env.state.force401 = 1;
      const slow = client.callTool('remote', 'state', { label: 'slow' }, { owner: alpha });
      await entered.promise;
      assert.equal(echoed !== original, true);
      env.state.force401 = 1;
      await client.callTool('remote', 'state', {}, { owner: beta });
      assert.equal(env.service.credentials('remote')[0] !== echoed, true);
      release.resolve();
      await assert.rejects(slow, /OAuth credentials|private credential data/);
      assert.equal(env.service.credentials().includes(echoed), false, 'finished operation does not retain intermediate token history');
      assert.equal(env.state.refreshes, 2);
      assert.equal(env.state.effects, 4);
    } finally { release.resolve(); await env.cleanup(); }
  });
}

test('notification admission rejects current credentials and actual old stream credentials in message or endpoint', async () => {
  const env = await environment();
  const admitted: Array<{ message: string; endpoint: string }> = [];
  const ordinary = deferred();
  try {
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    await client.startNotifications('remote', alpha, { assertActive: async () => {}, receive: async (message, endpoint) => {
      admitted.push({ message, endpoint });
      if (message === 'ordinary marker') ordinary.resolve();
    } });
    const streamToken = env.service.credentials('remote')[0];
    env.state.force401 = 1;
    await client.callTool('remote', 'state', {}, { owner: alpha });
    const current = env.service.credentials('remote')[0];
    assert.equal(streamToken !== current, true);
    await env.notify(streamToken);
    await env.notify('ordinary message', streamToken);
    await env.notify(current);
    await env.notify('ordinary marker');
    await ordinary.promise;
    assert.deepEqual(admitted, [{ message: 'ordinary marker', endpoint: 'fixture-endpoint' }]);
  } finally { await env.cleanup(); }
});

test('verified inbound callers cannot receive any dynamically stored OAuth credential through a static alias or its error', async () => {
  const env = await environment();
  const main = new HttpServer(0, 'fixture-admin');
  const access = normalizeAccessConfig({ identities: { fixture: { token: 'inbound-fixture-token', surfaces: { mcp: {} } } } });
  const inbound = new McpInboundHttpService(access, new McpInboundMcpCatalog());
  inbound.register(main);
  setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'deny', rules: [{ id: 'allow-fixture', enabled: true,
    match: { tool: { source: 'mcp', server: 'staticAlias', name: 'state' } }, action: 'allow' }] });
  const listener = http.createServer(main.app);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const sdkClient = new Client({ name: 'owned-fixture', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer inbound-fixture-token' } } });
  try {
    await (await env.authorize()).finish();
    await client.upsertServer('staticAlias', { transport: 'streamable-http', url: env.resource, token: 'fixture-static-token' });
    await sdkClient.connect(transport);
    const known = env.service.credentials('remote');
    assert.equal(known.length, 3);
    for (const secret of known) {
      for (const error of [false, true]) {
        env.state.delayedTool = async () => ({ text: secret, error });
        const result = await sdkClient.callTool({ name: 'foxwarm_call', arguments: {
          toolId: 'mcp:staticAlias/state', args: { label: 'slow' },
        } });
        assert.equal(result.isError, true);
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
    }
    assert.equal(env.state.effects, 6);
  } finally {
    await sdkClient.close();
    await inbound.stop();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    setToolAuthorizationPolicyForTests(undefined);
    await env.cleanup();
  }
});

for (const registration of ['dcr', 'cimd', 'none'] as const) {
  test(`browser code/PKCE grant works with ${registration} and survives service restart`, async () => {
    const env = await environment();
    try {
      env.state.registration = registration;
      if (registration === 'none') await client.upsertServer('remote', { oauth: { scope: 'read', clientId: 'pre-registered', clientSecret: 'pre-registered-secret' } });
      const authorization = await env.authorize();
      assert.equal(authorization.callback.origin, 'https://localhost');
      assert.equal(authorization.callback.pathname, '/preview/api/mcp/oauth/callback');
      assert.equal(await authorization.finish(), 'remote');
      assert.equal(env.state.registrations, registration === 'dcr' ? 1 : 0);
      assert.equal(env.state.exchanges, 1);
      const result = await client.callTool('remote', 'state', { value: 'before-restart' }, { owner: owner('alpha') });
      assert.equal(result.value, 'before-restart');
      const status = await env.service.status('remote', (await client.getServers()).remote);
      assert.equal(status.state, 'authorized');
      assert.equal(status.grantedScope, 'read');
      assert(!JSON.stringify(status).includes('pre-registered-secret'));
      assert(env.state.asHeaders.every(headers => !headers['x-api-key'] && !headers['x-auth-token']));
      assert(env.state.resourceHeaders.some(headers => headers['x-api-key'] === 'resource-only-api-key'));
      assert.equal(fs.statSync(path.join(env.directory, 'mcp-oauth.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(env.directory, 'mcp.json')).mode & 0o777, 0o600);
      await closeMcpCallerConnections();
      const restarted = new McpOAuthService(env.serviceOptions);
      setMcpOAuthServiceForTests(restarted);
      const after = await client.callTool('remote', 'state', {}, { owner: owner('alpha') });
      assert.equal(after.value, '');
      assert.equal(env.state.exchanges, 1);
      assert.equal((await restarted.status('remote', (await client.getServers()).remote)).state, 'authorized');
      const childCode = `
        const path = require('node:path');
        const client = require('./lib/mcpClient');
        const { McpOAuthService, setMcpOAuthServiceForTests } = require('./lib/mcpOAuth');
        const { closeMcpCallerConnections } = require('./lib/mcpCallerConnections');
        const directory = process.argv[1];
        client.setMcpConfigStoreForTests(client.createMcpConfigStore(path.join(directory, 'mcp.json')));
        setMcpOAuthServiceForTests(new McpOAuthService({ filePath: path.join(directory, 'mcp-oauth.json'),
          publicBaseUrl: process.argv[2], getServer: async name => (await client.getServers())[name] }));
        client.callTool('remote', 'state', {}).then(result => console.log(JSON.stringify(result)))
          .catch(() => { process.exitCode = 1; }).finally(() => closeMcpCallerConnections());
      `;
      const child = await promisify(execFile)(process.execPath, ['-e', childCode, env.directory, env.serviceOptions.publicBaseUrl], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, FOXWARM_DATA_DIR: env.directory }, timeout: 20000,
      });
      assert.equal(JSON.parse(child.stdout.trim()).value, '', 'a fresh process reads the persisted grant and calls the real resource');
      assert.equal(env.state.exchanges, 1);
      const second = await env.authorize('remote', restarted);
      await second.finish();
      assert.equal(env.state.registrations, registration === 'dcr' ? 1 : 0, 'existing registered client is reused');
    } finally { await env.cleanup(); }
  });
}

test('rejects issuer/resource/PKCE discovery mismatches before registration or exchange', async () => {
  const env = await environment();
  try {
    for (const field of ['mismatchIssuer', 'mismatchResource', 'pkce'] as const) {
      env.state[field] = field !== 'pkce';
      await assert.rejects(env.service.begin('remote', (await client.getServers()).remote));
      env.state[field] = field === 'pkce';
    }
    assert.equal(env.state.registrations, 0);
    assert.equal(env.state.exchanges, 0);
    env.state.registration = 'none';
    await assert.rejects(env.service.begin('remote', (await client.getServers()).remote), /pre-registered client ID/);
  } finally { await env.cleanup(); }
});

test('callback binds state, issuer, configuration and one-time PKCE exchange', async () => {
  const env = await environment();
  try {
    const { callback, finish } = await env.authorize();
    const values = Object.fromEntries(callback.searchParams);
    await assert.rejects(env.service.finish({ ...values, state: 'wrong-state' }), /callback is invalid/);
    await assert.rejects(env.service.finish({ ...values, iss: 'https://wrong.example' }), /issuer/);
    await assert.rejects(env.service.finish({ code: values.code, state: values.state }), /issuer/);
    assert.equal(env.state.exchanges, 0);
    await finish();
    await assert.rejects(finish(), /callback is invalid/);
    assert.equal(env.state.exchanges, 1);
    const pending = await env.authorize();
    await client.upsertServer('remote', { oauth: { scope: 'write' } });
    await assert.rejects(pending.finish(), /callback is invalid/);
    assert.equal(env.state.exchanges, 1);
  } finally { await env.cleanup(); }
});

test('instance-shared rotating refresh preserves two distinct caller contexts; invalid grant stops use', async () => {
  const env = await environment();
  try {
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    const beta = owner('beta');
    const a = await client.callTool('remote', 'state', { value: 'alpha-state' }, { owner: alpha });
    const b = await client.callTool('remote', 'state', { value: 'beta-state' }, { owner: beta });
    assert.notEqual(a.context, b.context);
    env.state.omitRefreshScope = true;
    env.state.force401 = 2;
    const [renewedA, renewedB] = await Promise.all([
      client.callTool('remote', 'state', {}, { owner: alpha }), client.callTool('remote', 'state', {}, { owner: beta }),
    ]);
    assert.equal(renewedA.context, a.context);
    assert.equal(renewedB.context, b.context);
    assert.equal(renewedA.value, 'alpha-state');
    assert.equal(renewedB.value, 'beta-state');
    assert.equal(env.state.refreshes, 1);
    assert.equal((await env.service.status('remote', (await client.getServers()).remote)).grantedScope, 'read');
    assert.equal(env.state.effects, 4, 'only authenticated tool invocations cause effects');
    env.state.force401 = 1;
    env.state.invalidRefresh = true;
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: alpha }), /expired|revoked|changed/);
    assert.equal(env.state.effects, 4);
    assert.equal((await env.service.status('remote', (await client.getServers()).remote)).state, 'needs-authorization');
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: beta }), { code: 'needs-authorization' });
    assert.equal(env.state.effects, 4);
  } finally { await env.cleanup(); }
});

test('scope rejection does not replay a tool or discard its context; explicit new grant fences it', async () => {
  const env = await environment();
  try {
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    const initial = await client.callTool('remote', 'state', { value: 'retained' }, { owner: alpha });
    env.state.requiredScope = 'write';
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: alpha }), /Additional MCP access/);
    assert.equal(env.state.effects, 1);
    assert.equal(env.state.contexts, 1);
    assert.equal((await env.service.status('remote', (await client.getServers()).remote)).requestedScope, 'read write');
    env.state.requiredScope = '';
    const retained = await client.callTool('remote', 'state', {}, { owner: alpha });
    assert.equal(retained.context, initial.context);
    assert.equal(retained.value, 'retained');
    await (await env.authorize()).finish();
    const changed = await client.callTool('remote', 'state', {}, { owner: alpha });
    assert.notEqual(changed.context, initial.context);
    await env.service.disconnect('remote');
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: alpha }), { code: 'needs-authorization' });
  } finally { await env.cleanup(); }
});

test('a short-lived token without refresh works until expiry, then requires fresh authorization', async t => {
  const env = await environment();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    env.state.issueRefreshTokens = false;
    env.state.tokenLifetime = 2;
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    await client.callTool('remote', 'state', { value: 'still valid' }, { owner: alpha });
    assert.equal(env.state.effects, 1);
    t.mock.timers.tick(3000);
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: alpha }), /reauthorization|changed/);
    assert.equal(env.state.effects, 1);
    assert.equal((await env.service.status('remote', (await client.getServers()).remote)).state, 'needs-authorization');
    assert.equal(env.state.refreshes, 0);
  } finally { t.mock.timers.reset(); await env.cleanup(); }
});

test('notification reception survives same-grant refresh and stops on disconnect', async () => {
  const env = await environment();
  try {
    await (await env.authorize()).finish();
    const alpha = owner('alpha');
    const initial = await client.callTool('remote', 'state', { value: 'notification-context' }, { owner: alpha });
    const received: string[] = [];
    let receive!: () => void;
    let notification = new Promise<void>(resolve => { receive = resolve; });
    const status = await client.startNotifications('remote', alpha, { assertActive: async () => {},
      receive: async message => { received.push(message); receive(); } });
    assert.equal(status.state, 'receiving');
    await env.notify('before refresh');
    await notification;
    env.state.force401 = 1;
    const after = await client.callTool('remote', 'state', {}, { owner: alpha });
    assert.equal(after.context, initial.context);
    notification = new Promise<void>(resolve => { receive = resolve; });
    await env.notify('after refresh');
    await notification;
    assert.deepEqual(received, ['before refresh', 'after refresh']);
    await env.service.disconnect('remote');
    await env.notify('after disconnect');
    assert.deepEqual(received, ['before refresh', 'after refresh']);
  } finally { await env.cleanup(); }
});

test('a replaced grant neither joins nor publishes an old in-flight refresh', async () => {
  const env = await environment();
  let release!: () => void;
  try {
    await (await env.authorize()).finish();
    await client.callTool('remote', 'state', {}, { owner: owner('old') });
    const entered = new Promise<void>(resolve => { env.state.refreshEntered = resolve; });
    env.state.refreshGate = new Promise<void>(resolve => { release = resolve; });
    env.state.force401 = 1;
    const old = client.callTool('remote', 'state', {}).then((): undefined => undefined, error => error);
    await entered;
    await env.service.disconnect('remote');
    await (await env.authorize()).finish();
    env.state.force401 = 1;
    const current = await client.callTool('remote', 'state', { value: 'new grant' }, { owner: owner('new') });
    assert.equal(current.value, 'new grant');
    const savedToken = env.service.credentials('remote')[0];
    release();
    assert(await old, 'the revoked old caller receives a failure, not a replayed effect');
    assert.equal(env.service.credentials('remote')[0], savedToken);
  } finally { release?.(); await env.cleanup(); }
});

test('OAuth credentials echoed by a remote tool are withheld without replay', async () => {
  const env = await environment();
  try {
    await (await env.authorize()).finish();
    env.state.echoCredential = true;
    await assert.rejects(client.callTool('remote', 'state', {}, { owner: owner('alpha') }), /output contained OAuth credentials/);
    assert.equal(env.state.effects, 1);
  } finally { await env.cleanup(); }
});

test('OAuth does not censor promoted media or ordinary deeply nested SDK JSON', async () => {
  const env = await environment();
  try {
    const data = 'aW1hZ2U=';
    await client.upsertServer('remote', { oauth: { clientId: 'pre-registered', clientSecret: data } });
    await (await env.authorize()).finish();
    env.state.imageData = data;
    const image = await client.callTool('remote', 'state', {}, { owner: owner('alpha') });
    assert.equal(image.inlineDataItems[0].data, data);
    env.state.imageData = undefined;
    env.state.deepResult = true;
    let nested = await client.callTool('remote', 'state', {}, { owner: owner('alpha') });
    for (let level = 0; level < 64; level++) nested = nested.nested;
    assert.equal(nested.value, 'ordinary result');
    assert.equal(env.state.effects, 2);
  } finally { await env.cleanup(); }
});

test('discovery refuses unrelated private and IPv4-mapped addresses without sending credentials', async () => {
  const fetchOAuth = createOAuthFetch('https://public.example/mcp');
  await assert.rejects(fetchOAuth('https://127.0.0.1/private'), /unrelated private/);
  await assert.rejects(fetchOAuth('https://[::ffff:127.0.0.1]/private'), /unrelated private/);
});

test('OAuth supports SSE/auto; static headers and unrelated grants remain independent', async () => {
  const env = await environment();
  try {
    await (await env.authorize()).finish();
    await client.upsertServer('legacy', { transport: 'auto', url: `${env.baseUrl}/sse`, oauth: {} });
    await (await env.authorize('legacy')).finish();
    const legacy = await client.callTool('legacy', 'state', { value: 'legacy' }, { owner: owner('legacy') });
    assert.equal(legacy.value, 'legacy');
    env.state.force401 = 1;
    const renewed = await client.callTool('legacy', 'state', {}, { owner: owner('legacy') });
    assert.equal(renewed.context, legacy.context);
    await env.service.disconnect('legacy');
    assert.equal((await env.service.status('remote', (await client.getServers()).remote)).state, 'authorized');
    const ordinary = await client.callTool('remote', 'state', {}, { owner: owner('ordinary') });
    assert(ordinary.context);
    await client.upsertServer('static', { transport: 'streamable-http', url: env.resource, token: 'unused', headers: { authorization: 'Bearer fixture-static-token' } });
    const staticResult = await client.callTool('static', 'state', { value: 'static' }, { owner: owner('static') });
    assert.equal(staticResult.value, 'static');
    await assert.rejects(client.upsertServer('static', { oauth: {} }), /not both/);
    await assert.rejects(client.upsertServer('stdio', { transport: 'stdio', command: 'fixture-command', oauth: {} }), /only for HTTP/);
  } finally { await env.cleanup(); }
});

test('management is admin-only, redacted and JSON/Origin bound; public metadata preserves configured prefix', async () => {
  const env = await environment();
  const main = new HttpServer(0, 'fixture-admin');
  main.setWebUiIdentityVerifier(token => token === 'fixture-scoped' ? { role: 'webui', identityId: 'scoped', sessionIds: [] } : null);
  registerMcpOAuthRoutes(main);
  const listener = http.createServer(main.app);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  try {
    const route = `${url}/api/setup/authorizations`;
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(route, { headers: { Authorization: 'Bearer fixture-scoped' } })).status, 403);
    for (const action of ['/remote/authorize', '/remote/disconnect']) {
      assert.equal((await fetch(route + action, { method: 'POST', headers: { Authorization: 'Bearer fixture-scoped', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    }
    assert.equal((await fetch(`${url}/api/mcp/oauth/complete`, { method: 'POST', headers: { Authorization: 'Bearer fixture-scoped', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const callback = await fetch(`${url}/api/mcp/oauth/callback?code=never-reflect-this-code&state=unused`);
    assert.equal(callback.status, 200);
    assert(!(await callback.text()).includes('never-reflect-this-code'));
    const headers = { Authorization: 'Bearer fixture-admin', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${route}/remote`, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"authentication":"oauth"}' })).status, 400);
    assert.equal((await fetch(`${route}/remote/authorize`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin' } })).status, 400);
    const saved = await fetch(`${route}/remote`, { method: 'PUT', headers, body: JSON.stringify({ authentication: 'oauth', clientId: 'manual', clientSecret: 'private-fixture-secret', scope: 'read' }) });
    assert.equal(saved.status, 200);
    const status = await (await fetch(route, { headers })).json() as any;
    assert.equal(status.servers[0].hasClientSecret, true);
    assert(!JSON.stringify(status).includes('private-fixture-secret'));
    const metadata = await (await fetch(`${url}/api/mcp/oauth/client.json`)).json() as any;
    assert.equal(metadata.client_id, 'https://localhost/preview/api/mcp/oauth/client.json');
    assert.deepEqual(metadata.redirect_uris, ['https://localhost/preview/api/mcp/oauth/callback']);
    assert(!JSON.stringify(metadata).includes('private-fixture-secret'));
    assert.throws(() => oauthPublicUrl(undefined, '/api/callback'), /Set url/);
    assert.throws(() => oauthPublicUrl('http://production.example/prefix', '/api/callback'), /HTTPS/);
    assert.equal(oauthPublicUrl('http://localhost:3000/prefix', '/api/callback'), 'http://localhost:3000/prefix/api/callback');
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await env.cleanup();
  }
});
