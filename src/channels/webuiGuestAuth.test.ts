import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WebUIChannel } from './webuiChannel';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { createWebUiGuestToken, getWebUiGuestTokensPath, setWebUiGuestTokenStorePathForTests } from '../webuiGuestTokens';
import { MessageRouter } from '../messageRouter';
import type { QueueItem } from '../types';

async function withWebUiServer(run: (baseUrl: string, token: string, calls: { count: number }) => Promise<void>, router?: MessageRouter): Promise<void> {
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
    router: router || {
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

      const guestLogin = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: guestToken }),
      });
      assert.equal(guestLogin.status, 200);
      assert.equal((await guestLogin.json() as any).role, 'guest');

      const guestSessions = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      assert.equal(guestSessions.status, 200);
      const guestPayload = await guestSessions.json() as { sessions: Array<{ id: string }> };
      assert.deepEqual(guestPayload.sessions.map((session: any) => session.id), [boundSessionId]);
      assert.equal((guestPayload.sessions[0] as any).cwd, undefined);

      const adminSessions = await fetch(`${baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminSessions.status, 200);
      const adminPayload = await adminSessions.json() as { sessions: Array<{ id: string }> };
      const adminIds = new Set(adminPayload.sessions.map((session: any) => session.id));
      assert.equal(adminIds.has(boundSessionId), true);
      assert.equal(adminIds.has(unboundSessionId), true);

      const guestRole = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${guestToken}` } });
      assert.equal(guestRole.status, 200);
      assert.equal((await guestRole.json() as any).role, 'guest');
      const guestAdminOnly = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST', headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(guestAdminOnly.status, 403);

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

      for (const route of ['/api/commands', '/api/nodes', '/api/terminals', '/api/setup/status']) {
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
      const uploadPayload = await boundUploadResult.json() as { path: string };
      const forged = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(boundSessionId)}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'attach', uploadedFiles: [{ path: '/tmp/not-my-upload.txt' }] }),
      });
      assert.equal(forged.status, 403);
      assert.equal(calls.count, 0);

      const accepted = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(boundSessionId)}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'attach', uploadedFiles: [{ path: uploadPayload.path, filename: 'hello.txt', mimeType: 'text/plain' }] }),
      });
      assert.equal(accepted.status, 200);
      assert.equal(calls.count, 1);
      assert.equal(await fs.pathExists(uploadPayload.path), false);

      const adminBlob = await fetch(`${baseUrl}/api/blobs/${'0'.repeat(64)}.png`, { headers: { Authorization: `Bearer ${guestToken}` } });
      assert.equal(adminBlob.status, 403);
      const unrelatedBlob = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(boundSessionId)}/blobs/${'0'.repeat(64)}.png`, { headers: { Authorization: `Bearer ${guestToken}` } });
      assert.equal(unrelatedBlob.status, 403);
      const unboundBlob = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(unboundSessionId)}/blobs/${'0'.repeat(64)}.png`, { headers: { Authorization: `Bearer ${guestToken}` } });
      assert.equal(unboundBlob.status, 403);
    });
  } finally {
    await sessionManager.deleteSession(boundSessionId).catch(() => {});
    await sessionManager.deleteSession(unboundSessionId).catch(() => {});
  }
});


test('guest bindings require exact Session IDs at creation and after alias retargeting', async () => {
  await sessionManager.loadSessions();
  const suffix = Math.random().toString(36).slice(2, 9);
  const firstId = `guest_exact_first_${suffix}`;
  const secondId = `guest_exact_second_${suffix}`;
  const alias = `guest_shared_alias_${suffix}`;
  await sessionManager.createEmptySession(firstId);
  await sessionManager.createEmptySession(secondId);
  try {
    const first = sessionManager.getSessionCatalog(firstId)!;
    const second = sessionManager.getSessionCatalog(secondId)!;
    first.aliases = [alias];
    await sessionManager.saveSessionCatalogEntries([firstId]);
    await sessionManager.appendSessionMessage(firstId, { role: 'model', parts: [{ text: 'FIRST-ONLY' }] });
    await sessionManager.appendSessionMessage(secondId, { role: 'model', parts: [{ text: 'SECOND-ONLY' }] });

    await withWebUiServer(async (baseUrl, adminToken, calls) => {
      const request = (route: string, token: string) => fetch(`${baseUrl}${route}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const create = (sessionIds: string[]) => fetch(`${baseUrl}/api/guest-tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds }),
      });
      const aliasIssue = await create([alias]);
      assert.equal(aliasIssue.status, 400, 'an alias is not an exact token binding');
      const { token: guestToken } = await (await create([firstId])).json() as { token: string };
      const legacyAlias = (await createWebUiGuestToken({ sessionIds: [alias] })).token;
      assert.equal((await request(`/api/sessions/${alias}/history`, legacyAlias)).status, 403, 'previously persisted alias binding fails closed');
      const initial = await request(`/api/sessions/${firstId}/history`, guestToken);
      assert.equal(initial.status, 200);
      assert.equal((await initial.json() as any).messages[0].parts[0].text, 'FIRST-ONLY');
      assert.equal((await request(`/api/sessions/${alias}/history`, adminToken)).status, 200);

      first.aliases = [];
      second.aliases = [alias];
      await sessionManager.saveSessionCatalogEntries([firstId, secondId]);
      const reboundAlias = await request(`/api/sessions/${alias}/history`, adminToken);
      assert.equal((await reboundAlias.json() as any).messages[0].parts[0].text, 'SECOND-ONLY', 'administrator aliases retain existing behavior');
      assert.equal((await request(`/api/sessions/${alias}/history`, legacyAlias)).status, 403);

      await sessionManager.deleteSession(firstId);
      second.aliases = [alias, firstId];
      await sessionManager.saveSessionCatalogEntries([secondId]);
      assert.equal((await request(`/api/sessions/${firstId}/history`, adminToken)).status, 200, 'administrator may resolve a moved alias');
      for (const route of [
        `/api/sessions/${firstId}/history`,
        `/api/sessions/${firstId}/stream`,
        `/api/sessions/${firstId}/blobs/${'0'.repeat(64)}.png`,
      ]) {
        const response = await request(route, guestToken);
        assert.equal(response.status, 403, route);
      }
      const message = await fetch(`${baseUrl}/api/sessions/${firstId}/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'must not reach second Session' }),
      });
      assert.equal(message.status, 403);
      assert.equal(calls.count, 0);
      const form = new FormData();
      form.append('file', new Blob(['safe'], { type: 'text/plain' }), 'safe.txt');
      form.append('sessionId', firstId);
      const upload = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${guestToken}` }, body: form,
      });
      assert.equal(upload.status, 403);
      const list = await request('/api/sessions', guestToken);
      assert.deepEqual((await list.json() as any).sessions, [], 'a deleted exact ID does not list an alias target');
      assert.equal((await request(`/api/sessions/${secondId}/history`, guestToken)).status, 403);
    });
  } finally {
    await sessionManager.deleteSession(firstId).catch(() => {});
    await sessionManager.deleteSession(secondId).catch(() => {});
  }
});

test('guest messages cannot dispatch mention-prefixed slash commands through the real router', async () => {
  await sessionManager.loadSessions();
  const sessionId = `guest_command_${Math.random().toString(36).slice(2, 9)}`;
  await sessionManager.createEmptySession(sessionId);
  const commands: string[] = [];
  const queued: QueueItem[] = [];
  const router = new MessageRouter(undefined, async (_sessionId, item) => {
    queued.push(item);
    return { accepted: true, mailboxIntentId: 1, generation: 1, lastAppliedMailboxId: 1,
      messageCount: queued.length, busy: false };
  });
  router.setCommandHandler(async (_ctx, command) => { commands.push(command); return true; });
  try {
    await withWebUiServer(async (baseUrl, adminToken) => {
      const created = await fetch(`${baseUrl}/api/guest-tokens`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      assert.equal(created.status, 200);
      const guestToken = (await created.json() as { token: string }).token;
      const send = (token: string, body: object) => fetch(`${baseUrl}/api/sessions/${sessionId}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      for (const body of [{ text: '/help' }, { text: '@bot /help' }, { parts: [{ text: '@bot /help' }] },
        { parts: [{ text: '@bot' }, { text: ' /help' }] }]) {
        assert.equal((await send(guestToken, body)).status, 403, JSON.stringify(body));
      }
      assert.deepEqual(commands, []);
      assert.equal(queued.length, 0);
      for (const text of ['@bot ordinary words', 'https://example.test/docs/path', 'A paragraph mentions /help inside.']) {
        assert.equal((await send(guestToken, { text })).status, 200, text);
      }
      for (let attempt = 0; queued.length < 3 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(queued.length, 3, 'ordinary guest text reaches the real router queue');
      assert.deepEqual(commands, []);
      assert.equal((await send(adminToken, { text: '@bot /help' })).status, 200, 'administrator command behavior is unchanged');
      for (let attempt = 0; commands.length < 1 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(commands, ['/help']);
    }, router);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
