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
  });
});
