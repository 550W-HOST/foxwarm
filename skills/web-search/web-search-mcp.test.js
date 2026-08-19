'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const {
  SERVER_NAME,
  TOOL_NAME,
  WEB_SEARCH_SCRIPT_PATH,
  MAX_QUERY_BYTES,
  MAX_STDOUT_BYTES,
  SEARCH_TIMEOUT_MS,
  ERROR_MESSAGES,
  validateSearchQuery,
  runWebSearchQuery,
  createWebSearchMcpServer,
} = require('./web-search-mcp');

function createFakeChild(onKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinText = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.stdinText += Buffer.from(chunk).toString('utf8');
      callback();
    },
  });
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    onKill?.(signal, child);
    return true;
  };
  return child;
}

function fakeSpawn(behavior, capture = {}) {
  return (execPath, args, options) => {
    const child = createFakeChild(behavior?.onKill);
    capture.execPath = execPath;
    capture.args = args;
    capture.options = options;
    capture.child = child;
    setImmediate(() => behavior?.start?.(child));
    return child;
  };
}

async function connectInMemory(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'web-search-mcp-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => client.close() };
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('query validation enforces non-empty input and the 16 KiB UTF-8 byte bound', () => {
  assert.deepEqual(validateSearchQuery(''), { ok: false, code: 'invalid_query' });
  assert.deepEqual(validateSearchQuery('   '), { ok: false, code: 'invalid_query' });
  assert.equal(validateSearchQuery('x'.repeat(MAX_QUERY_BYTES)).ok, true);
  assert.deepEqual(validateSearchQuery('x'.repeat(MAX_QUERY_BYTES + 1)), { ok: false, code: 'invalid_query' });
  assert.equal(validateSearchQuery('你'.repeat(Math.floor(MAX_QUERY_BYTES / 3))).ok, true);
  assert.deepEqual(validateSearchQuery('你'.repeat(Math.floor(MAX_QUERY_BYTES / 3) + 1)), { ok: false, code: 'invalid_query' });
});

test('runner sends the query only on stdin, returns bounded stdout, and never uses console.log', async () => {
  const capture = {};
  const query = 'latest public release notes';
  const result = await runWebSearchQuery(query, {
    spawnImpl: fakeSpawn({
      start(child) {
        child.stdout.write('public result');
        child.emit('close', 0, null);
      },
    }, capture),
  });

  assert.deepEqual(result, { ok: true, text: 'public result' });
  assert.equal(capture.execPath, process.execPath);
  assert.deepEqual(capture.args, [WEB_SEARCH_SCRIPT_PATH]);
  assert.equal(capture.args.includes(query), false);
  assert.deepEqual(capture.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(capture.child.stdinText, query);
  assert.doesNotMatch(fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8'), /console\.log\s*\(/);
});

test('runner returns stable redacted spawn, exit, empty, and overflow failures', async () => {
  assert.deepEqual(await runWebSearchQuery('query', {
    spawnImpl() { throw new Error('secret spawn path'); },
  }), { ok: false, code: 'spawn_error' });

  const spawnEvent = await runWebSearchQuery('query', {
    spawnImpl: fakeSpawn({ start(child) { child.emit('error', new Error('secret spawn path')); } }),
  });
  assert.deepEqual(spawnEvent, { ok: false, code: 'spawn_error' });

  const nonzero = await runWebSearchQuery('query', {
    spawnImpl: fakeSpawn({ start(child) { child.stderr.write('provider-secret-config-path'); child.emit('close', 2, null); } }),
  });
  assert.deepEqual(nonzero, { ok: false, code: 'nonzero_exit' });
  assert.equal(JSON.stringify(nonzero).includes('provider-secret'), false);

  assert.deepEqual(await runWebSearchQuery('query', {
    spawnImpl: fakeSpawn({ start(child) { child.stdout.write('   \n'); child.emit('close', 0, null); } }),
  }), { ok: false, code: 'empty_output' });

  const stdoutCapture = {};
  const stdoutOverflow = await runWebSearchQuery('query', {
    stdoutLimit: 4,
    spawnImpl: fakeSpawn({
      start(child) { child.stdout.write('12345'); },
      onKill(signal, child) { if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null, signal)); },
    }, stdoutCapture),
  });
  assert.deepEqual(stdoutOverflow, { ok: false, code: 'stdout_overflow' });
  assert.deepEqual(stdoutCapture.child.kills, ['SIGTERM']);

  const stderrCapture = {};
  const stderrOverflow = await runWebSearchQuery('query', {
    stderrLimit: 4,
    spawnImpl: fakeSpawn({
      start(child) { child.stderr.write('secret-provider-diagnostic'); },
      onKill(signal, child) { if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null, signal)); },
    }, stderrCapture),
  });
  assert.deepEqual(stderrOverflow, { ok: false, code: 'stderr_overflow' });
  assert.deepEqual(stderrCapture.child.kills, ['SIGTERM']);

  const exactLimit = 'x'.repeat(MAX_STDOUT_BYTES);
  assert.deepEqual(await runWebSearchQuery('query', {
    spawnImpl: fakeSpawn({ start(child) { child.stdout.write(exactLimit); child.emit('close', 0, null); } }),
  }), { ok: true, text: exactLimit });
});

test('runner enforces timeout cancellation and SIGTERM/SIGKILL fallback without raw diagnostics', async () => {
  const timeoutCapture = {};
  const timeoutResult = await runWebSearchQuery('query', {
    timeoutMs: 5,
    terminateGraceMs: 5,
    forceSettleMs: 5,
    spawnImpl: fakeSpawn({}, timeoutCapture),
  });
  assert.deepEqual(timeoutResult, { ok: false, code: 'timeout' });
  assert.deepEqual(timeoutCapture.child.kills, ['SIGTERM', 'SIGKILL']);

  const cancelCapture = {};
  const controller = new AbortController();
  const cancelled = runWebSearchQuery('query', {
    timeoutMs: 1000,
    terminateGraceMs: 5,
    forceSettleMs: 5,
    signal: controller.signal,
    spawnImpl: fakeSpawn({
      onKill(signal, child) { if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null, signal)); },
    }, cancelCapture),
  });
  controller.abort();
  assert.deepEqual(await cancelled, { ok: false, code: 'cancelled' });
  assert.deepEqual(cancelCapture.child.kills, ['SIGTERM']);
  assert.equal(SEARCH_TIMEOUT_MS, 250_000);
});

test('persistent MCP server exposes exactly one strict annotated tool and survives a failed call', async () => {
  const failureCodes = [
    'nonzero_exit',
    'spawn_error',
    'timeout',
    'cancelled',
    'stdout_overflow',
    'stderr_overflow',
    'empty_output',
  ];
  let callCount = 0;
  const server = createWebSearchMcpServer({
    runSearch: async () => {
      const code = failureCodes[callCount++];
      return code
        ? { ok: false, code, secret: 'must-not-leak' }
        : { ok: true, text: 'fresh public answer' };
    },
  });
  const { client, close } = await connectInMemory(server);
  try {
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].name, TOOL_NAME);
    assert.equal(SERVER_NAME, 'betabot-web-search');
    assert.deepEqual(listed.tools[0].inputSchema.required, ['query']);
    assert.equal(listed.tools[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(listed.tools[0].inputSchema.properties), ['query']);
    assert.equal(listed.tools[0].inputSchema.properties.query.maxLength, MAX_QUERY_BYTES);
    assert.deepEqual(listed.tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(listed.tools[0].annotations, 'idempotentHint'), false);

    for (const code of failureCodes) {
      const failed = await client.callTool({ name: TOOL_NAME, arguments: { query: code } });
      assert.equal(failed.isError, true);
      assert.equal(failed.content[0].text, ERROR_MESSAGES[code]);
      assert.equal(JSON.stringify(failed).includes('must-not-leak'), false);
    }

    const succeeded = await client.callTool({ name: TOOL_NAME, arguments: { query: 'second' } });
    assert.equal(succeeded.isError, undefined);
    assert.equal(succeeded.content[0].text, 'fresh public answer');

    const invalidExtra = await client.callTool({ name: TOOL_NAME, arguments: { query: 'x', provider: 'caller-controlled' } });
    assert.equal(invalidExtra.isError, true);
    assert.match(String(invalidExtra.content?.[0]?.text || ''), /invalid|unrecognized|additional/i);
  } finally {
    await close();
  }
});

test('real stdio entrypoint emits protocol-only stdout for discovery', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [__filename.replace(/\.test\.js$/, '.js')],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += Buffer.from(chunk).toString('utf8'); });
  const client = new Client({ name: 'web-search-stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), [TOOL_NAME]);
    assert.equal(stderr, '');
  } finally {
    await client.close();
  }
});

test('adapter caps concurrency at two, fails the third fast, and recovers without a queue', async () => {
  const pending = [];
  let runnerCalls = 0;
  const server = createWebSearchMcpServer({
    runSearch: async query => {
      runnerCalls += 1;
      if (query === 'after') return { ok: true, text: 'recovered' };
      return await new Promise(resolve => pending.push(resolve));
    },
  });
  const { client, close } = await connectInMemory(server);
  try {
    const first = client.callTool({ name: TOOL_NAME, arguments: { query: 'one' } });
    const second = client.callTool({ name: TOOL_NAME, arguments: { query: 'two' } });
    await waitFor(() => runnerCalls === 2);

    const third = await client.callTool({ name: TOOL_NAME, arguments: { query: 'three' } });
    assert.equal(third.isError, true);
    assert.equal(third.content[0].text, ERROR_MESSAGES.busy);
    assert.equal(runnerCalls, 2);

    pending.shift()({ ok: true, text: 'one-result' });
    pending.shift()({ ok: true, text: 'two-result' });
    assert.equal((await first).content[0].text, 'one-result');
    assert.equal((await second).content[0].text, 'two-result');

    const after = await client.callTool({ name: TOOL_NAME, arguments: { query: 'after' } });
    assert.equal(after.content[0].text, 'recovered');
    assert.equal(runnerCalls, 3);
  } finally {
    await close();
  }
});

test('MCP request cancellation reaches the runner AbortSignal', async () => {
  let runnerStarted = false;
  let observedAbort = false;
  const server = createWebSearchMcpServer({
    runSearch: async (_query, { signal }) => await new Promise(resolve => {
      runnerStarted = true;
      signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve({ ok: false, code: 'cancelled' });
      }, { once: true });
    }),
  });
  const { client, close } = await connectInMemory(server);
  try {
    const controller = new AbortController();
    const call = client.callTool(
      { name: TOOL_NAME, arguments: { query: 'cancel through MCP' } },
      undefined,
      { signal: controller.signal },
    );
    await waitFor(() => runnerStarted);
    controller.abort();
    await assert.rejects(() => call, /abort/i);
    await waitFor(() => observedAbort);
  } finally {
    await close();
  }
});
