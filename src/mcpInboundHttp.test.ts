import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { HttpServer } from './httpServer';
import { normalizeMcpInboundConfig } from './mcpInboundConfig';
import { McpInboundHttpService, type ExternalExecutionContext, type McpInboundCatalog } from './mcpInboundHttp';

const alphaToken = 'synthetic-inbound-token-alpha';
const betaToken = 'synthetic-inbound-token-beta';
const config = normalizeMcpInboundConfig({ enabled: true, identities: {
  alpha: { token: alphaToken }, beta: { token: betaToken },
} });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function withInbound(
  catalog: McpInboundCatalog | undefined,
  action: (url: URL, service: McpInboundHttpService) => Promise<void>,
  idleMs = 60_000,
  maxSessions = 32,
  postDeadlineMs = 60_000,
): Promise<void> {
  const port = await freePort();
  const server = new HttpServer(port, 'instance-token');
  const inbound = new McpInboundHttpService(config, catalog, idleMs, maxSessions, postDeadlineMs);
  inbound.register(server);
  await server.start();
  try {
    await action(new URL(`http://127.0.0.1:${port}/mcp`), inbound);
  } finally {
    await inbound.stop();
    await server.stop();
  }
}

function sdkClient(url: URL, token: string, sessionId?: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }, sessionId,
  });
  const client = new Client({ name: 'synthetic-sdk-test', version: '1.0.0' });
  return { client, transport };
}

const tools: Tool[] = [{
  name: 'synthetic_context', description: 'A synthetic test-only tool.',
  inputSchema: { type: 'object', additionalProperties: true },
}];

function rawHeaders(token: string, sessionId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
}

test('real SDK transport binds identity and mutable execution context to one connection', async () => {
  const seen: ExternalExecutionContext[] = [];
  const catalog: McpInboundCatalog = {
    async listTools(context) { seen.push(context); return tools; },
    async callTool(context, _name, args): Promise<CallToolResult> {
      if (args.selectNode === true) context.currentNode = 'synthetic-node';
      return { content: [{ type: 'text', text: JSON.stringify({ id: context.id, externalId: context.externalId, currentNode: context.currentNode, cwd: context.cwd }) }] };
    },
  };
  await withInbound(catalog, async url => {
    const a = sdkClient(url, alphaToken);
    const b = sdkClient(url, betaToken);
    const a2 = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);
    await a2.client.connect(a2.transport);
    try {
      assert.ok(a.transport.sessionId);
      assert.ok(b.transport.sessionId);
      assert.notEqual(a.transport.sessionId, b.transport.sessionId);
      assert.notEqual(a.transport.sessionId, a2.transport.sessionId);
      assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['synthetic_context']);
      const output = await a.client.callTool({ name: 'synthetic_context', arguments: { externalId: 'beta', id: b.transport.sessionId, selectNode: true } }) as CallToolResult;
      const payload = JSON.parse((output.content[0] as { text: string }).text);
      assert.equal(payload.id, a.transport.sessionId);
      assert.equal(payload.externalId, 'alpha');
      assert.equal(payload.currentNode, 'synthetic-node');
      assert.equal(payload.cwd, null);
      const again = await a.client.callTool({ name: 'synthetic_context', arguments: {} }) as CallToolResult;
      assert.equal(JSON.parse((again.content[0] as { text: string }).text).currentNode, 'synthetic-node');
      const other = await b.client.callTool({ name: 'synthetic_context', arguments: {} }) as CallToolResult;
      assert.equal(JSON.parse((other.content[0] as { text: string }).text).currentNode, 'master');
      const secondSameIdentity = await a2.client.callTool({ name: 'synthetic_context', arguments: {} }) as CallToolResult;
      assert.equal(JSON.parse((secondSameIdentity.content[0] as { text: string }).text).currentNode, 'master');
      assert.equal(seen[0].id, a.transport.sessionId);
      assert.equal(seen[0].externalId, 'alpha');
    } finally {
      await a.client.close();
      await b.client.close();
      await a2.client.close();
    }
  });
});

test('every POST/GET/DELETE independently authenticates and checks session owner', async () => {
  await withInbound({ async listTools() { return tools; }, async callTool() { return { content: [] }; } }, async url => {
    const a = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    const id = a.transport.sessionId!;
    const sessionUrl = url.toString();
    try {
      const wrongGet = await fetch(sessionUrl, { headers: { ...rawHeaders(betaToken, id), Accept: 'text/event-stream' } });
      assert.equal(wrongGet.status, 404);
      await wrongGet.body?.cancel();
      const wrongPost = await fetch(sessionUrl, { method: 'POST', headers: rawHeaders(betaToken, id), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
      assert.equal(wrongPost.status, 404);
      const wrongDelete = await fetch(sessionUrl, { method: 'DELETE', headers: rawHeaders(betaToken, id) });
      assert.equal(wrongDelete.status, 404);
      const cookieOnly = await fetch(sessionUrl, { method: 'DELETE', headers: { Cookie: 'foxwarm_token=instance-token', 'Mcp-Session-Id': id } });
      assert.equal(cookieOnly.status, 401);
      const noAuth = await fetch(sessionUrl, { method: 'POST', headers: { 'Mcp-Session-Id': id, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
      assert.equal(noAuth.status, 401);
      const noOriginTrust = await fetch(sessionUrl, { method: 'POST', headers: { ...rawHeaders(alphaToken, id), Origin: 'https://other.example' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) });
      assert.equal(noOriginTrust.status, 403);
      const noNewContext = await fetch(sessionUrl, { method: 'POST', headers: rawHeaders(betaToken, id), body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { clientInfo: { name: 'alpha', version: '1' }, protocolVersion: '2025-03-26', capabilities: {} } }) });
      assert.equal(noNewContext.status, 404);
      assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['synthetic_context']);
      await a.transport.terminateSession();
      const ended = await fetch(sessionUrl, { headers: { ...rawHeaders(alphaToken, id), Accept: 'text/event-stream' } });
      assert.equal(ended.status, 404);
    } finally {
      await a.client.close();
    }
  });
});

test('SSE reconnect stays bound to same owner and sessions expire within a bounded idle window', async () => {
  await withInbound(undefined, async (url, service) => {
    const initialized = await fetch(url, { method: 'POST', headers: rawHeaders(alphaToken), body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        clientInfo: { name: 'synthetic-reconnect-client', version: '1.0.0' },
        protocolVersion: '2025-03-26', capabilities: {},
      },
    }) });
    assert.equal(initialized.status, 200);
    const id = initialized.headers.get('mcp-session-id')!;
    assert.ok(id);
    const firstController = new AbortController();
    const first = await fetch(url, { headers: { ...rawHeaders(alphaToken, id), Accept: 'text/event-stream' }, signal: firstController.signal });
    assert.equal(first.status, 200);
    firstController.abort();
    let reconnect: globalThis.Response | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      reconnect = await fetch(url, { headers: { ...rawHeaders(alphaToken, id), Accept: 'text/event-stream' } });
      if (reconnect.status === 200) break;
      assert.equal(reconnect.status, 409);
      await reconnect.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.ok(reconnect);
    assert.equal(reconnect.status, 200);
    assert.match(reconnect.headers.get('content-type') || '', /text\/event-stream/);
    await reconnect.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 350));
    const expired = await fetch(url, { headers: { ...rawHeaders(alphaToken, id), Accept: 'text/event-stream' } });
    assert.equal(expired.status, 404);
    await service.stop();
    assert.equal((await fetch(url, { headers: rawHeaders(alphaToken, id) })).status, 503);
  }, 200, 1);
});

test('SDK and Express admit real-sized requests/results and bound excessive payloads without repeating effects', async () => {
  let calls = 0;
  await withInbound({
    async listTools() { return tools; },
    async callTool(_context, _name, args) {
      calls++;
      return { content: [{ type: 'text', text: 'A'.repeat(args.large ? 17 * 1024 * 1024 : 70 * 1024) }] };
    },
  }, async url => {
    const noSession = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${alphaToken}` } });
    assert.equal(noSession.status, 400);
    const malformed = await fetch(url, { method: 'POST', headers: rawHeaders(alphaToken), body: '{}' });
    assert.equal(malformed.status, 400);
    const secretInBody = 'unexpected-user-supplied-secret-123';
    const anonymousMalformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{${secretInBody}` });
    assert.equal(anonymousMalformed.status, 401);
    for (const alternate of ['/mcp/', '/MCP']) {
      const anonymousAlternate = await fetch(new URL(alternate, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{${secretInBody}` });
      assert.equal(anonymousAlternate.status, 401);
    }
    const authenticatedMalformed = await fetch(url, { method: 'POST', headers: rawHeaders(alphaToken), body: `{${secretInBody}` });
    assert.equal(authenticatedMalformed.status, 400);
    assert.equal((await authenticatedMalformed.text()).includes(secretInBody), false);
    const a = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    try {
      const result = await a.client.callTool({ name: 'synthetic_context', arguments: {} });
      const content = (result as CallToolResult).content;
      assert.equal(content[0]?.type, 'text');
      assert.equal((content[0] as any)?.text.length, 70 * 1024);
      const tooLargeResult = await a.client.callTool({ name: 'synthetic_context', arguments: { large: true } });
      assert.equal(tooLargeResult.isError, true);
      assert.match((((tooLargeResult as CallToolResult).content?.[0]) as any)?.text || '', /may have completed.*Do not retry/);
      assert.equal(calls, 2);
      const oversized = await fetch(url, { method: 'POST', headers: rawHeaders(alphaToken, a.transport.sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: { bulk: 'B'.repeat(8 * 1024 * 1024 + 1) } }) });
      assert.equal(oversized.status, 413);
      const badMedia = await fetch(url, { method: 'POST', headers: { ...rawHeaders(alphaToken, a.transport.sessionId), 'Content-Type': 'text/plain' }, body: '{}' });
      assert.equal(badMedia.status, 415);
      const badAccept = await fetch(url, { method: 'POST', headers: { ...rawHeaders(alphaToken, a.transport.sessionId), Accept: 'application/json' }, body: '{}' });
      assert.equal(badAccept.status, 406);
      assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['synthetic_context']);
    } finally { await a.client.close(); }
  });
});

test('a stalled SDK tool request times out and aborts its handler without discarding the live transport', async () => {
  let aborted = false;
  await withInbound({
    async listTools() { return tools; },
    async callTool(_context, _name, _args, signal) {
      return new Promise<CallToolResult>(resolve => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ content: [] }); }, { once: true });
      });
    },
  }, async url => {
    const a = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    const id = a.transport.sessionId!;
    try {
      const response = await fetch(url, { method: 'POST', headers: rawHeaders(alphaToken, id), body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'synthetic_context', arguments: {} },
      }) });
      assert.equal(response.status, 504);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(aborted, true);
      const retained = await a.client.listTools();
      assert.deepEqual(retained.tools.map(tool => tool.name), ['synthetic_context']);
    } finally { await a.client.close(); }
  }, 60_000, 1, 80);
});

test('a live outbound call may outlast idle expiry without losing its context, then returns to normal idle timeout', async () => {
  await withInbound({
    async listTools() { return tools; },
    async callTool() {
      await new Promise(resolve => setTimeout(resolve, 180));
      return { content: [{ type: 'text', text: 'completed once' }] };
    },
  }, async url => {
    const a = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    const id = a.transport.sessionId!;
    try {
      const result = await a.client.callTool({ name: 'synthetic_context', arguments: {} }) as CallToolResult;
      assert.equal((result.content[0] as any).text, 'completed once');
      assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name), ['synthetic_context']);
      await new Promise(resolve => setTimeout(resolve, 220));
      const expired = await fetch(url, { headers: { ...rawHeaders(alphaToken, id), Accept: 'text/event-stream' } });
      assert.equal(expired.status, 404);
    } finally { await a.client.close(); }
  }, 80, 1, 500);
});

test('bounded MCP session capacity is released on DELETE without adopting another context', async () => {
  await withInbound(undefined, async url => {
    const a = sdkClient(url, alphaToken);
    await a.client.connect(a.transport);
    const id = a.transport.sessionId!;
    const full = await fetch(url, { method: 'POST', headers: rawHeaders(betaToken), body: JSON.stringify({
      jsonrpc: '2.0', id: 10, method: 'initialize', params: {
        clientInfo: { name: 'capacity-client', version: '1.0.0' },
        protocolVersion: '2025-03-26', capabilities: {},
      },
    }) });
    assert.equal(full.status, 503);
    await a.transport.terminateSession();
    await a.client.close();
    const b = sdkClient(url, betaToken);
    await b.client.connect(b.transport);
    try { assert.notEqual(b.transport.sessionId, id); }
    finally { await b.client.close(); }
  }, 60_000, 1);
});
