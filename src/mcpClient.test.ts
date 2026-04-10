import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeServerConfig, summarizeServers } from './mcpClient';

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
