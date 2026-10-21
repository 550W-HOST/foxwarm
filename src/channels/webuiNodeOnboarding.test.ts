import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

// No live registry/configuration is loaded: import the application after this root exists.
test('authenticated onboarding uses literal config/override addresses and real pending/create trust boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-onboarding-'));
  process.env.FOXWARM_DATA_DIR = root;
  await fs.ensureDir(path.join(root, 'state'));
  const publicUrl = "https://public.example.invalid/deploy'path/$literal";
  await fs.writeFile(path.join(root, 'state/config.yaml'), `url: ${JSON.stringify(publicUrl)}\nvector:\n  enabled: false\n`);
  const { HttpServer, setHttpServer } = await import('../httpServer');
  const { WebUIChannel } = await import('./webuiChannel');
  const registry = await import('../nodes/registry');
  const { nodesManager } = await import('../nodes/manager');
  const server = new HttpServer(0, 'synthetic-main-auth');
  setHttpServer(server);
  const channel = new WebUIChannel({ router: {} as any, token: 'synthetic-main-auth', enableTrigger: false, enableWebUI: true });
  const auth = { Authorization: 'Bearer synthetic-main-auth', 'Content-Type': 'application/json' };
  try {
    await server.start();
    const origin = `http://127.0.0.1:${(server as any).httpServer.address().port}`;
    const post = (action: string, body: object, headers = auth) => fetch(`${origin}/api/nodes/onboarding/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const action of ['commands', 'approve', 'create', 'create-shell']) {
      assert.equal((await post(action, {}, { 'Content-Type': 'application/json' } as any)).status, 401);
    }
    assert.equal((await fetch(`${origin}/api/nodes/onboarding/pending`)).status, 401);
    server.setWebUiIdentityVerifier(token => token === 'synthetic-scoped-auth' ? { role: 'webui', identityId: 'fixture', sessionIds: [] } : null);
    for (const action of ['commands', 'approve', 'create', 'create-shell']) {
      assert.equal((await post(action, {}, { ...auth, Authorization: 'Bearer synthetic-scoped-auth' })).status, 403);
    }
    assert.equal((await fetch(`${origin}/api/nodes/onboarding/pending`, { headers: { ...auth, Authorization: 'Bearer synthetic-scoped-auth' } })).status, 403);
    const commandsResponse = await post('commands', { fallbackUrl: 'http://fallback.invalid/deployment' });
    assert.equal(commandsResponse.headers.get('cache-control'), 'no-store');
    const setup = await commandsResponse.json() as any;
    assert.equal(setup.baseUrl, publicUrl);
    assert.doesNotMatch(JSON.stringify(setup.commands), /BASE_URL/);
    const pairingToken = await fs.readFile(path.join(root, 'state/node_token'), 'utf8');
    assert.ok(setup.commands.bareMetal.includes(pairingToken));
    const changed = await (await post('commands', { baseUrl: 'http://override.invalid/another', fallbackUrl: 'http://fallback.invalid' })).json() as any;
    assert.equal(changed.baseUrl, 'http://override.invalid/another');
    assert.ok(changed.commands.windows.includes('http://override.invalid/another/node/run.ps1'));
    for (const baseUrl of ['http://user:password@host.invalid', 'https://host.invalid/?secret=x', 'file:///tmp', 'https://host.invalid/#fragment']) {
      assert.equal((await post('commands', { baseUrl })).status, 400);
    }
    assert.equal((await registry.listApprovedNodes()).length, 0, 'reading commands does not create a Node');

    const pending = await registry.createPendingPairing({ requestedName: 'Laptop', nodeType: 'cli-node', capabilities: { tools: [{ name: 'private-tool', description: 'private capability' }] } });
    const already = await registry.createPendingPairing({ requestedName: 'Approved offline', nodeType: 'cli-node', capabilities: { tools: [] } });
    await registry.approvePendingPairing(already.id);
    for (let index = 0; index < 51; index++) await registry.createPendingPairing({ requestedName: `Device ${index}`, nodeType: 'cli-node', capabilities: { tools: [] } });
    const listResponse = await fetch(`${origin}/api/nodes/onboarding/pending`, { headers: auth });
    const page = await listResponse.json() as any;
    assert.equal(page.total, 52);
    assert.equal(page.items.length, 50);
    assert.equal(page.nextOffset, 50);
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['connected', 'id', 'nodeType', 'requestedAt', 'requestedName']);
    assert.doesNotMatch(JSON.stringify(page), /approvedAuthToken|tokenHash|private capability/);
    assert.equal(listResponse.headers.get('cache-control'), 'no-store');
    const nextPage = await (await fetch(`${origin}/api/nodes/onboarding/pending?offset=50`, { headers: auth })).json() as any;
    assert.equal(nextPage.items.length, 2);
    assert.equal(nextPage.total, 52);
    assert.equal((await post('approve', { pendingId: already.id })).status, 409);
    const concurrent = await Promise.all([post('approve', { pendingId: pending.id }), post('approve', { pendingId: pending.id })]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    const approved = await concurrent.find(response => response.status === 200)!.json() as any;
    assert.deepEqual(Object.keys(approved).sort(), ['deliveredLive', 'nodeId']);
    assert.equal(approved.deliveredLive, false);
    assert.equal((await registry.listApprovedNodes()).length, 2, 'two browsers cannot approve the same request into two identities');
    assert.equal((await post('approve', { pendingId: 'expired-fixture' })).status, 409);

    const createdResponse = await post('create-shell', { nodeId: 'shell-example', baseUrl: 'https://override.invalid/prefix' });
    assert.equal(createdResponse.status, 200);
    assert.equal(createdResponse.headers.get('cache-control'), 'no-store');
    const created = await createdResponse.json() as any;
    const perNodeToken = /NODE_AUTH_TOKEN='([a-f0-9]{64})'/.exec(created.command)?.[1];
    assert.ok(perNodeToken);
    assert.equal((await registry.authenticateApprovedNode('shell-example', perNodeToken))?.nodeId, 'shell-example');
    assert.match(created.command, /--host='https:\/\/override.invalid\/prefix'/);
    assert.doesNotMatch(created.command, /--pairing=/);
    assert.equal((await post('create-shell', { nodeId: 'shell-example', baseUrl: publicUrl })).status, 409);
    assert.equal((await post('create-shell', { nodeId: 'master', baseUrl: publicUrl })).status, 409);
    const beforeCreate = (await registry.listApprovedNodes()).length;
    const pendingBeforeCreate = (await registry.listPendingPairings()).length;
    const concurrentCreate = await Promise.all([post('create', { nodeId: 'all-methods', baseUrl: publicUrl }), post('create', { nodeId: 'all-methods', baseUrl: publicUrl })]);
    assert.deepEqual(concurrentCreate.map(response => response.status).sort(), [200, 409]);
    const tokenResponse = concurrentCreate.find(response => response.status === 200)!;
    assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
    const direct = await tokenResponse.json() as any;
    assert.equal(direct.baseUrl, publicUrl);
    assert.equal((await registry.authenticateApprovedNode(direct.nodeId, direct.authToken))?.nodeId, 'all-methods');
    assert.equal((await registry.listApprovedNodes()).length, beforeCreate + 1);
    assert.equal((await registry.listPendingPairings()).length, pendingBeforeCreate);
    for (const [method, command] of Object.entries(direct.commands) as [string, string][]) {
      assert.ok(command.includes(direct.authToken), method);
      assert.ok(!command.includes(pairingToken), method);
      assert.doesNotMatch(command, /--pairing=|-Pairing /, method);
    }
    assert.match(direct.commands.windows, /-AuthToken /);
    assert.match(direct.commands.manualCompose, /NODE_PAIRING_TOKEN=''\nNODE_AUTH_TOKEN='[a-f0-9]{64}'/);
    const regenerated = await (await post('commands', { nodeId: direct.nodeId, baseUrl: direct.baseUrl, installDir: "/opt/node's directory/$literal", authToken: direct.authToken })).json() as any;
    assert.ok(regenerated.commands.bareMetal.includes("--dir='/opt/node'\"'\"'s directory/$literal'"));
    assert.ok(regenerated.commands.bareMetal.includes(direct.authToken));
    assert.ok(!JSON.stringify(regenerated).includes(pairingToken));
    assert.equal((await registry.listApprovedNodes()).length, beforeCreate + 1, 'command regeneration does not provision or rotate');
    assert.equal((await registry.authenticateApprovedNode(direct.nodeId, direct.authToken))?.nodeId, direct.nodeId);
    for (const body of [{ nodeId: 'all-methods', baseUrl: publicUrl }, { nodeId: 'master', baseUrl: publicUrl }, { nodeId: 'Master', baseUrl: publicUrl }, { nodeId: 'invalid name', baseUrl: publicUrl }]) {
      assert.ok([400, 409].includes((await post('create', body)).status));
    }
    const persisted = await fs.readFile(path.join(root, 'state/nodes.json'), 'utf8');
    assert.ok(!persisted.includes(direct.authToken), 'the registry only persists the direct credential hash');
    const summaries = await (await fetch(`${origin}/api/nodes`, { headers: auth })).text();
    assert.ok(summaries.includes('shell-example'));
    assert.ok(!summaries.includes(pairingToken));
    assert.ok(!summaries.includes(perNodeToken));
    assert.ok(!summaries.includes(direct.authToken));
    assert.doesNotMatch(summaries, /approvedAuthToken|tokenHash/);
    assert.equal(nodesManager.getNode('shell-example'), undefined, 'explicit create reserves trust but does not fabricate an online runtime');
    assert.equal(nodesManager.getNode(direct.nodeId), undefined);
    const failingStore = registry.createNodeRegistryStore(path.join(root, 'failed-create.json'));
    let writes = 0;
    failingStore.write = async () => { writes++; throw new Error('synthetic persistence failure'); };
    registry.setNodeRegistryStoreForTests(failingStore);
    const failed = await post('create', { nodeId: 'failed-node', baseUrl: publicUrl });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /authToken|synthetic persistence failure/);
    assert.equal(writes, 1, 'a failed creation is not retried');
    assert.equal((await registry.listApprovedNodes()).length, 0, 'failed persistence does not leave trusted in-memory state');
  } finally {
    await channel.stop();
    await server.stop();
    setHttpServer(null);
    registry.resetNodeRegistryForTests();
    await fs.remove(root);
  }
});
