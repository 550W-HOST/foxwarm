import './testEnvironment';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';
import { HttpServer } from './httpServer';

async function withServer(fn: (server: HttpServer, baseUrl: string) => Promise<void>) {
  const server = new HttpServer(0, 'secret-token');
  await server.start();
  try {
    const address = server['httpServer'].address();
    assert.ok(address && typeof address !== 'string');
    await fn(server, `http://127.0.0.1:${address.port}`);
  } finally {
    await server.stop();
  }
}

test('noAuth route can be called without bearer/cookie token and still validates payload', async () => {
  await withServer(async (server, baseUrl) => {
    server.addRoute({
      path: '/api/auth',
      method: 'POST',
      noAuth: true,
      handler: async (req, res) => {
        if (req.body?.token === 'secret-token') {
          res.json({ success: true });
        } else {
          res.status(401).json({ error: 'Invalid token' });
        }
      },
    });

    const ok = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true });

    const bad = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    assert.equal(bad.status, 401);
  });
});

test('authenticated routes accept the current cookie and bearer token but reject the removed cookie alias', async () => {
  await withServer(async (server, baseUrl) => {
    server.addRoute({
      path: '/api/protected',
      method: 'GET',
      handler: async (_req, res) => {
        res.json({ success: true });
      },
    });

    const currentCookie = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: 'foxwarm_token=secret-token' },
    });
    assert.equal(currentCookie.status, 200);

    const removedCookieName = ['alpha', 'bot_token'].join('');
    const removedCookie = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: `${removedCookieName}=secret-token` },
    });
    assert.equal(removedCookie.status, 401);

    const bearer = await fetch(`${baseUrl}/api/protected`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(bearer.status, 200);

    const mixed = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: 'foxwarm_token=stale-cookie', Authorization: 'Bearer secret-token' },
    });
    assert.equal(mixed.status, 200);
  });
});

test('webui auth routes allow restricted identities while admin routes reject them', async () => {
  await withServer(async (server, baseUrl) => {
    server.setWebUiIdentityVerifier(async (token: string) => token === 'webui-token'
      ? { role: 'webui', identityId: 'webui-1', sessionIds: ['webui/main'] }
      : null);

    server.addRoute({
      path: '/api/admin-only',
      method: 'GET',
      handler: async (_req, res) => {
        res.json({ ok: true });
      },
    });

    server.addRoute({
      path: '/api/webui',
      method: 'GET',
      auth: 'webui',
      handler: async (req, res) => {
        res.json({ auth: await server.getAuthContext(req) });
      },
    });

    const webUiAllowed = await fetch(`${baseUrl}/api/webui`, {
      headers: { Authorization: 'Bearer webui-token' },
    });
    assert.equal(webUiAllowed.status, 200);
    assert.deepEqual(await webUiAllowed.json(), {
      auth: { role: 'webui', identityId: 'webui-1', sessionIds: ['webui/main'] },
    });

    const webUiDenied = await fetch(`${baseUrl}/api/admin-only`, {
      headers: { Authorization: 'Bearer webui-token' },
    });
    assert.equal(webUiDenied.status, 403);

    const adminAllowed = await fetch(`${baseUrl}/api/admin-only`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(adminAllowed.status, 200);
  });
});

test('authenticated HTTP responses preserve their body through gzip compression', async () => {
  await withServer(async (server, baseUrl) => {
    const body = 'compressed application response\n'.repeat(1000);
    server.addRoute({
      path: '/api/compressed', method: 'GET',
      handler: async (_req, res) => { res.type('text/plain').send(body); },
    });
    const response = await fetch(`${baseUrl}/api/compressed`, {
      headers: { Authorization: 'Bearer secret-token', 'Accept-Encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(await response.text(), body);
  });
});

test('closing a compressed response early releases its gzip stream', { timeout: 5000 }, async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip')!;
  const createGzip = zlib.createGzip;
  let gzip: ReturnType<typeof createGzip> | undefined;
  Object.defineProperty(zlib, 'createGzip', {
    ...descriptor,
    value: (...args: Parameters<typeof createGzip>) => {
      gzip = createGzip(...args);
      return gzip;
    },
  });
  t.after(() => {
    gzip?.destroy();
    Object.defineProperty(zlib, 'createGzip', descriptor);
  });
  await withServer(async (server, baseUrl) => {
    let responseClosed: Promise<void> | undefined;
    server.addRoute({
      path: '/api/compressed', method: 'GET',
      handler: async (_req, res) => {
        responseClosed = new Promise(resolve => res.once('close', resolve));
        res.type('text/plain');
        res.write('unfinished application response\n'.repeat(1000));
        res.flush();
      },
    });
    const request = http.get(`${baseUrl}/api/compressed`, {
      headers: { Authorization: 'Bearer secret-token', 'Accept-Encoding': 'gzip' },
    });
    t.after(() => request.destroy());
    await new Promise<void>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', response => {
        assert.equal(response.headers['content-encoding'], 'gzip');
        response.once('data', () => { response.destroy(); resolve(); });
      });
    });
    assert.ok(gzip, 'the request used a real gzip stream');
    await responseClosed;
    assert.equal(gzip.destroyed, true);
  });
});
