import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { WebUIChannel } from './webuiChannel';
import type { Session } from '../types';
import { formatFoxwarmMessage } from '../utils/promptWrappers';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [{
    role: 'model',
    parts: [{ text: 'committed answer' }],
    __meta: { timestamp: Date.now(), seq: 1 },
  }];
  session.persistentMemorySnapshot = '';
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
    { type: 'compact' },
  ];
  session.meta = { lastMessageTime: Date.now() } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 34750 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, 'history-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'history-token', enableTrigger: false, enableWebUI: true });
  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/history`, {
      headers: { Authorization: 'Bearer history-token' },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as any;

    assert.equal(payload.queueLength, 3);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].parts[0].text, 'committed answer');
    assert.equal(payload.queuedMessages.length, 2);
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
  } finally {
    await server.stop();
    setHttpServer(null);
    session.busy = false;
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
