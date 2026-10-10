import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { callTool, createMcpConfigStore, normalizeMcpToolResult, resetMcpConnectionsForTests, setMcpConfigStoreForTests, setMcpSdkForTests, upsertServer } from './mcpClient';

test('structured results remove JSON duplicates and unwrap real fields without mutating the wire result', () => {
  const value = { accepted: true, execId: 'exec-one', output: { items: [1, true, null], detail: { a: 1, b: 2 } } };
  const wire = { structuredContent: value, isError: false, content: [
    { type: 'text', text: ' { "output": {"detail":{"b":2,"a":1},"items":[1,true,null]}, "execId":"exec-one", "accepted":true } ' },
    { type: 'text', text: JSON.stringify(value) },
  ] };
  assert.strictEqual(normalizeMcpToolResult(wire), value);
  assert.equal(wire.content.length, 2);
  assert.strictEqual(normalizeMcpToolResult({ structuredContent: value, content: [], isError: false }), value);
  assert.strictEqual(normalizeMcpToolResult({ structuredContent: value }), value);
  const different = { structuredContent: value, content: [{ type: 'text', text: JSON.stringify({ ...value, accepted: 'true' }) }] };
  assert.strictEqual(normalizeMcpToolResult(different), different, 'different JSON values remain visible');
});

test('deduplication retains error, meaningful text metadata, explanations and multimodal information', () => {
  const structuredContent = { count: 1 };
  const annotated = { type: 'text', text: '{"count":1}', annotations: { audience: ['assistant'] } };
  const explanation = { type: 'text', text: 'The partial result needs review.' };
  const audio = { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' };
  const resource = { type: 'resource', resource: { uri: 'fixture:result', text: 'resource text' } };
  const normalized = normalizeMcpToolResult({ structuredContent, isError: true, _meta: { partial: true }, content: [
    { type: 'text', text: '{"count":1}' }, explanation, annotated, audio, resource,
    { type: 'image', data: 'YQ==', mimeType: 'image/png', _meta: { source: 'fixture' } },
  ] });
  assert.deepEqual(normalized, { structuredContent, isError: true, _meta: { partial: true },
    content: [explanation, annotated, audio, resource],
    inlineDataItems: [{ data: 'YQ==', mimeType: 'image/png', _meta: { source: 'fixture' } }],
  });
  assert.deepEqual(normalizeMcpToolResult({ structuredContent, isError: true, content: [{ type: 'text', text: '{"count":1}' }] }),
    { structuredContent, isError: true, content: [] });
  assert.deepEqual(normalizeMcpToolResult({ structuredContent, _meta: { tag: 'keep' }, content: [] }),
    { structuredContent, _meta: { tag: 'keep' }, content: [] });
});

test('ordinary calls unwrap at the source while raw MCP passthrough keeps both wire representations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-result-'));
  const value = { accepted: true, execId: 'exec-one' };
  const wire = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  class Transport { async terminateSession() {} async close() {} }
  class Client {
    async connect() {}
    async close() {}
    async callTool() { return wire; }
  }
  try {
    setMcpConfigStoreForTests(createMcpConfigStore(path.join(dir, 'mcp.json')));
    setMcpSdkForTests({ Client, StreamableHTTPClientTransport: Transport, SSEClientTransport: Transport, StdioClientTransport: Transport });
    await upsertServer('peer', { transport: 'streamable-http', url: 'http://example.invalid/mcp' });
    assert.strictEqual(await callTool('peer', 'synthetic_result'), value);
    assert.strictEqual(await callTool('peer', 'synthetic_result', {}, { rawResult: true }), wire);
    assert.equal(wire.content.length, 1);
  } finally {
    await resetMcpConnectionsForTests();
    setMcpConfigStoreForTests(null);
    await fs.remove(dir);
  }
});
