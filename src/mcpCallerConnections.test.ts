import assert from 'node:assert/strict';
import test from 'node:test';
import { withMcpCallerConnection, closeMcpCallerConnections, type McpConnectionOptions } from './mcpCallerConnections';
import * as mcpClient from './mcpClient';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('shared setup and in-flight requests defer idle DELETE; closed setup cannot republish', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connecting = gate();
  const active = gate();
  let connects = 0;
  let deletes = 0;
  let closes = 0;
  class Transport {
    sessionId = 'allocated';
    async terminateSession() { deletes++; }
    async close() { closes++; }
  }
  class Client {
    transport: Transport;
    onclose?: () => void;
    async connect(transport: Transport) { this.transport = transport; connects++; await connecting.promise; }
    async close() { await this.transport.close(); this.onclose?.(); }
  }
  const options: McpConnectionOptions = { owner: { kind: 'session', id: 'same', isActive: () => true }, server: 'fake',
    mode: 'streamable-http', url: 'http://example.invalid/mcp', sdk: { Client, StreamableHTTPClientTransport: Transport, SSEClientTransport: Transport } };
  try {
    const first = withMcpCallerConnection(options, async entry => { await active.promise; return entry.client; });
    const second = withMcpCallerConnection(options, async entry => entry.client);
    assert.equal(connects, 1);
    connecting.resolve();
    const shared = await second;
    t.mock.timers.tick(15 * 60_000);
    assert.equal(deletes, 0, 'another request completing cannot close an in-flight request');
    active.resolve();
    assert.equal(await first, shared);
    t.mock.timers.tick(15 * 60_000);
    await closeMcpCallerConnections();
    assert.equal(deletes, 1);
    assert.equal(closes, 1);

    const delayed = gate();
    class DelayedClient extends Client {
      async connect(transport: Transport) { this.transport = transport; connects++; await delayed.promise; }
    }
    const pending = withMcpCallerConnection({ ...options, sdk: { ...options.sdk, Client: DelayedClient } }, async () => 'must not run');
    await closeMcpCallerConnections({ server: 'fake' });
    delayed.resolve();
    await assert.rejects(pending, /unavailable/);
    assert.equal(deletes, 2);
    await withMcpCallerConnection(options, async () => {});
    assert.equal(connects, 3, 'the closed setup was not cached as a usable connection');
  } finally { await closeMcpCallerConnections(); t.mock.timers.reset(); }
});

test('auto cleans failed HTTP initialization and reuses SSE; third-party same-name tools are not intercepted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-caller-'));
  let httpDeleted = 0;
  let sseClosed = 0;
  let sseConnects = 0;
  let calls = 0;
  class Http {
    sessionId = 'partially-initialized';
    async terminateSession() { httpDeleted++; throw new Error('DELETE not supported'); }
    async close() {}
  }
  class Sse {
    async close() { sseClosed++; }
  }
  class Client {
    transport: Http | Sse;
    onclose?: () => void;
    async connect(transport: Http | Sse) {
      this.transport = transport;
      if (transport instanceof Http) { await this.close(); throw new Error('synthetic initialize failure'); }
      sseConnects++;
    }
    getServerCapabilities() { return { tools: {} }; }
    async listTools() { return { tools: [{ name: 'foxwarm_session' }] }; }
    async callTool() { calls++; return { content: [{ type: 'text', text: 'third-party result' }] }; }
    async close() { await this.transport.close(); this.onclose?.(); }
  }
  const owner = { kind: 'session' as const, id: 'owner', isActive: () => true };
  try {
    mcpClient.setMcpConfigStoreForTests(mcpClient.createMcpConfigStore(path.join(dir, 'mcp.json')));
    mcpClient.setMcpSdkForTests({ Client, StreamableHTTPClientTransport: Http, SSEClientTransport: Sse, StdioClientTransport: Http });
    await mcpClient.upsertServer('peer', { transport: 'auto', url: 'http://example.invalid/mcp' });
    await mcpClient.listTools('peer', undefined, owner);
    assert.equal(await mcpClient.callTool('peer', 'foxwarm_session', { action: 'send', reply: true }, { owner }), 'third-party result');
    await mcpClient.listTools('peer', undefined, owner);
    assert.equal(httpDeleted, 1, 'allocated failed HTTP attempt is released before SSE fallback');
    assert.equal(sseConnects, 1);
    assert.equal(calls, 1);
    await closeMcpCallerConnections();
    assert.equal(httpDeleted, 1, 'SSE cleanup does not issue HTTP DELETE');
    assert.equal(sseClosed, 1);
  } finally {
    await mcpClient.resetMcpConnectionsForTests();
    mcpClient.setMcpConfigStoreForTests(null);
    await fs.remove(dir);
  }
});
