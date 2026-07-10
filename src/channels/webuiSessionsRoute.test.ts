import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { WebUIChannel } from './webuiChannel';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from '../session/metadataStore';
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
