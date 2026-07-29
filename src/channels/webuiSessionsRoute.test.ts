import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { WebUIChannel } from './webuiChannel';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from '../session/metadataStore';
import type { Session } from '../types';
import { formatFoxwarmMessage } from '../utils/promptWrappers';
import fs from 'fs-extra';
import { getAgentDir } from '../config';
import { getSessionHistoryFilePath } from '../session/metadataStore';
import sharp from 'sharp';
import { resolveImageBlobPath } from '../imageBlobs';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeTinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer();
}

function createSseDataReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async read(): Promise<any> {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = block.split('\n').find(line => line.startsWith('data: '));
          if (dataLine) return JSON.parse(dataLine.slice('data: '.length));
          continue;
        }

        const result = await reader.read();
        if (result.done) throw new Error('SSE stream ended before the next data event.');
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

test('WebUI creation routes create agents and random or custom sessions', async () => {
  const agentId = makeSessionId('webui_agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const port = 35500 + Math.floor(Math.random() * 200);
  const token = 'creation-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();

  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const createdSessionIds: string[] = [];

  try {
    let res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    assert.equal(res.status, 401);

    res = await request('/api/agents', { method: 'POST', body: JSON.stringify({ agentId: '../bad' }) });
    assert.equal(res.status, 400);

    res = await request('/api/agents', { method: 'POST', body: JSON.stringify({ agentId, inheritAgent: 'main' }) });
    assert.equal(res.status, 201);
    const agentPayload = await res.json() as any;
    assert.equal(agentPayload.agentId, agentId);
    assert.equal(agentPayload.sessionId, `${agentId}/main`);
    createdSessionIds.push(agentPayload.sessionId);
    assert.equal(sessionManager.getAgentMetadata(agentId).inherit, 'main');

    res = await request('/api/agents', { method: 'POST', body: JSON.stringify({ agentId }) });
    assert.equal(res.status, 409);

    res = await request('/api/agents');
    assert.equal(res.status, 200);
    assert.ok(((await res.json() as any).agents as any[]).some(agent => agent.id === agentId));

    res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId }) });
    assert.equal(res.status, 200);
    const randomPayload = await res.json() as any;
    assert.match(randomPayload.sessionId, new RegExp(`^${agentId}/\\d{4}_[a-z0-9]{5}$`));
    createdSessionIds.push(randomPayload.sessionId);

    res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId, sessionId: 'custom' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).sessionId, `${agentId}/custom`);
    createdSessionIds.push(`${agentId}/custom`);

    res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId, sessionId: 'custom' }) });
    assert.equal(res.status, 409);

    await sessionManager.appendSessionMessage(`${agentId}/custom`, {
      role: 'user',
      parts: [{ text: 'archived custom session' }],
      __meta: { timestamp: Date.now() },
    });
    assert.equal(await sessionManager.deleteSession(`${agentId}/custom`), true);
    createdSessionIds.splice(createdSessionIds.indexOf(`${agentId}/custom`), 1);
    res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId, sessionId: 'custom' }) });
    assert.equal(res.status, 409);
    const archivedPayload = await res.json() as any;
    assert.equal(archivedPayload.code, sessionManager.ARCHIVED_SESSION_ID_ERROR_CODE);
    assert.match(archivedPayload.error, /internal session ID is reserved by retained archive history/);

    res = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId, sessionId: 'other/agent' }) });
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
    setHttpServer(null);
    for (const sessionId of createdSessionIds.reverse()) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
    await sessionManager.setAgentInherit(agentId, undefined).catch(() => {});
    await fs.remove(getAgentDir(agentId));
  }
});

test('WebUI sessions route treats bare wait as idle while preserving busy fields', async () => {
  const sessionId = makeSessionId('webui_runtime_state');
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.busyStartedAt = undefined;
  session.queue = [];
  session.meta = {
    lastMessageTime: Date.now(),
    wait: {
      id: 'webui-bare-wait',
      startedAt: Date.now() - 1000,
    },
  } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 34200 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, 'runtime-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'runtime-token', enableTrigger: false, enableWebUI: true });
  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Authorization: 'Bearer runtime-token' },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as any;
    const listed = payload.sessions.find((item: any) => item.id === sessionId);
    assert.ok(listed);
    assert.equal(listed.busy, false);
    assert.equal(listed.busyStartedAt, null);
    assert.equal(listed.queueLength, 0);
    assert.equal(listed.runtimeState.state, 'idle');
    assert.equal(listed.runtimeState.busy, false);
    assert.equal(listed.runtimeState.waiting, undefined);
  } finally {
    await server.stop();
    setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('WebUI history route returns queued preview messages separately from committed history', async () => {
  const sessionId = makeSessionId('webui_history_queue');
  const imageBuffer = await makeTinyPng();
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [{
    role: 'model',
    parts: [{ text: 'committed answer' }, { inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } }],
    __meta: { timestamp: Date.now(), seq: 1 },
  }];
  session.persistentMemorySnapshot = 'persisted system snapshot';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = true;
  session.busyStartedAt = Date.now();
  session.queue = [
    {
      type: 'user',
      source: {
        platform: 'webui',
        channelId: 'webui',
        channelType: 'webui',
        channelUserId: sessionId,
        conversationId: sessionId,
      },
      parts: [{
        system: formatFoxwarmMessage({ type: 'channel', channelType: 'webui', hint: 'direct user message via channel' }, 'queued channel message'),
      }],
    },
    {
      type: 'intersession',
      sourceSessionId: 'child-session',
      parts: [{
        system: formatFoxwarmMessage({ type: 'inter-agent', sourceSessionId: 'child-session', hint: 'inter-agent message' }, 'queued system message'),
      }],
    },
    {
      type: 'user',
      source: {
        platform: 'webui', channelId: 'webui', channelType: 'webui', channelUserId: sessionId, conversationId: sessionId,
      },
      parts: [{ inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' } }],
    },
    { type: 'compact' },
  ];
  session.meta = { lastMessageTime: Date.now() } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 34750 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, 'history-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'history-token', enableTrigger: false, enableWebUI: true });
  await server.start();
  let blobId: string | undefined;

  try {
    const stateRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/state`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(stateRes.status, 200);
    const statePayload = await stateRes.json() as any;
    assert.deepEqual(Object.keys(statePayload), ['session']);
    assert.equal(statePayload.session.id, sessionId);
    assert.equal(statePayload.session.queueLength, 4);
    assert.equal(statePayload.session.runtimeState.state, 'requesting-model');
    assert.equal('messages' in statePayload, false);
    assert.equal('persistentMemorySnapshot' in statePayload, false);
    assert.equal('queuedMessages' in statePayload, false);

    const missingStateRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(`${sessionId}_missing`)}/state`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(missingStateRes.status, 404);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/history`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as any;

    assert.equal(payload.queueLength, 4);
    assert.equal(payload.session.id, sessionId);
    assert.equal(payload.session.busy, true);
    assert.equal(payload.session.queueLength, 4);
    assert.equal(payload.session.runtimeState.state, 'requesting-model');
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].parts[0].text, 'committed answer');
    assert.equal(payload.messages[0].parts[1].inlineData, undefined);
    assert.equal(payload.messages[0].parts[1].inlineDataRef.path, undefined);
    assert.match(payload.messages[0].parts[1].inlineDataRef.apiPath, /^\/blobs\//);
    blobId = payload.messages[0].parts[1].inlineDataRef.blobId;
    assert.equal(JSON.stringify(payload).includes(imageBuffer.toString('base64')), false);
    assert.equal(payload.persistentMemorySnapshot, 'persisted system snapshot');
    assert.equal(payload.queuedMessages.length, 3);
    assert.equal(payload.queuedPreviewOmittedCount, 1);

    const channelPreview = payload.queuedMessages[0];
    assert.equal(channelPreview.role, 'user');
    assert.equal(channelPreview.__meta.queuedPreview, true);
    assert.equal(channelPreview.__meta.queueType, 'user');
    assert.match(channelPreview.parts[0].system, /<foxwarm-message type="channel"/);
    assert.match(channelPreview.parts[0].system, /queued channel message/);

    const systemPreview = payload.queuedMessages[1];
    assert.equal(systemPreview.role, 'user');
    assert.equal(systemPreview.__meta.queuedPreview, true);
    assert.equal(systemPreview.__meta.queueType, 'intersession');
    assert.match(systemPreview.parts[0].system, /<foxwarm-message type="inter-agent"/);
    assert.match(systemPreview.parts[0].system, /queued system message/);

    assert.match(payload.queuedMessages[2].parts[0].text, /image\/png attachment preview omitted/);
    const persisted = await readSessionHistorySnapshot(sessionId);
    assert.equal(JSON.stringify(persisted).includes(imageBuffer.toString('base64')), false);
    const metadata = await loadSessionsMetadataSnapshot();
    assert.equal(JSON.stringify((metadata.data as any).sessions[sessionId]?.queue || []).includes(imageBuffer.toString('base64')), false);

    const unauthorizedBlob = await fetch(`http://127.0.0.1:${port}/api${payload.messages[0].parts[1].inlineDataRef.apiPath}`);
    assert.equal(unauthorizedBlob.status, 401);
    const authorizedBlob = await fetch(`http://127.0.0.1:${port}/api${payload.messages[0].parts[1].inlineDataRef.apiPath}`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(authorizedBlob.status, 200);
    assert.equal(authorizedBlob.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await authorizedBlob.arrayBuffer()), imageBuffer);

    const debugFixturePath = getSessionHistoryFilePath(sessionId);
    const debugFixture = await fs.readJson(debugFixturePath);
    const nestedSecretBase64 = imageBuffer.toString('base64');
    const legacySecretPath = '/private/legacy/image-secret.png';
    debugFixture.contextFrontier = [{
      kind: 'message',
      marker: 'context-frontier-business-field',
      nestedFunctionResponse: {
        functionResponse: {
          tool_use_id: 'debug_nested_tool',
          response: { inlineData: { data: nestedSecretBase64, mimeType: 'image/png' }, status: 'kept' },
        },
      },
      nestedLegacyRef: {
        inlineDataRef: {
          imageId: 'debug-legacy-ref',
          format: 'png',
          path: legacySecretPath,
          mimeType: 'image/png',
          byteLength: 12,
          sha256: 'debug-secret-hash',
        },
      },
    }];
    await fs.writeJson(debugFixturePath, debugFixture, { spaces: 2 });

    const debugRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/debug-file`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(debugRes.status, 200);
    const debugText = await debugRes.text();
    assert.equal(debugText.includes(nestedSecretBase64), false);
    assert.equal(debugText.includes(legacySecretPath), false);
    assert.doesNotMatch(debugText, /"path"\s*:/);
    const debugPayload = JSON.parse(debugText);
    assert.equal(debugPayload.payload.contextFrontier[0].marker, 'context-frontier-business-field');
    assert.equal(debugPayload.payload.contextFrontier[0].nestedFunctionResponse.functionResponse.response.status, 'kept');
    assert.equal(debugPayload.payload.contextFrontier[0].nestedFunctionResponse.functionResponse.response.inlineDataUnavailable.unavailable, true);
    assert.equal(debugPayload.payload.contextFrontier[0].nestedLegacyRef.inlineDataRef.unavailable, true);
  } finally {
    await server.stop();
    setHttpServer(null);
    session.busy = false;
    await sessionManager.deleteSession(sessionId).catch(() => {});
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});

test('WebUI message route forwards the bounded optimistic client identity to the router', async () => {
  const sessionId = makeSessionId('webui_client_message_id');
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  let routedMessage: any = null;
  const router = {
    handleMessage: async (_ctx: any, message: any) => {
      routedMessage = message;
    },
  };
  const port = 34600 + Math.floor(Math.random() * 400);
  const token = 'client-message-id-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: router as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ text: 'same text' }], clientMessageId: 'webui-send-same-a' }),
    });
    assert.equal(res.status, 200);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(routedMessage?.clientMessageId, 'webui-send-same-a');
    assert.equal(routedMessage?.parts[0].text, 'same text');
  } finally {
    await server.stop();
    setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('WebUI per-session SSE sends initial and live canonical runtime state without a session-list fetch', async () => {
  const sessionId = makeSessionId('webui_session_stream');
  const imageBuffer = await makeTinyPng();
  const alias = `${sessionId}_alias`;
  const session = await sessionManager.getSession(sessionId);
  session.aliases = [alias];
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = {
    lastMessageTime: Date.now(),
    wait: {
      id: 'stream-wait',
      startedAt: Date.now() - 1000,
      timeoutSeconds: 30,
    },
  } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 34900 + Math.floor(Math.random() * 300);
  const token = 'session-stream-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  const channel = new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  sessionManager.setOnSessionStateUpdated((updatedSessionId) => channel.broadcastSessionStateUpdate(updatedSessionId));
  sessionManager.setOnHistoryUpdated((updatedSessionId, message) => channel.broadcastMessage(updatedSessionId, message));
  await server.start();

  let sse: ReturnType<typeof createSseDataReader> | null = null;
  let blobId: string | undefined;
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/sessions/missing-session/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(alias)}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    sse = createSseDataReader(response.body!);

    const connected = await sse.read();
    assert.equal(connected.type, 'connected');

    const initial = await sse.read();
    assert.equal(initial.type, 'session-state');
    assert.equal(initial.session.id, sessionId, 'alias subscriptions must use the canonical session id');
    assert.equal(initial.session.runtimeState.state, 'waiting');
    assert.equal(initial.session.runtimeState.waiting.waitingFor, 'timer');
    assert.equal(initial.session.busy, false);

    await sessionManager.appendSessionMessage(session, {
      role: 'tool',
      parts: [{
        functionResponse: {
          tool_use_id: 'sse_nested_tool',
          name: 'screenshot',
          response: {
            status: 'kept',
            inlineData: { data: imageBuffer.toString('base64'), mimeType: 'image/png' },
          },
        },
      }],
    });
    let imageMessage = await sse.read();
    while (imageMessage.type !== 'message') imageMessage = await sse.read();
    assert.equal(imageMessage.type, 'message');
    assert.equal(imageMessage.message.parts[0].functionResponse.response.status, 'kept');
    assert.equal(imageMessage.message.parts[0].functionResponse.response.inlineData, undefined);
    assert.equal(imageMessage.message.parts[1].toolUseId, 'sse_nested_tool');
    assert.equal(imageMessage.message.parts[1].inlineDataRef.path, undefined);
    assert.match(imageMessage.message.parts[1].inlineDataRef.apiPath, /^\/blobs\//);
    blobId = imageMessage.message.parts[1].inlineDataRef.blobId;
    assert.equal(JSON.stringify(imageMessage).includes(imageBuffer.toString('base64')), false);

    session.busy = true;
    session.busyStartedAt = Date.now();
    session.queue.push({ type: 'retry' });
    sessionManager.setActiveSessionRuntimeState(sessionId, {
      state: 'running-tool',
      tool: {
        id: 'tool-1',
        name: 'exec',
        index: 0,
        total: 1,
        startedAt: Date.now(),
      },
    });

    const active = await sse.read();
    assert.equal(active.type, 'session-state');
    assert.equal(active.session.runtimeState.state, 'running-tool');
    assert.equal(active.session.runtimeState.tool.name, 'exec');
    assert.equal(active.session.runtimeState.queueLength, 1);
    assert.equal(active.session.queueLength, 1);
    assert.equal(active.session.busy, true);

    session.busy = false;
    session.busyStartedAt = undefined;
    session.queue = [];
    sessionManager.clearActiveSessionRuntimeState(sessionId);

    const waitingAgain = await sse.read();
    assert.equal(waitingAgain.type, 'session-state');
    assert.equal(waitingAgain.session.runtimeState.state, 'waiting');
    assert.equal(waitingAgain.session.queueLength, 0);
    assert.equal(waitingAgain.session.busy, false);

    delete session.meta.wait;
    await sessionManager.saveSession(sessionId);

    const idle = await sse.read();
    assert.equal(idle.type, 'session-state');
    assert.equal(idle.session.runtimeState.state, 'idle');
    assert.equal(idle.session.runtimeState.busy, false);
    assert.equal(idle.session.runtimeState.queueLength, 0);
  } finally {
    await sse?.cancel().catch(() => {});
    await server.stop();
    setHttpServer(null);
    sessionManager.setOnSessionStateUpdated(() => {});
    sessionManager.setOnHistoryUpdated(() => {});
    sessionManager.clearActiveSessionRuntimeState(sessionId);
    session.busy = false;
    await sessionManager.deleteSession(sessionId).catch(() => {});
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});

test('WebUI global SSE broadcasts every session creation path used by the sidebar', async () => {
  const parentSessionId = makeSessionId('webui_global_parent');
  const ordinarySessionName = makeSessionId('webui_global_ordinary');
  const createdSessionIds: string[] = [];
  const port = 35200 + Math.floor(Math.random() * 200);
  const token = 'global-session-stream-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  const channel = new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  sessionManager.setOnSessionListUpdated(() => channel.broadcastSessionListUpdate());
  await server.start();

  let sse: ReturnType<typeof createSseDataReader> | null = null;
  const expectListUpdate = async () => {
    const event = await Promise.race([
      sse!.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for sessions-updated.')), 2000)),
    ]);
    assert.equal(event.type, 'sessions-updated');
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    sse = createSseDataReader(response.body!);
    assert.equal((await sse.read()).type, 'connected');

    const parentResult = await sessionManager.createEmptySession(parentSessionId);
    assert.equal(parentResult.created, true);
    createdSessionIds.push(parentSessionId);
    await expectListUpdate();

    const newChildId = await sessionManager.createChildSession(parentSessionId, 'newchild', false);
    createdSessionIds.push(newChildId);
    await expectListUpdate();

    const forkChildId = await sessionManager.createChildSession(parentSessionId, 'forkchild', true);
    createdSessionIds.push(forkChildId);
    await expectListUpdate();

    const manualForkId = await sessionManager.forkSession(parentSessionId, 'manual', false);
    createdSessionIds.push(manualForkId);
    await expectListUpdate();

    const ordinary = await sessionManager.createSessionInAgent({
      agentName: 'main',
      sessionName: ordinarySessionName,
      parentSessionId,
    });
    createdSessionIds.push(ordinary.sessionId);
    await expectListUpdate();

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listResponse.status, 200);
    const listedSessions = (await listResponse.json() as any).sessions as any[];
    const listedById = new Map(listedSessions.map(session => [session.id, session]));
    for (const sessionId of createdSessionIds) {
      assert.ok(listedById.has(sessionId), `expected ${sessionId} in the global list`);
    }
    assert.equal(listedById.get(newChildId).parentSessionId, parentSessionId);
    assert.equal(listedById.get(forkChildId).parentSessionId, parentSessionId);
    assert.equal(listedById.get(manualForkId).parentSessionId, parentSessionId);
    assert.equal(listedById.get(ordinary.sessionId).parentSessionId, parentSessionId);
  } finally {
    await sse?.cancel().catch(() => {});
    await server.stop();
    setHttpServer(null);
    sessionManager.setOnSessionListUpdated(() => {});
    for (const sessionId of createdSessionIds.reverse()) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('WebUI session pin route persists live metadata without writing session history', async () => {
  const sessionId = makeSessionId('webui_pin');
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 35000 + Math.floor(Math.random() * 200);
  const server = new HttpServer(port, 'pin-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'pin-token', enableTrigger: false, enableWebUI: true });
  await server.start();

  const postPin = (pinned: unknown) => fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer pin-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pinned }),
  });

  try {
    let res = await postPin('yes');
    assert.equal(res.status, 400);

    res = await postPin(true);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).pinned, true);

    let metadata = (await loadSessionsMetadataSnapshot()).data as any;
    let history = await readSessionHistorySnapshot(sessionId) as any;
    assert.equal(metadata.sessions[sessionId].pinned, true);
    assert.equal(Object.prototype.hasOwnProperty.call(history, 'pinned'), false);

    res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Authorization: 'Bearer pin-token' },
    });
    assert.equal(res.status, 200);
    let listed = ((await res.json() as any).sessions as any[]).find(item => item.id === sessionId);
    assert.equal(listed.pinned, true);

    res = await postPin(false);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).pinned, false);

    metadata = (await loadSessionsMetadataSnapshot()).data as any;
    history = await readSessionHistorySnapshot(sessionId) as any;
    assert.equal(Object.prototype.hasOwnProperty.call(metadata.sessions[sessionId], 'pinned'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(history, 'pinned'), false);

    res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Authorization: 'Bearer pin-token' },
    });
    listed = ((await res.json() as any).sessions as any[]).find(item => item.id === sessionId);
    assert.equal(listed.pinned, false);
  } finally {
    await server.stop();
    setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('WebUI move route reparents, detaches, reorders, and rejects parent cycles', async () => {
  const rootAId = makeSessionId('webui_move_root_a');
  const rootBId = makeSessionId('webui_move_root_b');
  const childId = makeSessionId('webui_move_child');
  const nestedId = makeSessionId('webui_move_nested');

  for (const [index, sessionId] of [rootAId, rootBId, childId, nestedId].entries()) {
    const session = await sessionManager.getSession(sessionId);
    session.agent = 'main';
    session.history = [];
    session.persistentMemorySnapshot = '';
    session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
    session.busy = false;
    session.queue = [];
    session.meta = { lastMessageTime: Date.now() - index * 1000 } as Session['meta'];
    await sessionManager.saveSession(sessionId);
  }

  const port = 35250 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, 'move-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'move-token', enableTrigger: false, enableWebUI: true });
  await server.start();

  const postMove = async (sessionId: string, body: Record<string, unknown>) => {
    return fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/move`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer move-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  try {
    let res = await postMove(childId, { parentSessionId: rootAId, position: 'first' });
    assert.equal(res.status, 200);
    let payload = await res.json() as any;
    assert.equal(payload.sessionId, childId);
    assert.equal(payload.parentSessionId, rootAId);
    assert.equal(typeof payload.sidebarOrder, 'number');

    let metadata = (await loadSessionsMetadataSnapshot()).data as any;
    let childHistory = await readSessionHistorySnapshot(childId) as any;
    assert.equal(typeof metadata.sessions[childId].sidebarOrder, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(childHistory, 'sidebarOrder'), false);

    res = await postMove(nestedId, { parentSessionId: rootAId, afterSessionId: childId });
    assert.equal(res.status, 200);

    const childAfterAssign = await sessionManager.getSession(childId);
    const nestedAfterAssign = await sessionManager.getSession(nestedId);
    assert.equal(childAfterAssign.parentSessionId, rootAId);
    assert.equal(nestedAfterAssign.parentSessionId, rootAId);
    assert.ok((childAfterAssign.sidebarOrder || 0) < (nestedAfterAssign.sidebarOrder || 0));

    res = await postMove(nestedId, { parentSessionId: rootAId, beforeSessionId: childId });
    assert.equal(res.status, 200);
    const childAfterReorder = await sessionManager.getSession(childId);
    const nestedAfterReorder = await sessionManager.getSession(nestedId);
    assert.ok((nestedAfterReorder.sidebarOrder || 0) < (childAfterReorder.sidebarOrder || 0));
    childHistory = await readSessionHistorySnapshot(childId) as any;
    assert.equal(Object.prototype.hasOwnProperty.call(childHistory, 'sidebarOrder'), false);

    const childOrderBeforeParentOnlyMove = childAfterReorder.sidebarOrder;
    res = await postMove(childId, { parentSessionId: rootBId, updateOrder: false });
    assert.equal(res.status, 200);
    const childAfterParentOnlyMove = await sessionManager.getSession(childId);
    assert.equal(childAfterParentOnlyMove.parentSessionId, rootBId);
    assert.equal(childAfterParentOnlyMove.sidebarOrder, childOrderBeforeParentOnlyMove);

    res = await postMove(childId, { parentSessionId: rootAId, updateOrder: false, position: 'first' });
    assert.equal(res.status, 400);
    payload = await res.json() as any;
    assert.equal(payload.code, 'ORDER_ANCHOR_WITH_UPDATE_ORDER_DISABLED');

    res = await postMove(rootAId, { parentSessionId: nestedId, position: 'first' });
    assert.equal(res.status, 400);
    payload = await res.json() as any;
    assert.equal(payload.code, 'PARENT_CYCLE_NOT_ALLOWED');

    res = await postMove(childId, { parentSessionId: rootAId, position: 'middle' });
    assert.equal(res.status, 400);
    payload = await res.json() as any;
    assert.equal(payload.code, 'INVALID_MOVE_POSITION');

    res = await postMove(childId, { beforeSessionId: nestedId, afterSessionId: rootBId });
    assert.equal(res.status, 400);
    payload = await res.json() as any;
    assert.equal(payload.code, 'MULTIPLE_MOVE_ANCHORS');

    res = await postMove(childId, { parentSessionId: null, beforeSessionId: rootBId });
    assert.equal(res.status, 200);
    const childAfterDetach = await sessionManager.getSession(childId);
    const rootBAfterDetach = await sessionManager.getSession(rootBId);
    assert.equal(childAfterDetach.parentSessionId, undefined);
    assert.ok((childAfterDetach.sidebarOrder || 0) < (rootBAfterDetach.sidebarOrder || 0));

    metadata = (await loadSessionsMetadataSnapshot()).data as any;
    childHistory = await readSessionHistorySnapshot(childId) as any;
    assert.equal(typeof metadata.sessions[childId].sidebarOrder, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(childHistory, 'sidebarOrder'), false);
  } finally {
    await server.stop();
    setHttpServer(null);
    for (const sessionId of [rootAId, rootBId, childId, nestedId]) {
      const session = await sessionManager.getExistingSession(sessionId);
      if (session) session.busy = false;
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});
