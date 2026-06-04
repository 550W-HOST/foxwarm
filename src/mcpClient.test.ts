import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { createMcpConfigStore, listServers, normalizeMcpToolResult, setMcpConfigStoreForTests, summarizeServerConfig, summarizeServers, upsertServer } from './mcpClient';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-config-'));
  try {
    await run(dirPath);
  } finally {
    setMcpConfigStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

async function listBackupMatches(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name === `${base}.bak` || name.startsWith(`${base}.`) && name.endsWith('.bak')).map((name) => path.join(dir, name));
}

test('summarizeServerConfig redacts sensitive MCP config values', () => {
  const summary = summarizeServerConfig('demo', {
    type: 'stdio',
    command: 'node',
    args: ['server.js', '--secret', 'super-secret'],
    env: {
      API_KEY: 'hidden',
      MODE: 'dev',
    },
    cwd: '/tmp/mcp',
    stderr: 'pipe',
    headers: {
      Authorization: 'Bearer hidden',
      'X-Api-Key': 'hidden-too',
    },
    token: 'top-secret-token',
    description: 'Demo server',
    enable: false,
  });

  assert.deepEqual(summary, {
    name: 'demo',
    enabled: false,
    transport: 'stdio',
    description: 'Demo server',
    command: 'node',
    cwd: '/tmp/mcp',
    stderr: 'pipe',
    argsCount: 3,
    envKeys: ['API_KEY', 'MODE'],
    headerKeys: ['Authorization', 'X-Api-Key'],
    hasToken: true,
  });

  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'headers'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'env'), false);
});

test('summarizeServers sorts by name and defaults transport to auto', () => {
  const summaries = summarizeServers({
    zebra: { url: 'https://example.com/zebra' },
    alpha: { url: 'https://example.com/alpha', transport: 'sse' },
  });

  assert.deepEqual(summaries.map((item) => [item.name, item.transport]), [
    ['alpha', 'sse'],
    ['zebra', 'auto'],
  ]);
});

test('MCP config uses lightweight no-backup writes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'mcp.json');
    setMcpConfigStoreForTests(createMcpConfigStore(filePath));

    await upsertServer('alpha', { url: 'https://example.com/alpha' });
    await upsertServer('beta', { url: 'https://example.com/beta', transport: 'sse' });

    const servers = await listServers();
    assert.deepEqual(servers.map((item) => item.name), ['alpha', 'beta']);

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten.servers).sort(), ['alpha', 'beta']);
    assert.deepEqual(createMcpConfigStore(filePath).listCandidatePaths(), [filePath]);
    assert.deepEqual(await listBackupMatches(filePath), []);
  });
});

test('normalizeMcpToolResult parses single JSON object and array text content', () => {
  assert.deepEqual(
    normalizeMcpToolResult({
      content: [{ type: 'text', text: '{"ok":true,"items":[1,2]}' }],
    }),
    { ok: true, items: [1, 2] },
  );

  assert.deepEqual(
    normalizeMcpToolResult({
      content: [{ type: 'text', text: '  [{"name":"fox"}]\n' }],
      isError: false,
    }),
    [{ name: 'fox' }],
  );
});

test('normalizeMcpToolResult keeps plain text and JSON primitives as strings', () => {
  assert.equal(
    normalizeMcpToolResult({ content: [{ type: 'text', text: 'plain text' }] }),
    'plain text',
  );
  assert.equal(
    normalizeMcpToolResult({ content: [{ type: 'text', text: '42' }] }),
    '42',
  );
  assert.equal(
    normalizeMcpToolResult({ content: [{ type: 'text', text: 'true' }] }),
    'true',
  );
  assert.equal(
    normalizeMcpToolResult({ content: [{ type: 'text', text: '"quoted"' }] }),
    '"quoted"',
  );
});

test('normalizeMcpToolResult preserves multi-content, non-text content, and metadata shapes', () => {
  const multiContent = {
    content: [
      { type: 'text', text: '{"ok":true}' },
      { type: 'text', text: 'extra text' },
    ],
  };
  assert.strictEqual(normalizeMcpToolResult(multiContent), multiContent);

  const imageContent = {
    content: [{ type: 'image', mimeType: 'image/png', data: 'abc123' }],
  };
  assert.strictEqual(normalizeMcpToolResult(imageContent), imageContent);

  const errorResult = {
    content: [{ type: 'text', text: '{"message":"failed"}' }],
    isError: true,
  };
  assert.strictEqual(normalizeMcpToolResult(errorResult), errorResult);

  const annotatedText = {
    content: [{ type: 'text', text: '{"ok":true}', annotations: { audience: ['assistant'] } }],
  };
  assert.strictEqual(normalizeMcpToolResult(annotatedText), annotatedText);
});
