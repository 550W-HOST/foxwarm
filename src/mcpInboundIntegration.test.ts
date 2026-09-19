import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { HttpServer } from './httpServer';
import * as mcpClient from './mcpClient';
import { McpInboundMcpCatalog } from './mcpInboundCatalog';
import { normalizeMcpInboundConfig } from './mcpInboundConfig';
import { McpInboundHttpService } from './mcpInboundHttp';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';

const alpha = 'synthetic-alpha-inbound-credential';
const beta = 'synthetic-beta-inbound-credential';
const outboundSecret = 'synthetic-configured-outbound-secret';
const inboundConfig = normalizeMcpInboundConfig({ enabled: true, identities: {
  alpha: { token: alpha }, beta: { token: beta },
} });
const POLICY = `version: 1
defaultAction: allow
rules:
  - id: beta-deny-text
    match: { externalId: beta, tool: { source: mcp, server: local, name: echo_text } }
    action: deny
  - id: common-generic-allow
    match: { tool: { source: mcp, server: local, name: [echo_text, typed, image, fail, throw, slow, leak] } }
    action: allow
  - id: beta-only
    match: { externalId: beta, tool: { source: mcp, server: local, name: only_beta } }
    action: allow
  - id: alpha-conditional
    match: { externalId: alpha, tool: { source: mcp, server: local, name: conditional }, args: { enabled: { equals: true } } }
    action: allow
  - id: unavailable-master-only
    match: { tool: { source: mcp, server: local, name: master_only }, targetNode: master }
    action: allow
`;
const names = ['echo_text', 'typed', 'image', 'fail', 'throw', 'slow', 'leak', 'only_beta', 'conditional', 'session_gate', 'master_only', 'no_rule'];
const tools: Tool[] = names.map(name => ({ name, description: `Synthetic ${name} tool.${name === 'leak' ? ` ${outboundSecret}` : ''}`, inputSchema: {
  type: 'object', additionalProperties: true, properties: { message: { type: 'string' }, enabled: { type: 'boolean' } },
} }));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') { reject(new Error('Expected TCP listener.')); return; }
      probe.close(() => resolve(address.port));
    });
  });
}

async function fakeOutbound() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  const calls: Record<string, number> = {};
  const methods: string[] = [];
  let cancelled = false;
  app.all('/remote', async (req, res) => {
    if (typeof req.body?.method === 'string') methods.push(req.body.method);
    if (req.headers.authorization !== `Bearer ${outboundSecret}`) { res.status(401).end(); return; }
    const id = req.headers['mcp-session-id'];
    let connection = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!connection && req.method === 'POST' && req.body?.method === 'initialize') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: sessionId => { sessions.set(sessionId, connection!); },
      });
      const server = new Server({ name: 'synthetic-outbound', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const name = request.params.name;
        calls[name] = (calls[name] || 0) + 1;
        const args = request.params.arguments || {};
        if (name === 'echo_text') return { content: [{ type: 'text', text: String(args.message || 'text-result') }] };
        if (name === 'typed') return { content: [{ type: 'text', text: 'visible text' }], structuredContent: { nested: { number: 42 }, source: 'typed' } };
        if (name === 'image') return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(100_000, 17).toString('base64') }] };
        if (name === 'fail') return { isError: true, content: [{ type: 'text', text: 'synthetic tool failure' }] };
        if (name === 'throw') throw new Error('synthetic remote crash');
        if (name === 'leak') return { content: [{ type: 'text', text: `remote response ${outboundSecret}` }] };
        if (name === 'slow') {
          await new Promise<void>(resolve => extra.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
          return { isError: true, content: [{ type: 'text', text: 'cancelled' }] };
        }
        return { content: [{ type: 'text', text: name }] };
      });
      connection = { transport, server };
      await server.connect(transport);
    }
    if (!connection) { res.status(404).end(); return; }
    try { await connection.transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).end(); }
    if (req.method === 'DELETE' && typeof id === 'string') {
      sessions.delete(id);
      await connection.server.close().catch(() => {});
    }
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => httpServer.once('listening', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected local HTTP address.');
  return {
    url: `http://127.0.0.1:${address.port}/remote`, calls, methods,
    wasCancelled: () => cancelled,
    async stop() {
      await Promise.allSettled([...sessions.values()].map(connection => connection.server.close()));
      sessions.clear();
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}

function client(url: URL, token: string, sessionId?: string) {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } }, sessionId });
  return { transport, client: new Client({ name: 'synthetic-integration', version: '1.0.0' }) };
}
function callResultText(result: any): string {
  return (result.content?.[0] as { text: string })?.text || '';
}

async function withIntegratedServices(run: (data: {
  url: URL; calls: Record<string, number>; methods: string[]; wasCancelled: () => boolean; responses: Array<{ listenerCount: number }>;
}) => Promise<void>, deadlineMs = 60_000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-inbound-integration-'));
  const fake = await fakeOutbound();
  const store = mcpClient.createMcpConfigStore(path.join(dir, 'servers.json'));
  mcpClient.setMcpConfigStoreForTests(store);
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(POLICY));
  const port = await availablePort();
  const app = new HttpServer(port, 'instance-token');
  const responses: Array<{ listenerCount: number }> = [];
  app.app.use('/mcp', (_req, res, next) => {
    res.once('close', () => { responses.push({ listenerCount: res.listenerCount('close') }); });
    next();
  });
  const inbound = new McpInboundHttpService(inboundConfig, new McpInboundMcpCatalog(), 60_000, 32, deadlineMs);
  inbound.register(app);
  try {
    await mcpClient.upsertServer('local', { transport: 'streamable-http', url: fake.url, token: outboundSecret, timeoutSeconds: 2 });
    await app.start();
    await run({ url: new URL(`http://127.0.0.1:${port}/mcp`), calls: fake.calls, methods: fake.methods, wasCancelled: fake.wasCancelled, responses });
  } finally {
    await inbound.stop();
    await app.stop();
    await fake.stop();
    setToolAuthorizationPolicyForTests(undefined);
    mcpClient.setMcpConfigStoreForTests(null);
    await mcpClient.resetMcpConnectionsForTests();
    await fs.remove(dir);
  }
}

test('real SDK inbound → Main outbound MCP enforces owner/rules and preserves typed text/structured/image/errors', async () => {
  await withIntegratedServices(async ({ url, calls, responses }) => {
    const a = client(url, alpha), b = client(url, beta);
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);
    try {
      setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`${POLICY}  - id: alpha-session-only
    match: { externalId: alpha, session: ${a.transport.sessionId}, tool: { source: mcp, server: local, name: session_gate } }
    action: allow
`));
      assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['foxwarm_discover', 'foxwarm_call']);
      const listed = await a.client.callTool({ name: 'foxwarm_discover', arguments: { sources: ['mcp'], limit: 50 } });
      assert.equal(listed.isError, undefined);
      const detail = listed.structuredContent as any;
      assert.equal(JSON.stringify(listed).includes(outboundSecret), false);
      assert.equal(detail.totalKnown, true);
      assert.equal(detail.truncated, false);
      const ids = detail.tools.map((entry: any) => entry.toolId);
      assert.ok(ids.includes('mcp:local/echo_text'));
      assert.ok(ids.includes('mcp:local/conditional')); // Conditional discovery does not guarantee call permission.
      assert.ok(ids.includes('mcp:local/session_gate'));
      assert.ok(!ids.includes('mcp:local/only_beta'));
      assert.ok(!ids.includes('mcp:local/no_rule'));
      assert.ok(!ids.includes('mcp:local/master_only')); // Non-Node calls have no targetNode fact.
      const filtered = await b.client.callTool({ name: 'foxwarm_discover', arguments: { query: 'echo_text', limit: 50 } });
      assert.equal((filtered.structuredContent as any)?.total, 0);
      const limited = await a.client.callTool({ name: 'foxwarm_discover', arguments: { limit: 1, includeSchema: false } });
      assert.equal((limited.structuredContent as any)?.returned, 1);
      assert.equal((limited.structuredContent as any)?.truncated, true);
      assert.equal((limited.structuredContent as any)?.tools?.[0]?.inputSchema, undefined);
      const metadata = await a.client.callTool({ name: 'foxwarm_discover', arguments: { sources: ['builtin', 'node'], limit: 5 } });
      assert.equal((metadata.structuredContent as any)?.total, 0); // Unsupported sources are not advertised.
      const text = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/echo_text', args: { message: 'hello', externalId: 'beta', session: b.transport.sessionId } } });
      assert.equal(callResultText(text), 'hello');
      const large = 'R'.repeat(100 * 1024);
      const largeText = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/echo_text', args: { message: large } } });
      assert.equal(callResultText(largeText), large);
      const typed = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/typed' } });
      assert.equal(callResultText(typed), 'visible text');
      assert.deepEqual(typed.structuredContent, { nested: { number: 42 }, source: 'typed' });
      const image = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/image' } });
      assert.equal(((image as CallToolResult).content[0] as any)?.mimeType, 'image/png');
      assert.ok(((image as CallToolResult).content[0] as any)?.data.length > 100_000);
      const failure = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/fail' } });
      assert.equal(failure.isError, true);
      assert.match(callResultText(failure), /synthetic tool failure/);
      assert.equal(calls.fail, 1);
      const thrown = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/throw' } });
      assert.equal(thrown.isError, true);
      assert.match(callResultText(thrown), /outcome may be unknown.*synthetic remote crash/);
      assert.equal(calls.throw, 1);
      const rejected = await b.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/echo_text' } });
      assert.equal(rejected.isError, true);
      assert.equal(calls.echo_text, 2);
      const spoof = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/only_beta', args: { externalId: 'beta', session: b.transport.sessionId } } });
      assert.equal(spoof.isError, true);
      assert.equal(calls.only_beta, undefined);
      const sessionGate = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/session_gate' } });
      assert.equal(callResultText(sessionGate), 'session_gate');
      const anotherAlpha = client(url, alpha);
      await anotherAlpha.client.connect(anotherAlpha.transport);
      try {
        const foreignContext = await anotherAlpha.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/session_gate' } });
        assert.equal(foreignContext.isError, true);
        assert.equal(calls.session_gate, 1);
      } finally { await anotherAlpha.client.close(); }
      const unmatched = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/no_rule' } });
      assert.equal(unmatched.isError, true);
      assert.equal(calls.no_rule, undefined);
      const conditional = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/conditional', args: { enabled: false } } });
      assert.equal(conditional.isError, true);
      assert.equal(calls.conditional, undefined);
      const allowed = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/conditional', args: { enabled: true } } });
      assert.equal(callResultText(allowed), 'conditional');
      const secret = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/leak' } });
      assert.equal(JSON.stringify(secret).includes(outboundSecret), false);
      assert.match(callResultText(secret), /\[redacted\]/);
      const cookie = await fetch(url, { headers: { Cookie: 'foxwarm_token=instance-token' } });
      assert.equal(cookie.status, 401);
      const foreign = await fetch(url, { headers: { Authorization: `Bearer ${beta}`, 'Mcp-Session-Id': a.transport.sessionId!, Accept: 'text/event-stream' } });
      assert.equal(foreign.status, 404);
      for (let index = 0; index < 20; index++) {
        const response = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/echo_text', args: { message: 'repeat' } } });
        assert.equal(callResultText(response), 'repeat');
      }
      await wait(10);
      assert.ok(responses.length >= 20);
      assert.ok(responses.every(entry => entry.listenerCount < 6), 'POST close listeners must not grow across requests');
      const previousCalls = calls.echo_text;
      setToolAuthorizationPolicyForTests(undefined);
      const noPolicy = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/echo_text' } });
      assert.equal(noPolicy.isError, true);
      assert.equal(calls.echo_text, previousCalls);
    } finally { await a.client.close(); await b.client.close(); }
  });
});

test('an outbound MCP timeout/cancellation is not retried and reports unknown tool outcome', async () => {
  await withIntegratedServices(async ({ url, calls, methods, wasCancelled }) => {
    const a = client(url, alpha);
    await a.client.connect(a.transport);
    try {
      const slow = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/slow' } }).catch(error => error);
      assert.match(String(slow), /timed out|unknown|abort/i);
      for (let attempt = 0; attempt < 30 && !wasCancelled(); attempt++) await wait(15);
      assert.equal(wasCancelled(), true, JSON.stringify({ methods, calls }));
      assert.equal(calls.slow, 1);
    } finally { await a.client.close(); }
  }, 150);
});

test('configured outbound SDK tool timeout retains its own deadline and does not repeat the effect', async () => {
  await withIntegratedServices(async ({ url, calls }) => {
    await mcpClient.upsertServer('local', { timeoutSeconds: 1 });
    const a = client(url, alpha);
    await a.client.connect(a.transport);
    try {
      const started = Date.now();
      const slow = await a.client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:local/slow' } });
      assert.equal(slow.isError, true);
      assert.match(callResultText(slow), /outcome may be unknown.*timed out/i);
      assert.ok(Date.now() - started >= 900, 'The managed SDK timeout should govern the request.');
      assert.equal(calls.slow, 1);
    } finally { await a.client.close(); }
  }, 3_000);
});
