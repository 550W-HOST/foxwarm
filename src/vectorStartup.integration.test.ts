import './testEnvironment';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function childEnvironment(root: string): NodeJS.ProcessEnv {
  return { ...process.env, FOXWARM_DATA_DIR: root,
    FOXWARM_CONFIG_PATH: path.join(root, 'state/config.yaml'),
    MCP_CONFIG_PATH: path.join(root, 'state/mcp.json'),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' };
}

function runScript(root: string, script: string): string {
  const result = spawnSync(process.execPath, ['-e', script], {
    env: childEnvironment(root), cwd: __dirname, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

// Create through the actual selected local owner, then reproduce the observed
// power-loss shape: a zero-byte latest manifest in an otherwise valid Lance DB.
async function corruptLatestManifest(root: string): Promise<string> {
  runScript(root, `
    (async () => {
      const vector = require(${JSON.stringify(require.resolve('./vector'))});
      await vector.init({ enabled: true, useWorker: false });
      await vector.shutdown();
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  const versions = path.join(root, 'state/db/messages_v7.lance/_versions');
  const manifests = (await fs.readdir(versions)).filter(name => name.endsWith('.manifest'));
  // Lance v2 filenames are inverted version numbers: the smallest is latest.
  const latest = manifests.sort()[0];
  assert.ok(latest, 'the synthetic owner must have committed a real Lance manifest');
  const manifest = path.join(versions, latest);
  assert.ok((await fs.stat(manifest)).size > 0);
  await fs.truncate(manifest, 0);
  return manifest;
}

async function fixture(enabled: boolean, useWorker: boolean, sessionWorkers = false, semanticRecall = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-startup-'));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  let providerCalls = 0;
  let embeddingCalls = 0;
  const unexpectedPaths: string[] = [];
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    if (request.url === '/v1/embeddings') {
      embeddingCalls++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.01) }] }));
    } else if (request.url === '/v1/chat/completions') {
      providerCalls++;
      const recall = semanticRecall && providerCalls % 2 === 1;
      const delta = recall
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `recall-${providerCalls}`, type: 'function',
          function: { name: 'recall', arguments: JSON.stringify({ vector_query: 'synthetic query', scope: 'current-session' }) } }] }
        : { role: 'assistant', content: 'Synthetic answer.' };
      response.setHeader('Content-Type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: recall ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      unexpectedPaths.push(request.url || '');
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(stateDir, 'token'), 'synthetic-vector-startup-token');
  await fs.writeFile(path.join(stateDir, 'mcp.json'), '{}');
  await fs.writeFile(path.join(stateDir, 'models.yaml'), `default: mock/test\nproviders:\n  mock:\n    providerType: openai-completions\n    baseUrl: ${providerUrl}/v1\n    apiKey: synthetic-provider-token\n    models: [test]\n`);
  await fs.writeFile(path.join(stateDir, 'config.yaml'), `bot:\n  name: vector-startup-test\n  httpPort: ${port}\n  enableWebUI: true\n  enableTrigger: false\nvector: ${enabled ? `\n  baseUrl: ${providerUrl}/v1` : 'false'}\nvectorMaintenance: false\nsessionWorkers: ${sessionWorkers}\ndbWorkers: ${useWorker}\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(path.join(stateDir, 'mcp.json'))}\n`);
  await fs.mkdir(path.join(root, 'agents/main/memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents/00_SYSTEM.md'), 'Synthetic Vector startup test.');
  let child: ChildProcess | undefined;
  let log: Awaited<ReturnType<typeof fs.open>> | undefined;
  let exit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let starts = 0;
  const logs = async () => (await fs.readFile(path.join(root, `app-${starts}.log`), 'utf8'))
    + await fs.readFile(path.join(root, 'state/logs/vector-startup-test.log'), 'utf8').catch(() => '');
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(baseUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer synthetic-vector-startup-token', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() as any };
  };
  const api = async (route: string, body?: unknown) => {
    const reply = await request(route, body);
    assert.equal(reply.status, 200, JSON.stringify(reply.value));
    return reply.value;
  };
  const launch = async () => {
    log = await fs.open(path.join(root, `app-${++starts}.log`), 'w');
    child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: childEnvironment(root), stdio: ['ignore', log.fd, log.fd],
    });
    exit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  };
  const stopped = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([exit!, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Main failed to exit.')), 15_000);
      })]);
    } finally {
      clearTimeout(timer);
      await log?.close(); log = undefined;
    }
  };
  const stop = async () => {
    child!.kill('SIGTERM');
    assert.deepEqual(await stopped(), [0, null]);
  };
  return {
    root, request, api, logs, launch, stopped, stop,
    get providerCalls() { return providerCalls; },
    get embeddingCalls() { return embeddingCalls; },
    async start() {
      await launch();
      await waitFor(async () => {
        if (child!.exitCode !== null) throw new Error(await logs());
        try { return (await request('/api/setup/status')).status === 200; } catch { return false; }
      }, 'actual Main HTTP readiness');
    },
    async close() {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child!.kill('SIGKILL'), 12_000);
        try { await exit; } finally { clearTimeout(timer); }
      }
      await log?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
      assert.deepEqual(unexpectedPaths, []);
    },
  };
}

for (const useWorker of [false, true]) {
  test(`real corrupt Lance owner remains unavailable and shuts down, dbWorkers=${useWorker}`, async () => {
    const f = await fixture(true, useWorker);
    try {
      const manifest = await corruptLatestManifest(f.root);
      const output = runScript(f.root, `
        (async () => {
          const assert = require('node:assert/strict');
          const vector = require(${JSON.stringify(require.resolve('./vector'))});
          await assert.rejects(vector.init({ enabled: true, useWorker: ${useWorker} }));
          const initial = vector.getVectorServiceStatus();
          assert.equal(initial.mode, ${JSON.stringify(useWorker ? 'worker' : 'local')});
          assert.equal(initial.ready, false);
          for (const operation of [() => vector.search('synthetic query'),
            () => vector.searchDetailed('synthetic query'),
            () => vector.indexSessionArchive('main/test'),
            () => vector.scheduleSessionArchiveIndex('main/test', 1)]) {
            await assert.rejects(operation, error => error.code === 'VECTOR_UNAVAILABLE' && error.retryable === true);
          }
          await assert.rejects(vector.init({ enabled: true, useWorker: ${!useWorker} }),
            { code: 'VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART' });
          if (${useWorker}) {
            await new Promise(resolve => setTimeout(resolve, 800));
            assert.ok(vector.getVectorServiceStatus().generation > initial.generation,
              'existing watchdog must retry the failed child');
            assert.equal(vector.getVectorServiceStatus().ready, false);
            assert.equal(Object.keys(require.cache).some(file => file.includes('@lancedb')), false,
              'the Main facade must not load a native local fallback');
          }
          await vector.shutdown();
          console.log('RESULT: shutdown completed');
        })().catch(error => { console.error(error); process.exit(1); });
      `);
      assert.match(output, /RESULT: shutdown completed/);
      assert.equal((await fs.stat(manifest)).size, 0);
      assert.equal(f.embeddingCalls, 0);
    } finally { await f.close(); }
  });

  for (const sessionWorkers of [false, true]) {
    for (const mode of ['enabled', 'disabled', 'corrupt'] as const) {
      test(`Main serves and persists messages with Vector ${mode}, dbWorkers=${useWorker}, sessionWorkers=${sessionWorkers}`,
        { skip: process.platform === 'win32' }, async () => {
          const f = await fixture(mode !== 'disabled', useWorker, sessionWorkers, mode === 'corrupt');
          const callsPerExchange = mode === 'corrupt' ? 2 : 1;
          try {
            const manifest = mode === 'corrupt' ? await corruptLatestManifest(f.root) : undefined;
            await f.start();
            const search = await f.request('/api/history/search?query=synthetic');
            if (mode === 'enabled') {
              assert.equal(search.status, 200, JSON.stringify(search.value));
              assert.ok(Array.isArray(search.value.results));
              assert.ok(f.embeddingCalls > 0);
            } else {
              assert.equal(search.status, 503);
              assert.equal(search.value.code, mode === 'disabled' ? 'VECTOR_DISABLED' : 'VECTOR_UNAVAILABLE');
              assert.equal(f.embeddingCalls, 0);
            }
            const sessionId = (await f.api('/api/sessions', { agentId: 'main', sessionId: 'surviving' })).sessionId;
            const route = `/api/sessions/${encodeURIComponent(sessionId)}`;
            await f.api(`${route}/message`, { text: 'Input persists independently of Vector.' });
            const authority = async () => JSON.parse(await fs.readFile(path.join(f.root, 'state/sessions', `${sessionId}.json`), 'utf8'));
            await waitFor(async () => {
              const saved = await authority();
              return !saved.busy && JSON.stringify(saved.history).includes('Synthetic answer.');
            }, 'committed synthetic exchange');
            assert.equal(f.providerCalls, callsPerExchange);
            if (mode === 'corrupt') {
              assert.match(JSON.stringify((await authority()).history.filter((row: any) => row.role === 'tool')), /VECTOR_UNAVAILABLE/);
            }
            assert.match(JSON.stringify(await f.api(`${route}/history`)), /Input persists independently of Vector/);
            const archiveRoute = `/api/history/window?sessionId=${encodeURIComponent(sessionId)}&target=msg%231-20`;
            assert.match(JSON.stringify(await f.api(archiveRoute)), /Input persists independently of Vector/);
            const logs = await f.logs();
            if (mode === 'corrupt') {
              assert.match(logs, /Invalid range 0\.\.0 for object of size 0/);
              assert.equal((await fs.stat(manifest!)).size, 0, 'startup must not repair or replace the corrupt manifest');
            } else {
              assert.doesNotMatch(logs, /Vector initialization failed/);
              if (mode === 'enabled' && useWorker) assert.match(logs, /Vector worker ready/);
            }
            await f.stop();
            if (mode === 'corrupt') {
              await f.start();
              assert.match(JSON.stringify(await f.api(archiveRoute)), /Input persists independently of Vector/);
              await f.api(`${route}/message`, { text: 'A second exchange after restart.' });
              await waitFor(async () => !(await authority()).busy && f.providerCalls === 2 * callsPerExchange, 'post-restart exchange');
              assert.match(JSON.stringify((await authority()).history), /A second exchange after restart/);
              await f.stop();
            }
            if (mode === 'disabled') {
              await assert.rejects(fs.stat(path.join(f.root, 'state/db/messages_v7.lance')), { code: 'ENOENT' });
            }
          } finally { await f.close(); }
      });
    }
  }
}

for (const database of ['catalog.sqlite', 'archive-store.sqlite']) {
  test(`authoritative ${database} failure still aborts Main`, async () => {
    const f = await fixture(true, true);
    try {
      await fs.writeFile(path.join(f.root, 'state', database), 'not a SQLite database');
      await f.launch();
      assert.deepEqual(await f.stopped(), [1, null]);
      const logs = await f.logs();
      assert.match(logs, /Failed to start/);
      assert.doesNotMatch(logs, /Foxwarm started successfully|Vector initialization failed/);
      assert.equal(f.providerCalls, 0);
      assert.equal(f.embeddingCalls, 0);
    } finally { await f.close(); }
  });
}
