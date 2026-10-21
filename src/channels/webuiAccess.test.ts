import '../testEnvironment';
import { getAgentDir } from '../config';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import http from 'node:http';
import sharp from 'sharp';
import { oversizedVisionImages } from '../testFixtures/visionImages';
import { parseFoxwarmTagLine } from '../utils/promptWrappers';
import { nodesManager } from '../nodes/manager';
import { writeNodeTransferFile } from '../../packages/shared/dist/nodeFileTransfer';
import { externalizeMessageImages, hydrateMessagesForProvider, putImageBlob, resolveImageBlobPath } from '../imageBlobs';
import { image_write_to_file } from '../tools';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { HttpServer, setHttpServer } from '../httpServer';
import { normalizeAccessConfig } from '../accessConfig';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';
import { initializeSessionRuntime, shutdownSessionRuntime } from '../sessionRuntime';

async function withWebUiServer(
  accessConfig: ReturnType<typeof normalizeAccessConfig>,
  run: (baseUrl: string, adminToken: string, webUiToken: string, mcpToken: string, calls: { count: number; messages: any[] }, channel: WebUIChannel) => Promise<void>,
): Promise<void> {
  const port = 34100 + Math.floor(Math.random() * 1000);
  const adminToken = `admin-${Math.random().toString(36).slice(2)}`;
  const webUiToken = 'synthetic-webui-token';
  const mcpToken = 'synthetic-mcp-token';
  const server = new HttpServer(port, adminToken);
  const calls = { count: 0, messages: [] as any[] };
  setHttpServer(server);
  await server.start();
  const channel = new WebUIChannel({
    token: adminToken,
    accessConfig,
    enableTrigger: false,
    router: { handleMessage: async (_ctx: any, message: any) => { calls.count += 1; calls.messages.push(message); } } as any,
  });
  await channel.start();
  try {
    await run(`http://127.0.0.1:${port}`, adminToken, webUiToken, mcpToken, calls, channel);
  } finally {
    await channel.stop().catch(() => {});
    await server.stop().catch(() => {});
    setHttpServer(null);
  }
}

test('unified access config authenticates WebUI identities and keeps MCP-only identities separate', async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const suffix = Math.random().toString(36).slice(2, 9);
  const bound = `access_webui_bound_${suffix}`;
  const unbound = `access_webui_unbound_${suffix}`;
  await sessionManager.createEmptySession(bound);
  await sessionManager.createEmptySession(unbound);
  const accessConfig = normalizeAccessConfig({ identities: {
    webui: { token: 'synthetic-webui-token', surfaces: { webui: { sessions: [bound] } } },
    mcp: { token: 'synthetic-mcp-token', surfaces: { mcp: {} } },
  } });
  try {
    await withWebUiServer(accessConfig, async (baseUrl, adminToken, webUiToken, mcpToken, calls) => {
      const webUiLogin = await fetch(`${baseUrl}/api/auth`, { signal: AbortSignal.timeout(5000),
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: webUiToken }),
      });
      assert.equal(webUiLogin.status, 200);
      assert.deepEqual((await webUiLogin.json() as any), {
        success: true,
        role: 'webui',
        identityId: 'webui',
        sessionIds: [bound],
        features: {
          chat: true, attachments: true, commands: false, terminal: false, workspace: false,
          setup: false, settings: false, sessionManagement: false, debug: false,
          modelSelection: false, sidebar: false,
        },
      });

      const mcpLogin = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mcpToken }),
      });
      assert.equal(mcpLogin.status, 401);

      const listed = await fetch(`${baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${webUiToken}` } });
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json() as any).sessions.map((session: any) => session.id), [bound]);

      const mcpHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/history`, {
        headers: { Authorization: `Bearer ${mcpToken}` },
      });
      assert.equal(mcpHistory.status, 401);

      const deniedHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(unbound)}/history`, {
        headers: { Authorization: `Bearer ${webUiToken}` },
      });
      assert.equal(deniedHistory.status, 403);

      const accepted = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${webUiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from unified webui identity' }),
      });
      assert.equal(accepted.status, 200);
      assert.equal(calls.count, 1);

      for (const [suffix, method] of [['nodes', 'GET'], ['node', 'POST']]) {
        const deniedNodeControl = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/${suffix}`, {
          method, headers: { Authorization: `Bearer ${webUiToken}`, 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ nodeId: 'master' }) } : {}),
        });
        assert.equal(deniedNodeControl.status, 403);
      }

      const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/webui/stream`, {
        headers: { Authorization: `Bearer ${webUiToken}` },
      });
      const frames: any[] = [];
      socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false,
        sessionListIds: [], sessionIds: [bound] }));
      for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.type === 'subscriptions-applied'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(frames.some(frame => frame.type === 'subscriptions-applied'), true);
      assert.equal(frames.some(frame => frame.type === 'session-state' && frame.sessionId === bound), true);
      socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionListActive: false,
        sessionListIds: [], sessionIds: [unbound] }));
      for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.type === 'protocol-error'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(frames.some(frame => frame.type === 'protocol-error'), true);
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, 'close');
        socket.terminate();
        await closed;
      }

      const adminListed = await fetch(`${baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.equal(adminListed.status, 200);
      const adminIds = new Set((await adminListed.json() as any).sessions.map((session: any) => session.id));
      assert.equal(adminIds.has(bound), true);
      assert.equal(adminIds.has(unbound), true);
    });
  } finally {
    await sessionManager.deleteSession(bound).catch(() => {});
    await sessionManager.deleteSession(unbound).catch(() => {});
    await shutdownSessionRuntime().catch(() => {});
  }
});

function socketFrame(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error(`Missing ${type}`)); }, 5000);
    const listener = (raw: any) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(frame);
    };
    socket.on('message', listener);
  });
}

test('authenticated multipart uploads preserve files and clean rejected or interrupted uploads', { timeout: 15_000 }, async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const bound = `upload_bound_${Math.random().toString(36).slice(2, 9)}`;
  await sessionManager.createEmptySession(bound);
  const accessConfig = normalizeAccessConfig({ identities: {
    webui: { token: 'synthetic-webui-token', surfaces: { webui: { sessions: [bound] } } },
  } });
  const uploadDir = path.join(os.tmpdir(), 'foxwarm-uploads');
  await fs.ensureDir(uploadDir);
  const originalFiles = (await fs.readdir(uploadDir)).sort();
  const waitForFiles = async (check: (files: string[]) => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check(await fs.readdir(uploadDir))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Upload files did not settle');
  };
  try {
    await withWebUiServer(accessConfig, async (baseUrl, adminToken, webUiToken) => {
      const upload = (token: string | undefined, sessionId: string, field = 'file') => {
        const form = new FormData();
        form.append(field, new Blob(['attachment contents']), '中文附件.txt');
        return fetch(`${baseUrl}/api/upload?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form,
        });
      };
      assert.equal((await upload(undefined, bound)).status, 401);
      assert.equal((await upload(webUiToken, 'unbound-session')).status, 403);
      assert.equal((await upload(webUiToken, bound, 'unexpected')).status, 400);
      const legacyForm = new FormData();
      legacyForm.append('sessionId', bound);
      legacyForm.append('file', new Blob(['legacy attachment']), 'legacy.txt');
      assert.equal((await fetch(`${baseUrl}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${webUiToken}` }, body: legacyForm,
      })).status, 400);
      const headersOnly = (query: string, contentLength: number) => new Promise<number>((resolve, reject) => {
        const request = http.request(`${baseUrl}/api/upload${query}`, {
          method: 'POST', headers: {
            Authorization: `Bearer ${webUiToken}`,
            'Content-Type': 'multipart/form-data; boundary=upload-test-boundary',
            'Content-Length': contentLength,
          },
        }, response => {
          response.resume();
          response.on('end', () => { resolve(response.statusCode!); request.destroy(); });
        });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('Upload waited for body before rejecting headers')));
        request.flushHeaders();
      });
      assert.equal(await headersOnly('?sessionId=unbound-session', 1024), 403);
      assert.equal(await headersOnly('', 1024), 400);
      assert.equal(await headersOnly('?sessionId=a&sessionId=b', 1024), 400);
      assert.equal(await headersOnly(`?sessionId=${encodeURIComponent(bound)}`, 1024 ** 3 + 1), 413);
      assert.deepEqual((await fs.readdir(uploadDir)).sort(), originalFiles);

      // Administrators keep the Session-less path used by the current Chat.
      const adminForm = new FormData();
      adminForm.append('file', new Blob(['administrator attachment']), 'admin.txt');
      const adminUpload = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: adminForm,
      });
      assert.equal(adminUpload.status, 200);
      const adminFile = await adminUpload.json() as { path: string };
      await fs.remove(adminFile.path);

      // A multipart field cannot override or supply the query's authority.
      const spoofedForm = new FormData();
      spoofedForm.append('sessionId', bound);
      spoofedForm.append('file', new Blob(['attachment']), 'spoofed.txt');
      assert.equal((await fetch(`${baseUrl}/api/upload?sessionId=unbound-session`, {
        method: 'POST', headers: { Authorization: `Bearer ${webUiToken}` }, body: spoofedForm,
      })).status, 403);

      const accepted = await upload(webUiToken, bound);
      assert.equal(accepted.status, 200);
      const file = await accepted.json() as { path: string; filename: string; size: number };
      try {
        assert.equal(file.filename, '中文附件.txt');
        assert.equal(file.size, Buffer.byteLength('attachment contents'));
        assert.equal(await fs.readFile(file.path, 'utf8'), 'attachment contents');
      } finally {
        await fs.remove(file.path);
      }

      const request = http.request(`${baseUrl}/api/upload?sessionId=${encodeURIComponent(bound)}`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${webUiToken}`,
          'Content-Type': 'multipart/form-data; boundary=upload-test-boundary',
        },
      });
      request.on('error', () => {});
      try {
        request.write('--upload-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\n');
        request.write(Buffer.alloc(64 * 1024, 'a'));
        await waitForFiles(files => files.length > originalFiles.length);
      } finally {
        request.destroy();
      }
      await waitForFiles(files => files.length === originalFiles.length);
      assert.deepEqual((await fs.readdir(uploadDir)).sort(), originalFiles);
    });
  } finally {
    await sessionManager.deleteSession(bound).catch(() => {});
    await shutdownSessionRuntime().catch(() => {});
  }
});

async function subscribeSocket(baseUrl: string, token: string, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/webui/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await once(socket, 'open');
  const applied = socketFrame(socket, 'subscriptions-applied');
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1,
    sessionListActive: false, sessionListIds: [], sessionIds: [sessionId] }));
  await applied;
  return socket;
}

test('Agent scopes follow real ownership across creation and moves on HTTP, WS, SSE, and attachments', async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const agent = `scope_agent_${Math.random().toString(36).slice(2, 9)}`;
  const otherAgent = `${agent}_other`;
  const initial = `${agent}/main`;
  const mainLeaf = `${agent}_main_leaf`;
  const movedIn = `${agent}/moved_in`;
  const movedOut = `${otherAgent}/moved_out`;
  const exactToken = 'synthetic-exact-token';
  const mainToken = 'synthetic-main-scope-token';
  const ids = [initial, mainLeaf, movedIn, movedOut, `${otherAgent}/main`];
  const sockets: WebSocket[] = [];
  await sessionManager.createAgentWithMainSession({ agentName: agent });
  await sessionManager.createAgentWithMainSession({ agentName: otherAgent });
  await sessionManager.createEmptySession(mainLeaf);
  await sessionManager.appendSessionMessage(initial, { role: 'user', parts: [{ inlineData: {
    mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  } }] });
  const blobId = (await sessionManager.getExistingSession(initial))!.history[0].parts[0].inlineDataRef!.blobId!;
  const accessConfig = normalizeAccessConfig({ identities: {
    webui: { token: 'synthetic-webui-token', surfaces: { webui: { sessions: [`${agent}/*`] } } },
    exact: { token: exactToken, surfaces: { webui: { sessions: [initial] } } },
    main: { token: mainToken, surfaces: { webui: { sessions: ['main/*'] } } },
  } });
  try {
    await withWebUiServer(accessConfig, async (baseUrl, adminToken, webUiToken, _mcpToken, calls, channel) => {
      const get = (route: string, token = webUiToken) => fetch(`${baseUrl}${route}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      const history = (id: string) => `/api/sessions/${encodeURIComponent(id)}/history`;
      const projected = async (token = webUiToken) => (await (await get('/api/auth/session', token)).json() as any).sessionIds as string[];
      assert.deepEqual(await projected(), [initial]);
      assert.equal((await projected(mainToken)).includes(mainLeaf), true, 'main Agent IDs have no Agent prefix');
      assert.equal((await projected(mainToken)).includes(initial), false);
      assert.equal((await get(history(`${otherAgent}/main`))).status, 403);
      assert.equal((await get(history(mainLeaf))).status, 403);
      const child = await sessionManager.createChildSession(initial, 'child');
      ids.push(child);
      assert.deepEqual(new Set(await projected()), new Set([initial, child]));
      const listed = await (await get('/api/sessions')).json() as any;
      assert.deepEqual(new Set(listed.sessions.map((session: any) => session.id)), new Set([initial, child]));
      await sessionManager.moveSessionToTarget({ sourceSessionId: mainLeaf, newSessionId: 'moved_in', newAgentName: agent });
      assert.equal((await get(history(mainLeaf))).status, 200, 'old alias resolves to current ownership');
      assert.equal((await projected()).includes(movedIn), true);
      assert.equal((await projected(mainToken)).includes(movedIn), false);
      const movedInSocket = await subscribeSocket(baseUrl, webUiToken, mainLeaf);
      sockets.push(movedInSocket);
      const movedInEvent = socketFrame(movedInSocket, 'message');
      channel.broadcastMessage(movedIn, { role: 'model', parts: [{ text: 'new Agent scope includes moved-in Session' }] });
      assert.equal((await movedInEvent).sessionId, movedIn);
      const rejectedLogs = socketFrame(movedInSocket, 'protocol-error');
      movedInSocket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2,
        sessionListActive: false, sessionListIds: [], sessionIds: [movedIn], logs: { id: 'restricted-logs' } }));
      assert.match((await rejectedLogs).message, /not bound/);
      const imageRoute = (id: string) => `/api/sessions/${encodeURIComponent(id)}/blobs/${blobId}`;
      assert.equal((await get(imageRoute(initial))).status, 200);
      const issueImage = (route: string, token = webUiToken) => fetch(`${baseUrl}${route}/download`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'original image.png', preview: '0' }),
      });
      const scopedGrant = await issueImage(imageRoute(initial));
      assert.equal(scopedGrant.status, 200);
      const scopedUrl = new URL((await scopedGrant.json() as any).url, `${baseUrl}${imageRoute(initial)}`);
      const cookieLess = await fetch(scopedUrl);
      assert.equal(cookieLess.status, 200);
      assert.equal(cookieLess.headers.get('content-type'), 'image/png');
      assert.match(cookieLess.headers.get('content-disposition')!, /attachment; filename="original image.png"/);
      assert.ok((await cookieLess.arrayBuffer()).byteLength > 0);
      const head = await fetch(scopedUrl, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
      const globalRoute = `/api/blobs/${blobId}`;
      assert.equal((await issueImage(globalRoute)).status, 403);
      assert.equal((await issueImage(imageRoute(child))).status, 403, 'being bound does not grant unreferenced blobs');
      assert.equal((await issueImage(imageRoute(`${otherAgent}/main`))).status, 403);
      const unauthenticatedIssuer = await fetch(`${baseUrl}${imageRoute(initial)}/download`, { method: 'POST' });
      assert.equal(unauthenticatedIssuer.status, 401);
      // A Session grant cannot become a global, different-Session, different-blob or path grant.
      for (const target of [globalRoute, imageRoute(child), imageRoute(initial).replace(blobId, `${'f'.repeat(64)}.png`), '/download']) {
        const swapped = new URL(target, baseUrl); swapped.search = scopedUrl.search;
        if (target === '/download') swapped.searchParams.set('path', '/not-authorized');
        assert.equal((await fetch(swapped)).status, 401);
      }
      for (const [key, value] of [['filename', 'changed.png'], ['preview', '1'], ['signature', 'wrong']]) {
        const tampered = new URL(scopedUrl); tampered.searchParams.set(key, value);
        assert.equal((await fetch(tampered)).status, 401);
        const validScope = await fetch(tampered, { headers: { Authorization: `Bearer ${webUiToken}` } });
        assert.equal(validScope.status, 200, 'bad grants do not veto valid Session credentials');
        await validScope.arrayBuffer();
      }
      const globalGrant = await issueImage(globalRoute, adminToken);
      assert.equal(globalGrant.status, 200);
      const globalUrl = new URL((await globalGrant.json() as any).url, `${baseUrl}${globalRoute}`);
      const globalDownload = await fetch(globalUrl);
      assert.equal(globalDownload.status, 200); await globalDownload.arrayBuffer();
      const swappedGlobal = new URL(imageRoute(initial), baseUrl); swappedGlobal.search = globalUrl.search;
      assert.equal((await fetch(swappedGlobal)).status, 401);

      const form = new FormData();
      form.append('file', new Blob(['private attachment']), 'attachment.txt');
      const uploaded = await fetch(`${baseUrl}/api/upload?sessionId=${encodeURIComponent(initial)}`, { method: 'POST',
        headers: { Authorization: `Bearer ${webUiToken}` }, body: form });
      assert.equal(uploaded.status, 200);
      const uploadedFile = await uploaded.json() as any;
      const socket = await subscribeSocket(baseUrl, webUiToken, initial);
      sockets.push(socket);
      const exactSocket = await subscribeSocket(baseUrl, exactToken, initial);
      sockets.push(exactSocket);
      const leaked: any[] = [];
      socket.on('message', raw => leaked.push(JSON.parse(raw.toString())));
      const sse = await get(`/api/sessions/${encodeURIComponent(initial)}/stream`);
      assert.equal(sse.status, 200);
      const reader = sse.body!.getReader();
      let initialFrames = '';
      while (!initialFrames.includes('session-state')) initialFrames += new TextDecoder().decode((await reader.read()).value);
      const endedSse = reader.read();
      await sessionManager.moveSessionToTarget({ sourceSessionId: initial, newSessionId: 'moved_out', newAgentName: otherAgent });
      assert.equal((await get(history(initial))).status, 403, 'old Agent alias cannot authorize a moved-out Session');
      assert.equal((await get(history(movedOut))).status, 403);
      assert.equal((await get(imageRoute(initial))).status, 403);
      assert.equal((await get(imageRoute(movedOut))).status, 403);
      assert.equal((await issueImage(imageRoute(initial))).status, 403, 'issuance rechecks moved Session ownership');
      assert.equal((await issueImage(imageRoute(movedOut))).status, 403);
      assert.equal((await issueImage(imageRoute(initial), exactToken)).status, 200, 'exact bindings retain alias-based issuance');
      assert.equal((await get(history(initial), exactToken)).status, 200, 'exact binding follows its alias across Agents');
      assert.deepEqual(await projected(exactToken), [movedOut]);
      assert.equal((await projected()).includes(movedOut), false);
      const refusedAttachment = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(child)}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${webUiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'try attachment from moved Session', uploadedFiles: [uploadedFile] }),
      });
      assert.equal(refusedAttachment.status, 403);
      assert.equal(calls.count, 0);
      const closed = once(socket, 'close');
      const exactClosed = once(exactSocket, 'close');
      channel.broadcastMessage(initial, { role: 'model', parts: [{ text: 'must not leak after move' }] });
      await closed;
      await exactClosed;
      assert.equal(leaked.some(frame => frame.type === 'message'), false);
      assert.equal((await endedSse).done, true);
      const reconnected = await subscribeSocket(baseUrl, exactToken, initial);
      sockets.push(reconnected);
      const delivered = socketFrame(reconnected, 'message');
      channel.broadcastMessage(movedOut, { role: 'model', parts: [{ text: 'exact binding remains accessible' }] });
      assert.equal((await delivered).sessionId, movedOut);
      for (const route of ['/api/models', '/api/agents', '/api/terminals', '/api/session-list/sidebar']) {
        assert.equal((await get(route)).status, 403);
      }
      assert.equal((await get('/api/sessions', adminToken)).status, 200);
      await fs.remove(uploadedFile.path);
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const id of ids) await sessionManager.deleteSession(id).catch(() => {});
    await fs.remove(getAgentDir(agent));
    await fs.remove(getAgentDir(otherAgent));
    await shutdownSessionRuntime().catch(() => {});
  }
});


test('real image uploads keep oversized inputs as readable files for file-only and text-plus-file messages', async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const bound = `vision_upload_${Math.random().toString(36).slice(2, 9)}`;
  await sessionManager.createEmptySession(bound);
  const accessConfig = normalizeAccessConfig({ identities: {
    webui: { token: 'synthetic-webui-token', surfaces: { webui: { sessions: [bound] } } },
  } });
  const { overBytes, overPixels } = await oversizedVisionImages();
  const normal = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
  const savedPaths: string[] = [];
  const originalRead = fs.readFile;
  try {
    await withWebUiServer(accessConfig, async (baseUrl, _admin, token, _mcp, calls) => {
      for (const [name, bytes, oversized] of [
        ['large-source.png', overBytes, true], ['many-pixels.png', overPixels, true], ['ordinary.png', normal, false],
      ] as const) {
        for (const withText of [false, true]) {
          const form = new FormData();
          form.append('file', new Blob([bytes], { type: 'image/png' }), `attachment1_${name}`);
          const uploaded = await fetch(`${baseUrl}/api/upload?sessionId=${encodeURIComponent(bound)}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
          });
          assert.equal(uploaded.status, 200);
          const file = await uploaded.json() as any;
          if (oversized) {
            // Main path saves must not first turn the original upload into a
            // giant Buffer/base64 value just to retain an ordinary file.
            (fs as any).readFile = (target: any, ...args: any[]) => {
              assert.notEqual(target, file.path, 'Oversized upload should use its existing spool path');
              return (originalRead as any)(target, ...args);
            };
          }
          let sent: Response;
          try {
            sent = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/message`, {
              method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: withText ? 'Please inspect the attachment' : '', uploadedFiles: [file] }),
            });
          } finally {
            (fs as any).readFile = originalRead;
          }
          assert.equal(sent.status, 200);
          const message = calls.messages.at(-1);
          const descriptor = message.parts.map((part: any) => part.text).filter(Boolean)
            .map((text: string) => parseFoxwarmTagLine(text)).find((tag: any) => tag?.tagName?.startsWith('foxwarm-'));
          assert.equal(descriptor.tagName, oversized ? 'foxwarm-file' : 'foxwarm-image');
          assert.equal(descriptor.attrs.name, `attachment1_${name}`);
          assert.equal(descriptor.attrs.node, 'master');
          assert.ok(descriptor.attrs.path.startsWith(getAgentDir('main') + path.sep));
          savedPaths.push(descriptor.attrs.path);
          assert.deepEqual(await fs.readFile(descriptor.attrs.path), bytes, 'The retained file is the original image, not a conversion');
          assert.equal(message.parts.filter((part: any) => part.inlineData).length, oversized ? 0 : 1);
          const canonical = (await externalizeMessageImages({ role: 'user', parts: message.parts })).message;
          const prepared = await hydrateMessagesForProvider([canonical]);
          assert.equal(prepared[0].parts.filter(part => part.inlineData).length, oversized ? 0 : 1);
          assert.equal(canonical.parts.some(part => part.inlineData), false, 'Canonical ingress remains reference-only');
          assert.equal(message.parts.some((part: any) => part.text === 'Please inspect the attachment'), withText);
          assert.equal(await fs.pathExists(file.path), false);
        }
      }
    });
  } finally {
    (fs as any).readFile = originalRead;
    for (const filePath of savedPaths) await fs.remove(filePath);
    await sessionManager.deleteSession(bound).catch(() => {});
    await shutdownSessionRuntime().catch(() => {});
  }
});


test('oversized image fallback preserves an existing isolated CLI destination through ordinary file transfer', async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const agent = `vision_isolated_${Math.random().toString(36).slice(2, 9)}`;
  const sessionId = `${agent}/main`;
  const nodeId = 'vision-fixture-node';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-node-files-'));
  await sessionManager.createAgentWithMainSession({ agentName: agent });
  await sessionManager.setAgentIsolation(agent, nodeId);
  nodesManager.registerNode({ readyState: 1, send() {}, close() {} } as any, {} as any, nodeId);
  const { overBytes, overPixels } = await oversizedVisionImages();
  const originalWrite = nodesManager.writeFileToNode;
  let transfers = 0;
  try {
    // Transport is an owned fixture boundary. The destination implementation
    // is the real shared binary file writer used by the resident CLI client.
    nodesManager.writeFileToNode = async (targetNode, filePath, dataBase64, overwrite, owner) => {
      assert.equal(targetNode, nodeId);
      assert.equal(owner, sessionId);
      if (transfers < 4) assert.match(filePath, /^\.temp[\\/]channel-files[\\/]webui[\\/]/);
      else assert.equal(filePath, 'artifacts/original.png');
      transfers += 1;
      return writeNodeTransferFile(path.join(root, filePath), agent, dataBase64, overwrite, false);
    };
    await withWebUiServer(normalizeAccessConfig({ identities: {} }), async (baseUrl, adminToken, _webui, _mcp, calls) => {
      for (const [name, bytes] of [['large.png', overBytes], ['pixels.png', overPixels]] as const) {
        for (const withText of [false, true]) {
          const form = new FormData();
          form.append('file', new Blob([bytes], { type: 'image/png' }), name);
          const upload = await fetch(`${baseUrl}/api/upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form,
          });
          assert.equal(upload.status, 200);
          const file = await upload.json() as any;
          const sent = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/message`, {
            method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: withText ? 'Keep this file' : '', uploadedFiles: [file] }),
          });
          assert.equal(sent.status, 200);
          const message = calls.messages.at(-1);
          const descriptor = message.parts.map((part: any) => parseFoxwarmTagLine(part.text || ''))
            .find((tag: any) => tag?.tagName === 'foxwarm-file');
          assert.equal(descriptor.attrs.name, name);
          assert.equal(descriptor.attrs.node, nodeId);
          assert.ok(descriptor.attrs.path.startsWith(root + path.sep));
          assert.deepEqual(await fs.readFile(descriptor.attrs.path), bytes);
          assert.equal(message.parts.some((part: any) => part.inlineData), false);
          assert.equal(await fs.pathExists(file.path), false);
        }
      }
      assert.equal(transfers, 4);
      const session = await sessionManager.getSession(sessionId);
      const ref = await putImageBlob({ buffer: overPixels, mimeType: 'image/png', imageId: 'retained-large-image' });
      await sessionManager.appendSessionMessage(session, { role: 'tool', parts: [
        { functionResponse: { tool_use_id: 'source-image', name: 'read', response: { output: 'Image read' } } },
        { inlineDataRef: ref, toolUseId: 'source-image' },
      ] });
      const canonical = session.history.at(-1)!;
      const prepared = await hydrateMessagesForProvider([canonical]);
      const projected = JSON.stringify(prepared);
      assert.ok(projected.includes(ref.imageId));
      assert.ok(projected.includes('image_write_to_file'));
      assert.equal(projected.includes(resolveImageBlobPath(ref.blobId!)), false, 'Private Main blob paths are not file locators for an isolated Session');
      assert.equal(transfers, 4, 'Provider preparation does not automatically transfer the original');
      await image_write_to_file({ id: ref.imageId, filePath: 'artifacts/original.png' }, {
        sessionId, session, runtimeNodeId: nodeId, persistCurrentSession: async () => { await sessionManager.saveSession(sessionId); },
      });
      assert.deepEqual(await fs.readFile(path.join(root, 'artifacts/original.png')), overPixels,
        'The actual existing save-by-ID lookup resolves and saves the retained original on the allowed destination');
      assert.equal(transfers, 5);
      assert.equal(canonical.parts[1].inlineDataRef?.blobId, ref.blobId);
      assert.equal(await fs.pathExists(path.join(getAgentDir(agent), '.temp', 'channel-files')), false,
        'An isolated destination is never silently replaced with Main storage');
    });
  } finally {
    nodesManager.writeFileToNode = originalWrite;
    nodesManager.unregisterNode(nodeId);
    await sessionManager.setAgentIsolation(agent, undefined);
    await sessionManager.deleteSession(sessionId).catch(() => {});
    await fs.remove(root);
    await fs.remove(getAgentDir(agent));
    await shutdownSessionRuntime().catch(() => {});
  }
});
