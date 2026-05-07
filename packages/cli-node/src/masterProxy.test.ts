import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  createMasterWebSocketOptions,
  getMasterProxyInfo,
  sanitizeProxyUrl,
} from './masterProxy';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

function withProxyEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of PROXY_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    run();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('master websocket proxy lookup maps ws/wss to HTTP_PROXY/HTTPS_PROXY', () => {
  withProxyEnv({
    HTTP_PROXY: 'http://http-proxy.example:8080',
    HTTPS_PROXY: 'http://https-proxy.example:8443',
  }, () => {
    assert.equal(getMasterProxyInfo('ws://master.example/node_ws')?.proxyUrl, 'http://http-proxy.example:8080');
    assert.equal(getMasterProxyInfo('wss://master.example/node_ws')?.proxyUrl, 'http://https-proxy.example:8443');
  });
});

test('master websocket proxy lookup honors lowercase env vars and NO_PROXY rules', () => {
  withProxyEnv({
    http_proxy: 'http://proxy.example:8080',
    no_proxy: 'localhost,127.0.0.1,.example.org,internal.example:3001',
  }, () => {
    assert.equal(getMasterProxyInfo('ws://localhost:3001/node_ws'), null);
    assert.equal(getMasterProxyInfo('ws://127.0.0.1:3001/node_ws'), null);
    assert.equal(getMasterProxyInfo('ws://api.example.org/node_ws'), null);
    assert.equal(getMasterProxyInfo('ws://internal.example:3001/node_ws'), null);
    assert.equal(getMasterProxyInfo('ws://internal.example:3002/node_ws')?.proxyUrl, 'http://proxy.example:8080');
  });
});

test('master websocket options select an agent only when a proxy applies', () => {
  withProxyEnv({}, () => {
    assert.deepEqual(createMasterWebSocketOptions('ws://master.example/node_ws'), {});
  });

  withProxyEnv({ HTTP_PROXY: 'http://proxy.example:8080' }, () => {
    const options = createMasterWebSocketOptions('ws://master.example/node_ws');
    assert.ok(options.agent instanceof HttpProxyAgent);
  });

  withProxyEnv({ HTTPS_PROXY: 'http://proxy.example:8443' }, () => {
    const options = createMasterWebSocketOptions('wss://master.example/node_ws');
    assert.ok(options.agent instanceof HttpsProxyAgent);
  });
});

test('proxy URL sanitization redacts credentials before logging', () => {
  assert.equal(
    sanitizeProxyUrl('http://user:secret@example-proxy.local:8080'),
    'http://user:***@example-proxy.local:8080/',
  );
});
