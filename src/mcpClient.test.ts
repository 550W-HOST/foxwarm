import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { createMcpConfigStore, listServers, setMcpConfigStoreForTests, summarizeServerConfig, summarizeServers, upsertServer } from './mcpClient';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-config-'));
  try {
    await run(dirPath);
  } finally {
    setMcpConfigStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
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

test('MCP config recovers from backup candidate after primary corruption', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'mcp.json');
    setMcpConfigStoreForTests(createMcpConfigStore(filePath));

    await upsertServer('alpha', { url: 'https://example.com/alpha' });
    await upsertServer('beta', { url: 'https://example.com/beta', transport: 'sse' });

    await fs.writeFile(filePath, '{broken-json');

    const servers = await listServers();
    assert.deepEqual(servers.map((item) => item.name), ['alpha']);

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten.servers).sort(), ['alpha']);
  });
});
