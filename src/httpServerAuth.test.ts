import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpServer } from './httpServer';

async function withServer(fn: (server: HttpServer, baseUrl: string) => Promise<void>) {
  const port = 32180 + Math.floor(Math.random() * 1000);
  const server = new HttpServer(port, 'secret-token');
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${port}`);
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

test('webui auth routes allow guest tokens while admin routes reject guests', async () => {
  await withServer(async (server, baseUrl) => {
    server.setGuestTokenVerifier(async (token) => token === 'guest-token'
      ? { role: 'guest', tokenId: 'guest-1', sessionIds: ['guest/main'] }
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

    const guestAllowed = await fetch(`${baseUrl}/api/webui`, {
      headers: { Authorization: 'Bearer guest-token' },
    });
    assert.equal(guestAllowed.status, 200);
    assert.deepEqual(await guestAllowed.json(), {
      auth: { role: 'guest', tokenId: 'guest-1', sessionIds: ['guest/main'] },
    });

    const guestDenied = await fetch(`${baseUrl}/api/admin-only`, {
      headers: { Authorization: 'Bearer guest-token' },
    });
    assert.equal(guestDenied.status, 403);

    const adminAllowed = await fetch(`${baseUrl}/api/admin-only`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(adminAllowed.status, 200);
  });
});
