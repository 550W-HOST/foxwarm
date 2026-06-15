import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WebUIChannel } from './webuiChannel';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { getWebUiGuestTokensPath, setWebUiGuestTokenStorePathForTests } from '../webuiGuestTokens';

async function withWebUiServer(run: (baseUrl: string, token: string, calls: { count: number }) => Promise<void>): Promise<void> {
  const port = 34100 + Math.floor(Math.random() * 1000);
  const adminToken = `admin-${Math.random().toString(36).slice(2)}`;
  const server = new HttpServer(port, adminToken);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-route-'));
  const guestStorePath = getWebUiGuestTokensPath(tempDir);
  const calls = { count: 0 };
  setHttpServer(server);
  setWebUiGuestTokenStorePathForTests(guestStorePath);
  await server.start();
  const channel = new WebUIChannel({
    token: adminToken,
    enableTrigger: false,
    router: {
      handleMessage: async () => {
        calls.count += 1;
      },
    } as any,
  });
  await channel.start();
  try {
    await run(`http://127.0.0.1:${port}`, adminToken, calls);
  } finally {
    await channel.stop().catch(() => {});
    await server.stop().catch(() => {});
    setHttpServer(null);
    setWebUiGuestTokenStorePathForTests(undefined);
    await fs.remove(tempDir).catch(() => {});
  }
}

test('webui guest token filters sessions and denies admin-only APIs', async () => {
  await sessionManager.loadSessions();
  const boundSessionId = `guest_route_bound_${Math.random().toString(36).slice(2, 8)}`;
  const unboundSessionId = `guest_route_unbound_${Math.random().toString(36).slice(2, 8)}`;
  await sessionManager.createEmptySession(boundSessionId);
  await sessionManager.createEmptySession(unboundSessionId);

  try {
    await withWebUiServer(async (baseUrl, adminToken, calls) => {
      const missingTokenCreate = await fetch(`${baseUrl}/api/guest-tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [`missing_${Date.now()}`] }),
      });
      assert.equal(missingTokenCreate.status, 400);

      const tokenCreate = await fetch(`${baseUrl}/api/guest-tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [boundSessionId], label: 'route test' }),
      });
      assert.equal(tokenCreate.status, 200);
      const tokenPayload = await tokenCreate.json() as { token: string; tokenId: string; sessionIds: string[]; label: string };
      assert.match(tokenPayload.token, /^fwg_[a-f0-9]+_[A-Za-z0-9_-]+$/);
      assert.deepEqual(tokenPayload.sessionIds, [boundSessionId]);
      assert.equal(tokenPayload.label, 'route test');
      const guestToken = tokenPayload.token;

      const guestSessions = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      assert.equal(guestSessions.status, 200);
      const guestPayload = await guestSessions.json() as { sessions: Array<{ id: string }> };
      assert.deepEqual(guestPayload.sessions.map((session: any) => session.id), [boundSessionId]);

      const adminSessions = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminSessions.status, 200);
      const adminPayload = await adminSessions.json() as { sessions: Array<{ id: string }> };
      const adminIds = new Set(adminPayload.sessions.map((session: any) => session.id));
      assert.equal(adminIds.has(boundSessionId), true);
      assert.equal(adminIds.has(unboundSessionId), true);

      const unboundHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(unboundSessionId)}/history`, {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      assert.equal(unboundHistory.status, 403);

      const slashMessage = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(boundSessionId)}/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/help' }),
      });
      assert.equal(slashMessage.status, 403);
      assert.equal(calls.count, 0);

      for (const route of ['/api/commands', '/api/fs/tree?path=%2F', '/api/terminals', '/api/setup/status']) {
        const denied = await fetch(`${baseUrl}${route}`, {
          headers: { Authorization: `Bearer ${guestToken}` },
        });
        assert.equal(denied.status, 403, route);
      }

      const guestTokenCreate = await fetch(`${baseUrl}/api/guest-tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [boundSessionId] }),
      });
      assert.equal(guestTokenCreate.status, 403);

      const unboundUpload = new FormData();
      unboundUpload.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
      unboundUpload.append('sessionId', unboundSessionId);
      const unboundUploadResult = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}` },
        body: unboundUpload,
      });
      assert.equal(unboundUploadResult.status, 403);

      const boundUpload = new FormData();
      boundUpload.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
      boundUpload.append('sessionId', boundSessionId);
      const boundUploadResult = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}` },
        body: boundUpload,
      });
      assert.equal(boundUploadResult.status, 200);
      const uploadPayload = await boundUploadResult.json() as { filePath: string };
      await fs.remove(uploadPayload.filePath).catch(() => {});
    });
  } finally {
    await sessionManager.deleteSession(boundSessionId).catch(() => {});
    await sessionManager.deleteSession(unboundSessionId).catch(() => {});
  }
});
