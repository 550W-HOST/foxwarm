import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WebUIChannel } from './webuiChannel';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { getWebUiGuestTokensPath, setWebUiGuestTokenStorePathForTests } from '../webuiGuestTokens';
import { putImageBlob, resolveImageBlobPath } from '../imageBlobs';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { once } from 'node:events';
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


test('guest token follows public Session identity moves through old, intermediate, and current IDs', async () => {
  await sessionManager.loadSessions();
  const suffix = Math.random().toString(36).slice(2, 9);
  const originalId = `guest_move_original_${suffix}`;
  const middleId = `guest_move_middle_${suffix}`;
  const currentId = `guest_move_current_${suffix}`;
  const otherId = `guest_move_other_${suffix}`;
  await sessionManager.createEmptySession(originalId);
  await sessionManager.createEmptySession(otherId);
  const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#114488' } }).png().toBuffer();
  const imageRef = await putImageBlob({ buffer: image, mimeType: 'image/png', imageId: 'guest-move-image' });
  try {
    await sessionManager.appendSessionMessage(originalId, { role: 'model', parts: [{ text: 'ORIGINAL-SESSION' }, { inlineDataRef: imageRef }] });
    await sessionManager.appendSessionMessage(otherId, { role: 'model', parts: [{ text: 'UNBOUND-SESSION' }] });
    await withWebUiServer(async (baseUrl, adminToken, calls) => {
      const get = (route: string, token: string) => fetch(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      const issue = async (id: string) => {
        const response = await fetch(`${baseUrl}/api/guest-tokens`, {
          method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds: [id] }),
        });
        assert.equal(response.status, 200);
        return await response.json() as { token: string; sessionIds: string[] };
      };
      const message = (id: string, token: string, body: object) => fetch(`${baseUrl}/api/sessions/${id}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const upload = (id: string, token: string) => {
        const form = new FormData();
        form.append('file', new Blob(['moved-file'], { type: 'text/plain' }), 'moved.txt');
        form.append('sessionId', id);
        return fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      };
      const assertChat = async (id: string, token: string, canonicalId: string) => {
        const response = await get(`/api/sessions/${id}/history`, token);
        assert.equal(response.status, 200, `history at ${id}`);
        const payload = await response.json() as any;
        assert.equal(payload.session.id, canonicalId);
        assert.equal(payload.messages[0].parts[0].text, 'ORIGINAL-SESSION');
      };
      const assertProjection = async (token: string, canonicalId: string) => {
        const auth = await (await get('/api/auth/session', token)).json() as { sessionIds: string[] };
        assert.deepEqual(auth.sessionIds, [canonicalId]);
        const list = await (await get('/api/sessions', token)).json() as { sessions: Array<{ id: string }> };
        assert.deepEqual(list.sessions.map(session => session.id), [canonicalId]);
      };
      const assertRealtime = async (id: string, token: string, canonicalId: string) => {
        const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/webui/stream`, {
          headers: { Cookie: `foxwarm_token=${token}` },
        });
        const frames: any[] = [];
        socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
        try {
          await once(socket, 'open');
          for (let attempt = 0; attempt < 80 && !frames.some(frame => frame.type === 'connected'); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(frames.some(frame => frame.type === 'connected'), true);
          socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false,
            sessionListIds: [], sessionIds: [id] }));
          for (let attempt = 0; attempt < 80 && !frames.some(frame => frame.type === 'subscriptions-applied'); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(frames.some(frame => frame.type === 'protocol-error'), false);
          assert.equal(frames.some(frame => frame.type === 'session-state' && frame.sessionId === canonicalId
            && frame.session?.id === canonicalId), true, `realtime alias ${id} -> ${canonicalId}: ${JSON.stringify(frames)}`);
        } finally {
          socket.close();
          await once(socket, 'close').catch(() => {});
        }
      };
      const issuedBeforeMove = await issue(originalId);
      const guestToken = issuedBeforeMove.token;
      const pendingUpload = await upload(originalId, guestToken);
      assert.equal(pendingUpload.status, 200);
      const uploadedPath = (await pendingUpload.json() as { path: string }).path;

      const firstMove = await sessionManager.moveSessionToTarget({ sourceSessionId: originalId, newSessionId: middleId });
      assert.equal(firstMove.targetSessionId, middleId);
      for (const id of [originalId, middleId]) await assertChat(id, guestToken, middleId);
      await assertProjection(guestToken, middleId);
      const issuedFromOldAlias = await issue(originalId);
      assert.deepEqual(issuedFromOldAlias.sessionIds, [originalId], 'persisted binding retains the issued alias spelling');
      await assertProjection(issuedFromOldAlias.token, middleId);
      await assertRealtime(originalId, guestToken, middleId);
      await assertRealtime(middleId, guestToken, middleId);
      assert.equal((await message(middleId, guestToken, { text: 'file after move', uploadedFiles: [
        { path: uploadedPath, filename: 'moved.txt', mimeType: 'text/plain' },
      ] })).status, 200, 'upload acquired under old ID can be sent under its new ID');
      assert.equal(await fs.pathExists(uploadedPath), false);
      assert.equal((await message(originalId, issuedFromOldAlias.token, { text: 'chat through old ID' })).status, 200);
      assert.equal(calls.count, 2);
      assert.equal(sessionManager.getSessionByChannel('webui', originalId), middleId,
        'the old conversation routes to the actual moved Session');
      for (const id of [originalId, middleId]) {
        const blob = await get(`/api/sessions/${id}/blobs/${imageRef.blobId}`, guestToken);
        assert.equal(blob.status, 200, `bound image through ${id}`);
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), image);
      }
      const sseAbort = new AbortController();
      const sse = await fetch(`${baseUrl}/api/sessions/${originalId}/stream`, {
        headers: { Authorization: `Bearer ${guestToken}` }, signal: sseAbort.signal,
      });
      assert.equal(sse.status, 200);
      sseAbort.abort();

      const secondMove = await sessionManager.moveSessionToTarget({ sourceSessionId: middleId, newSessionId: currentId });
      assert.equal(secondMove.targetSessionId, currentId);
      assert.equal(sessionManager.getSessionByChannel('webui', originalId), currentId,
        'subsequent identity moves rebind the existing guest conversation');
      const existing = await sessionManager.createEmptySession(originalId);
      assert.equal(existing.created, false, 'the committed old ID cannot start a different Session lifetime');
      assert.equal(existing.session.id, currentId);
      await assert.rejects(sessionManager.moveSessionToTarget({ sourceSessionId: otherId, newSessionId: originalId }),
        'another Session cannot move into the committed old ID');
      for (const id of [originalId, middleId, currentId]) await assertChat(id, guestToken, currentId);
      await assertProjection(guestToken, currentId);
      await assertProjection(issuedFromOldAlias.token, currentId);
      await assertRealtime(originalId, issuedFromOldAlias.token, currentId);
      await assertRealtime(middleId, guestToken, currentId);
      assert.equal((await message(currentId, guestToken, { text: 'chat through current ID' })).status, 200);
      assert.equal(calls.count, 3);
      assert.equal((await get(`/api/sessions/${otherId}/history`, guestToken)).status, 403);
      assert.equal((await upload(otherId, guestToken)).status, 403);
      assert.equal((await message(otherId, guestToken, { text: 'unbound' })).status, 403);
      assert.equal(calls.count, 3);
      await sessionManager.deleteSession(currentId);
      assert.equal((await get(`/api/sessions/${originalId}/history`, guestToken)).status, 403);
      const afterDelete = await (await get('/api/auth/session', guestToken)).json() as { sessionIds: string[] };
      assert.deepEqual(afterDelete.sessionIds, []);
      const afterDeleteList = await (await get('/api/sessions', guestToken)).json() as { sessions: unknown[] };
      assert.deepEqual(afterDeleteList.sessions, []);
    });
  } finally {
    for (const id of [originalId, middleId, currentId, otherId]) await sessionManager.deleteSession(id).catch(() => {});
    if (imageRef.blobId) await fs.remove(resolveImageBlobPath(imageRef.blobId));
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
