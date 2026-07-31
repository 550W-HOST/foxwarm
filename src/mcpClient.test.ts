import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { buildMcpHttpHeadersForTests, createMcpConfigStore, listServers, normalizeMcpToolResult, setMcpConfigStoreForTests, setServerEnabled, summarizeServerConfig, summarizeServers, upsertServer } from './mcpClient';

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

test('live MCP config ignores manual file edits until the runtime store is reset', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'mcp.json');
    await fs.writeJson(filePath, {
      servers: { alpha: { url: 'https://example.com/alpha' } },
    });
    setMcpConfigStoreForTests(createMcpConfigStore(filePath));

    assert.deepEqual((await listServers()).map((item) => item.name), ['alpha']);

    await fs.writeJson(filePath, {
      servers: { manual: { url: 'https://example.com/manual' } },
    });
    assert.deepEqual((await listServers()).map((item) => item.name), ['alpha']);

    setMcpConfigStoreForTests(createMcpConfigStore(filePath));
    assert.deepEqual((await listServers()).map((item) => item.name), ['manual']);
  });
});

test('managed MCP updates become live only after their durable write succeeds', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'mcp.json');
    const store = createMcpConfigStore(filePath);
    setMcpConfigStoreForTests(store);

    await upsertServer('alpha', { url: 'https://example.com/alpha' });
    assert.deepEqual((await listServers()).map((item) => [item.name, item.enabled]), [['alpha', true]]);

    const originalWrite = store.write.bind(store);
    (store as any).write = async () => {
      throw new Error('simulated durable write failure');
    };
    await assert.rejects(
      () => upsertServer('beta', { url: 'https://example.com/beta' }),
      /simulated durable write failure/,
    );
    assert.deepEqual((await listServers()).map((item) => item.name), ['alpha']);

    (store as any).write = originalWrite;
    await Promise.all([
      upsertServer('beta', { url: 'https://example.com/beta' }),
      upsertServer('gamma', { url: 'https://example.com/gamma' }),
    ]);
    await setServerEnabled('alpha', false);
    assert.deepEqual((await listServers()).map((item) => [item.name, item.enabled]), [
      ['alpha', false],
      ['beta', true],
      ['gamma', true],
    ]);
  });
});

test('MCP HTTP headers use the token as a default and let custom headers override it', () => {
  assert.deepEqual(
    buildMcpHttpHeadersForTests({ token: 'token-only' }),
    { Authorization: 'Bearer token-only' },
  );

  assert.deepEqual(
    buildMcpHttpHeadersForTests({ headers: { 'X-Api-Key': 'headers-only' } }),
    { 'X-Api-Key': 'headers-only' },
  );

  assert.deepEqual(
    buildMcpHttpHeadersForTests({
      token: 'with-custom-header',
      headers: { 'X-Api-Key': 'custom-value' },
    }),
    {
      Authorization: 'Bearer with-custom-header',
      'X-Api-Key': 'custom-value',
    },
  );

  assert.deepEqual(
    buildMcpHttpHeadersForTests({
      token: 'must-not-win',
      headers: { Authorization: 'Basic custom-authorization' },
    }),
    { Authorization: 'Basic custom-authorization' },
  );

  assert.deepEqual(
    buildMcpHttpHeadersForTests({
      token: 'must-not-win-with-different-casing',
      headers: { authorization: 'Basic lowercase-authorization' },
    }),
    { authorization: 'Basic lowercase-authorization' },
  );
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

test('normalizeMcpToolResult promotes pure and multiple MCP image content blocks', () => {
  assert.deepEqual(
    normalizeMcpToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: 'small-image-base64' }],
      isError: false,
    }),
    {
      inlineDataItems: [{ mimeType: 'image/png', data: 'small-image-base64' }],
      isError: false,
    },
  );

  assert.deepEqual(
    normalizeMcpToolResult({
      content: [
        { type: 'image', mimeType: 'image/png', data: 'first-image-base64' },
        { type: 'image', mimeType: 'image/jpeg', data: 'second-image-base64' },
      ],
    }),
    {
      inlineDataItems: [
        { mimeType: 'image/png', data: 'first-image-base64' },
        { mimeType: 'image/jpeg', data: 'second-image-base64' },
      ],
    },
  );
});

test('normalizeMcpToolResult promotes images from mixed content without changing other content types', () => {
  const textContent = { type: 'text', text: 'caption' };
  const resourceContent = {
    type: 'resource',
    resource: {
      uri: 'file:///example.bin',
      mimeType: 'application/octet-stream',
      blob: 'resource-blob-base64',
    },
  };
  const audioContent = {
    type: 'audio',
    mimeType: 'audio/wav',
    data: 'audio-base64',
  };
  const malformedImageContent = {
    type: 'image',
    mimeType: 'application/octet-stream',
    data: 'not-declared-as-an-image',
  };

  assert.deepEqual(
    normalizeMcpToolResult({
      content: [
        textContent,
        {
          type: 'image',
          mimeType: 'image/webp',
          data: 'image-base64',
          annotations: { audience: ['assistant'], priority: 0.8 },
          _meta: { source: 'fixture' },
        },
        resourceContent,
        audioContent,
        malformedImageContent,
      ],
      structuredContent: { count: 1 },
    }),
    {
      content: [textContent, resourceContent, audioContent, malformedImageContent],
      structuredContent: { count: 1 },
      inlineDataItems: [{
        mimeType: 'image/webp',
        data: 'image-base64',
        annotations: { audience: ['assistant'], priority: 0.8 },
        _meta: { source: 'fixture' },
      }],
    },
  );
});

test('normalizeMcpToolResult preserves multi-content, non-image content, and metadata shapes', () => {
  const multiContent = {
    content: [
      { type: 'text', text: '{"ok":true}' },
      { type: 'text', text: 'extra text' },
    ],
  };
  assert.strictEqual(normalizeMcpToolResult(multiContent), multiContent);

  const resourceContent = {
    content: [{
      type: 'resource',
      resource: { uri: 'file:///example.txt', mimeType: 'text/plain', text: 'abc123' },
    }],
  };
  assert.strictEqual(normalizeMcpToolResult(resourceContent), resourceContent);

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
