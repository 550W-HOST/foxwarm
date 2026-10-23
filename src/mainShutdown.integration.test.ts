import './testEnvironment';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Windows process.kill(SIGTERM) terminates rather than delivering a catchable
// POSIX signal. These tests exercise the executable's actual signal handler.
const skipPosixSignal = process.platform === 'win32';

async function waitFor(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

type ToolReply = boolean | { name: string; args: Record<string, unknown> };

function complete(response: http.ServerResponse, tools: ToolReply = false, highUsage?: boolean): void {
  const tool = tools === true ? { name: 'node', args: { action: 'list' } } : tools || undefined;
  const delta = tool
    ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call', type: 'function', function: {
      name: tool.name, arguments: JSON.stringify(tool.args),
    } }] }
    : { role: 'assistant', content: 'Completed answer.' };
  response.setHeader('Content-Type', 'text/event-stream');
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  const usage = highUsage === undefined ? undefined : { prompt_tokens: highUsage ? 2100 : 10, completion_tokens: 1, total_tokens: highUsage ? 2101 : 11 };
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
}

async function fixture(vector = false, compactWait = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-main-shutdown-'));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  let providerCalls = 0;
  let pendingProvider: http.ServerResponse | undefined;
  let pendingEmbedding: http.ServerResponse | undefined;
  let holdEmbedding = vector;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    if (request.url?.endsWith('/embeddings')) {
      if (holdEmbedding) { pendingEmbedding = response; return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.01) }] }));
    } else if (request.url?.endsWith('/chat/completions')) {
      providerCalls++;
      if (providerCalls === 1 || (compactWait && providerCalls === 4)) pendingProvider = response;
      else if (compactWait && providerCalls === 3) complete(response, true, true);
      else complete(response, false, compactWait ? false : undefined);
    } else {
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
  await fs.writeFile(path.join(stateDir, 'token'), 'synthetic-shutdown-test-token');
  await fs.writeFile(path.join(stateDir, 'mcp.json'), '{}');
  await fs.writeFile(path.join(stateDir, 'models.yaml'), `default: mock/test\nproviders:\n  mock:\n    providerType: openai-completions\n    baseUrl: ${providerUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: ${compactWait}\n${compactWait ? '    contextLimit: 2000\n' : ''}    models: [test]\n`);
  await fs.writeFile(path.join(stateDir, 'config.yaml'), `bot:\n  name: shutdown-test\n  httpPort: ${port}\n  enableWebUI: true\n  enableTrigger: false\nvector: ${vector ? `\n  baseUrl: ${providerUrl}/v1` : 'false'}\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: true\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(path.join(stateDir, 'mcp.json'))}\n`);
  await fs.mkdir(path.join(root, 'agents/main/memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents/00_SYSTEM.md'), 'Synthetic process-shutdown test.');
  let child: ChildProcess | undefined;
  let log: Awaited<ReturnType<typeof fs.open>> | undefined;
  let exit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let sessionId: string;
  let starts = 0;
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(baseUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer synthetic-shutdown-test-token', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value as any;
  };
  const start = async () => {
    log = await fs.open(path.join(root, `app-${++starts}.log`), 'w');
    child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, FOXWARM_DATA_DIR: root,
        MCP_CONFIG_PATH: path.join(stateDir, 'mcp.json'), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' },
      stdio: ['ignore', log.fd, log.fd],
    });
    exit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    await waitFor(async () => {
      if (child!.exitCode !== null) throw new Error(await fs.readFile(path.join(root, `app-${starts}.log`), 'utf8'));
      try { await api('/api/setup/status'); return true; } catch { return false; }
    }, 'application readiness');
  };
  const authority = async (): Promise<{ busy: boolean; queue: unknown[]; history: any[] }> =>
    JSON.parse(await fs.readFile(path.join(stateDir, 'sessions', `${sessionId}.json`), 'utf8'));
  const releaseEmbedding = () => {
    holdEmbedding = false;
    pendingEmbedding?.end(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.01) }] }));
    pendingEmbedding = undefined;
  };
  const waitForExit = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exit!, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Application did not stop.')), 15_000);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      await log?.close(); log = undefined;
    }
  };
  return {
    root, api, start, authority, waitForExit,
    message(text: string) { return api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { text }); },
    get providerCalls() { return providerCalls; },
    async begin() {
      await start();
      sessionId = (await api('/api/sessions', { agentId: 'main', sessionId: 'interrupted' })).sessionId;
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { text: vector || compactWait ? 'synthetic input '.repeat(4500) : 'input' });
      await waitFor(() => !!pendingProvider && (!vector || !!pendingEmbedding), 'accepted provider/index work');
      const saved = await authority();
      assert.equal(saved.busy, true);
      assert.equal(saved.queue.length, 0);
    },
    signal() { child!.kill('SIGTERM'); },
    releaseProvider(tools: ToolReply = false) { complete(pendingProvider!, tools, compactWait ? false : undefined); pendingProvider = undefined; },
    releaseEmbedding,
    stop() { return api(`/api/sessions/${encodeURIComponent(sessionId)}/message`, { text: '/stop' }); },
    async close() {
      releaseEmbedding();
      pendingProvider?.destroy();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child!.kill('SIGKILL'), 12_000);
        try { await exit; } finally { clearTimeout(timer); }
      }
      await log?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('SIGTERM with pending provider and Vector drain preserves unfinished authority for a fresh Main', { skip: skipPosixSignal }, async () => {
  const f = await fixture(true);
  try {
    await f.begin();
    f.signal();
    await delay(250);
    f.releaseProvider(true);
    await waitFor(async () => (await f.authority()).history.some(row => row.parts.some((part: any) => part.functionCall)), 'committed tool-call checkpoint');
    const interrupted = await f.authority();
    assert.equal(interrupted.busy, true);
    assert.equal(interrupted.queue.length, 0);
    assert.ok(!interrupted.history.some(row => row.role === 'tool'), 'no new tool is dispatched after shutdown');
    assert.ok(!JSON.stringify(interrupted.history).includes('Error:'));
    f.releaseEmbedding();
    assert.deepEqual(await f.waitForExit(), [0, null]);
    assert.equal((await f.authority()).busy, true);
    await f.start();
    await waitFor(async () => f.providerCalls === 2 && !(await f.authority()).busy, 'automatic restart recovery');
    assert.ok(JSON.stringify((await f.authority()).history).includes('session-resumed'));
  } finally { await f.close(); }
});

for (const terminal of ['final', 'stop'] as const) {
  test(`${terminal} that settles after SIGTERM remains idle on a fresh process`, { skip: skipPosixSignal }, async () => {
    const f = await fixture();
    try {
      await f.begin();
      f.signal();
      await delay(250);
      if (terminal === 'final') f.releaseProvider();
      else await f.stop();
      assert.deepEqual(await f.waitForExit(), [0, null]);
      assert.equal((await f.authority()).busy, false);
      await f.start();
      await delay(250);
      assert.equal((await f.authority()).busy, false);
      assert.equal(f.providerCalls, 1);
    } finally { await f.close(); }
  });
}

test('the shutdown grace cancels an unresolved provider without terminalizing its Session', { skip: skipPosixSignal }, async () => {
  const f = await fixture();
  try {
    await f.begin();
    f.signal();
    assert.deepEqual(await f.waitForExit(), [0, null]);
    const interrupted = await f.authority();
    assert.equal(interrupted.busy, true);
    assert.ok(!interrupted.history.some(row => row.role === 'model'));
    await f.start();
    await waitFor(async () => f.providerCalls === 2 && !(await f.authority()).busy, 'recovery after provider cancellation');
  } finally { await f.close(); }
});

test('SIGTERM during a required compact-planning wait preserves busy and queued follow-up for restart', { skip: skipPosixSignal }, async () => {
  const f = await fixture(false, true);
  const followUp = 'follow-up accepted while compact planning is waiting';
  try {
    await f.begin();
    f.releaseProvider();
    await waitFor(async () => !(await f.authority()).busy, 'first completed exchange');
    await f.message('second completed exchange');
    await waitFor(async () => f.providerCalls === 2 && !(await f.authority()).busy, 'second completed exchange');
    await f.message('continue using the node tool');
    await waitFor(() => f.providerCalls === 4, 'real over-limit compact planner request');
    await f.message(followUp);
    await waitFor(async () => (await f.authority()).queue.length === 1, 'persisted follow-up while planning');
    f.signal();
    assert.deepEqual(await f.waitForExit(), [0, null]);
    const interrupted = await f.authority();
    assert.equal(interrupted.busy, true);
    assert.equal(interrupted.queue.length, 1);
    assert.ok(!JSON.stringify(interrupted.history).includes(followUp), 'shutdown must not turn later input into passive Stop history');
    await f.start();
    await waitFor(async () => f.providerCalls === 5 && !(await f.authority()).busy, 'interrupted continuation and queued input recovery');
    const resumed = await f.authority();
    assert.equal(resumed.queue.length, 0);
    assert.ok(JSON.stringify(resumed.history).includes('session-resumed'));
    assert.ok(JSON.stringify(resumed.history).includes(followUp));
    assert.equal(resumed.history.at(-1)!.parts[0].text, 'Completed answer.');
  } finally { await f.close(); }
});

test('a native file write that ignores cancellation forces only Main to actually exit', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  let reader: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await f.begin();
    const fifo = path.join(f.root, 'agents/main/blocked-write');
    const mkfifo = spawn('mkfifo', [fifo]);
    assert.deepEqual(await once(mkfifo, 'exit'), [0, null]);
    f.releaseProvider({ name: 'write', args: { filePath: fifo, content: 'x'.repeat(256 * 1024), overwrite: true } });
    // Opening the reader proves the real tool opened its writer. Do not read:
    // a write larger than the pipe buffer stays in native work despite abort.
    reader = await fs.open(fifo, 'r');
    f.signal();
    assert.deepEqual(await f.waitForExit(), [null, 'SIGKILL']);
    const interrupted = await f.authority();
    assert.equal(interrupted.busy, true);
    assert.ok(interrupted.history.at(-1)!.parts.some((part: any) => part.functionCall?.name === 'write'));
    assert.ok(!interrupted.history.some(row => row.role === 'tool'));
    await reader.close(); reader = undefined;
    await f.start();
    await waitFor(async () => f.providerCalls === 2 && !(await f.authority()).busy, 'recovery after noncooperative native work');
  } finally { await reader?.close(); await f.close(); }
});
