import { getAgentDir } from '../config';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { HttpServer, setHttpServer } from '../httpServer';
import { normalizeAccessConfig } from '../accessConfig';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';
import { initializeSessionRuntime, shutdownSessionRuntime } from '../sessionRuntime';

async function withWebUiServer(
  accessConfig: ReturnType<typeof normalizeAccessConfig>,
  run: (baseUrl: string, adminToken: string, webUiToken: string, mcpToken: string, calls: { count: number }, channel: WebUIChannel) => Promise<void>,
): Promise<void> {
  const port = 34100 + Math.floor(Math.random() * 1000);
  const adminToken = `admin-${Math.random().toString(36).slice(2)}`;
  const webUiToken = 'synthetic-webui-token';
  const mcpToken = 'synthetic-mcp-token';
  const server = new HttpServer(port, adminToken);
  const calls = { count: 0 };
  setHttpServer(server);
  await server.start();
  const channel = new WebUIChannel({
    token: adminToken,
    accessConfig,
    enableTrigger: false,
    router: { handleMessage: async () => { calls.count += 1; } } as any,
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
      const form = new FormData();
      form.append('sessionId', initial);
      form.append('file', new Blob(['private attachment']), 'attachment.txt');
      const uploaded = await fetch(`${baseUrl}/api/upload`, { method: 'POST',
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
