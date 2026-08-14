import test from 'node:test';
import { sessionCatalogStore } from '../session/catalogStore';

test.before(() => {
  if (!sessionCatalogStore.exists()) sessionCatalogStore.initializeEmpty();
  else sessionCatalogStore.open();
});
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { setWebUiDeleteLifecycleTestHookForTests, WebUIChannel } from './webuiChannel';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot, serializeSessionHistoryPayload } from '../session/metadataStore';
import { markSessionCatalogStub } from '../sessionRuntimeState';
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

test('WebUI list uses catalog queue count for a lightweight stub, then exact hydration wins', async () => {
  const sessionId = makeSessionId('webui_catalog_queue');
  const session = await sessionManager.getSession(sessionId);
  session.queue = [1, 2, 3].map(index => ({ type: 'background', parts: [{ text: `catalog ${index}` }] }));
  await sessionManager.saveSession(sessionId);
  session.queue = [];
  markSessionCatalogStub(session, 3);
  await fs.writeJson(getSessionHistoryFilePath(sessionId), serializeSessionHistoryPayload({
    ...session,
    queue: [{ type: 'background', parts: [{ text: 'authority wins' }] }],
  } as Session));

  const port = 34700 + Math.floor(Math.random() * 400);
  const server = new HttpServer(port, 'queue-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'queue-token', enableTrigger: false, enableWebUI: true });
  await server.start();
  const readListed = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: 'Bearer queue-token' } });
    assert.equal(response.status, 200);
    return ((await response.json() as any).sessions as any[]).find(item => item.id === sessionId);
  };
  try {
    const stub = await readListed();
    assert.equal(stub.queueLength, 3);
    assert.equal(stub.runtimeState.queueLength, 3);
    assert.equal(stub.runtimeState.state, 'idle');
    assert.equal(stub.runtimeState.busy, false);
    await sessionManager.getSession(sessionId);
    const hydrated = await readListed();
    assert.equal(hydrated.queueLength, 1);
    assert.equal(hydrated.runtimeState.queueLength, 1);
    assert.equal(hydrated.runtimeState.state, 'idle');
    assert.equal(hydrated.runtimeState.busy, false);
  } finally {
    await server.stop(); setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('bounded session-list routes preserve tree modes, focus paths, aliases, search, architecture, and descendant preview', async () => {
  const prefix = makeSessionId('webui_bounded'); const agent = `${prefix}_agent`;
  const ids = { root: `${prefix}_root`, child: `${prefix}_child`, child2: `${prefix}_child2`, deep: `${prefix}_deep`,
    pinned: `${prefix}_pinned`, dangling: `${prefix}_dangling`, volatile: `${prefix}_volatile` };
  const cross = { childB: `${prefix}_cross_b`, deepA: `${prefix}_cross_a` };
  const now = Date.now();
  const configure = async (id: string, values: Partial<Session>) => {
    const session = await sessionManager.getSession(id); Object.assign(session, values); session.agent = agent;
    session.meta = { ...session.meta, lastMessageTime: (values.meta as any)?.lastMessageTime || now };
    await sessionManager.saveSession(id);
  };
  await configure(ids.root, { displayName: `${prefix} Search Display`, aliases: [`${prefix}_unique`, `${prefix}_shared`], sidebarOrder: 1, meta: { lastMessageTime: now } });
  await configure(ids.child, { parentSessionId: ids.root, aliases: [`${prefix}_shared`], sidebarOrder: 1, meta: { lastMessageTime: now - 1 } });
  await configure(ids.child2, { parentSessionId: ids.root, sidebarOrder: 2, meta: { lastMessageTime: now - 2 } });
  await configure(ids.deep, { parentSessionId: ids.child, meta: { lastMessageTime: now - 3 } });
  await configure(ids.pinned, { parentSessionId: ids.root, pinned: true, meta: { lastMessageTime: now - 4 } });
  await configure(ids.dangling, { parentSessionId: `${prefix}_missing`, meta: { lastMessageTime: now - 5 } });
  await configure(ids.volatile, { meta: { lastMessageTime: 1 } });
  const volatile = sessionManager.getAllSessions().get(ids.volatile)!; volatile.meta.lastMessageTime = now + 1000; volatile.busy = true;

  const port = 34900 + Math.floor(Math.random() * 300); const token = 'bounded-list-token';
  const server = new HttpServer(port, token); setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true }); await server.start();
  const request = (route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  try {
    let response = await request(`/api/session-list/sidebar?mode=default&limit=100&childLimit=1&focusSessionId=${encodeURIComponent(ids.deep)}`);
    assert.equal(response.status, 200); const sidebar = await response.json() as any;
    assert.equal(sidebar.version, 1); assert.ok(sidebar.sessions.some((item: any) => item.id === ids.root));
    assert.ok(sidebar.sessions.some((item: any) => item.id === ids.pinned), 'pinned child is presentation-elevated');
    assert.ok(sidebar.sessions.some((item: any) => item.id === ids.dangling), 'dangling canonical parent projects as root');
    assert.equal(sidebar.sessions.find((item: any) => item.id === ids.pinned).parentSessionId, ids.root, 'elevation does not mutate real parent');
    assert.equal(sidebar.sessions.find((item: any) => item.id === ids.dangling).parentSessionId, null);
    assert.deepEqual(sidebar.presentationPaths[ids.deep], [ids.root, ids.child, ids.deep]);
    assert.deepEqual(sidebar.forcedChildren[ids.root], [ids.child]);
    assert.ok(sidebar.pathContext.some((item: any) => item.session?.id === ids.root));
    const rootChildren = sidebar.children.find((item: any) => item.parentSessionId === ids.root);
    assert.equal(rootChildren.sessions.length, 1); assert.equal(rootChildren.total, 2); assert.ok(rootChildren.nextCursor);

    response = await request('/api/session-list/sidebar?mode=flat-time&limit=100');
    const flat = await response.json() as any; assert.ok(flat.sessions.some((item: any) => item.id === ids.deep), 'flat mode ignores real parents');
    response = await request('/api/session-list/sidebar?mode=time&limit=2');
    const volatilePage = await response.json() as any; assert.ok(volatilePage.sessions.some((item: any) => item.id === ids.volatile),
      'an unsaved newly-recent active local projection enters the bounded page before sorting');

    response = await request('/api/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'default', limit: 10,
      parents: [{ parentSessionId: ids.root, cursor: rootChildren.nextCursor }] }) });
    assert.equal(response.status, 200); const continued = await response.json() as any;
    assert.deepEqual(continued.children[0].sessions.map((item: any) => item.id), [ids.child2]);

    response = await request('/api/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'default', limit: 10,
      parents: [{ parentSessionId: ids.child }] }) });
    assert.equal(response.status, 200); const nested = await response.json() as any;
    assert.deepEqual(nested.children[0].sessions.map((item: any) => item.id), [ids.deep],
      'the bounded child route supports root -> child -> grandchild expansion');

    response = await request('/api/session-list/by-id', { method: 'POST', body: JSON.stringify({ ids: [`${prefix}_unique`, `${prefix}_shared`], includePaths: true }) });
    const byId = await response.json() as any; assert.equal(byId.results[0].resolution.kind, 'alias');
    assert.equal(byId.results[0].session.id, ids.root); assert.equal(byId.results[1].resolution.kind, 'ambiguous');

    response = await request(`/api/session-list/search?q=${encodeURIComponent('search display')}&limit=10`);
    const search = await response.json() as any; assert.ok(search.sessions.some((item: any) => item.id === ids.root));

    await configure(cross.childB, { parentSessionId: ids.root, meta: { lastMessageTime: now - 10 } });
    const crossB = sessionManager.getAllSessions().get(cross.childB)!; crossB.agent = `${agent}_b`; await sessionManager.saveSessionCatalogEntries([cross.childB]);
    await configure(cross.deepA, { parentSessionId: cross.childB, meta: { lastMessageTime: now - 11 } });

    response = await request(`/api/session-list/architecture?agent=${encodeURIComponent(agent)}&limit=100&childLimit=10`);
    const architecture = await response.json() as any; assert.equal(architecture.version, 1);
    assert.ok(architecture.agentCounts.some((item: any) => item.agent === agent && item.count === 8));
    assert.ok(architecture.roots.sessions.every((item: any) => item.agent === agent));
    assert.ok(architecture.roots.sessions.some((item: any) => item.id === cross.deepA), 'A→B→A descendant becomes an A forest root');
    assert.equal(architecture.roots.sessions.some((item: any) => item.id === ids.pinned), false, 'pinned same-agent child is not a real forest root');
    assert.ok((architecture.children.find((item: any) => item.parentSessionId === ids.root)?.sessions || [])
      .some((item: any) => item.id === ids.pinned), 'Architecture preserves pinned child real relation');
    assert.ok(!(architecture.children.find((item: any) => item.parentSessionId === ids.root)?.sessions || [])
      .some((item: any) => item.id === cross.childB), 'agent child preview excludes other-agent children');
    response = await request('/api/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'time', agent,
      parents: [{ parentSessionId: ids.root }] }) });
    const agentChildren = await response.json() as any;
    assert.ok(agentChildren.children[0].sessions.every((item: any) => item.agent === agent));
    assert.equal(agentChildren.children[0].sessions.some((item: any) => item.id === cross.childB), false);

    response = await request(`/api/session-list/descendants/${encodeURIComponent(ids.root)}?limit=10`);
    const descendants = await response.json() as any; assert.equal(descendants.previewOnly, true); assert.equal(descendants.total, 6);
    const deepBusy = sessionManager.getAllSessions().get(ids.deep)!; deepBusy.busy = true; await sessionManager.saveSessionCatalogEntries([ids.deep]);
    response = await request('/api/session-list/descendant-activity', { method: 'POST', body: JSON.stringify({ ids: [ids.root, `${prefix}_unique`, ids.child, ids.deep] }) });
    const activity = await response.json() as any;
    assert.equal(activity.results.find((item: any) => item.requestedId === `${prefix}_unique`).sessionId, ids.root);
    assert.equal(activity.results.find((item: any) => item.requestedId === `${prefix}_unique`).busy, 1, 'unique aliases resolve before activity projection');
    assert.deepEqual(Object.fromEntries(activity.results.filter((item: any) => item.requestedId !== `${prefix}_unique`).map((item: any) => [item.sessionId, item.busy])), {
      [ids.root]: 1, [ids.child]: 1, [ids.deep]: 0,
    }, 'busy descendant badges use authoritative recursive ancestry and exclude the row itself');
    const childCycle = sessionManager.getAllSessions().get(ids.child)!; childCycle.parentSessionId = ids.deep; deepBusy.parentSessionId = ids.child;
    await sessionManager.saveSessionCatalogEntries([ids.child, ids.deep]);
    response = await request('/api/session-list/descendant-activity', { method: 'POST', body: JSON.stringify({ ids: [ids.child, ids.deep] }) });
    const cycleActivity = await response.json() as any;
    assert.deepEqual(Object.fromEntries(cycleActivity.results.map((item: any) => [item.sessionId, item.busy])), { [ids.child]: 1, [ids.deep]: 0 },
      'A↔B cycles terminate and never count the busy row as its own descendant');
    childCycle.parentSessionId = ids.root; deepBusy.parentSessionId = ids.child; await sessionManager.saveSessionCatalogEntries([ids.child, ids.deep]);
    deepBusy.busy = false;
    response = await request('/api/session-list/descendant-activity', { method: 'POST', body: JSON.stringify({ ids: [ids.root] }) });
    assert.equal(((await response.json()) as any).results[0].busy, 0, 'current exact local idle projection overrides stale catalog busy');
    await sessionManager.saveSessionCatalogEntries([ids.deep]);

    response = await request('/api/session-list/sidebar?mode=time&limit=1'); const timePage = await response.json() as any;
    assert.ok(timePage.nextCursor);
    const root = sessionManager.getAllSessions().get(ids.root)!; root.meta.lastMessageTime = now + 100; await sessionManager.saveSession(ids.root);
    response = await request(`/api/session-list/sidebar?mode=time&limit=1&cursor=${encodeURIComponent(timePage.nextCursor)}`);
    const resetPage = await response.json() as any; assert.equal(resetPage.reset, true, 'catalog mutations reset stateless cursors');
    response = await request(`/api/session-list/sidebar?mode=default&limit=1&cursor=${encodeURIComponent(timePage.nextCursor)}`);
    assert.equal(response.status, 400, 'cursor scope/mode mismatches fail strictly');
    assert.equal((await request('/api/session-list/search?q=x&limit=bad')).status, 400);
    assert.equal((await request('/api/session-list/by-id', { method: 'POST', body: JSON.stringify({ ids: ids.root }) })).status, 400);
    assert.equal((await request('/api/session-list/by-id', { method: 'POST', body: JSON.stringify({ ids: [ids.root], extra: true }) })).status, 400);
    assert.equal((await request('/api/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'time', limit: '10', parents: [] }) })).status, 400);
    assert.equal((await request('/api/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'time', parents: [{ parentSessionId: ids.root, extra: true }] }) })).status, 400);
  } finally {
    await server.stop(); setHttpServer(null);
    volatile.busy = false;
    for (const id of [cross.deepA, cross.childB, ids.deep, ids.child, ids.child2, ids.pinned, ids.dangling, ids.volatile, ids.root]) await sessionManager.deleteSession(id).catch(() => {});
  }
});

test('sidebar focus query keeps comma IDs, repeatable focus values, and a complete 105-deep render path', async () => {
  const prefix = makeSessionId('webui_focus_deep'); const rootId = `${prefix},comma`;
  const ids = [rootId, ...Array.from({ length: 105 }, (_, index) => `${prefix}_d${String(index + 1).padStart(3, '0')}`)];
  const sessions = ids.map((id, index) => ({
    id, agent: `${prefix}_agent`, aliases: [], parentSessionId: index ? ids[index - 1] : undefined,
    history: [], persistentMemorySnapshot: '', systemPromptFiles: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: ids.length - index, messageCount: 0 }, currentNode: 'master',
  } as Session));
  for (const session of sessions) sessionManager.getAllSessions().set(session.id, session);
  sessionCatalogStore.upsertMany(sessions as any[]);
  const port = 40500 + Math.floor(Math.random() * 100); const token = 'deep-focus-token';
  const server = new HttpServer(port, token); setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true }); await server.start();
  try {
    const params = new URLSearchParams({ mode: 'default', limit: '100', childLimit: '5' });
    params.append('focusSessionId', rootId); params.append('focusSessionId', ids.at(-1)!);
    const response = await fetch(`http://127.0.0.1:${port}/api/session-list/sidebar?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); const payload = await response.json() as any;
    assert.deepEqual(payload.presentationPaths[rootId], [rootId], 'comma is literal ID content, not a CSV separator');
    assert.equal(payload.presentationPaths[ids.at(-1)!].length, 106);
    assert.deepEqual(payload.presentationPaths[ids.at(-1)!], ids);
    assert.equal(new Set(payload.pathContext.map((item: any) => item.session?.id).filter(Boolean)).size, 106,
      'all accepted path rows have renderable projections across exact-helper chunks');
    const tooMany = new URLSearchParams({ mode: 'default' });
    for (let index = 0; index < 9; index++) tooMany.append('focusSessionId', ids[index]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/session-list/sidebar?${tooMany}`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
  } finally {
    await server.stop(); setHttpServer(null); sessionCatalogStore.deleteMany(ids);
    for (const id of ids) sessionManager.getAllSessions().delete(id);
  }
});

test('bounded cursor and volatile union share SQLite BINARY UTF-8 tie ordering', async () => {
  const prefix = makeSessionId('webui_binary'); const ids = [`${prefix}_A`, `${prefix}_a`, `${prefix}_\uE000`, `${prefix}_😀`];
  const future = 8_000_000_000_000_000;
  for (const id of ids) {
    const session = await sessionManager.getSession(id); session.pinned = true; session.meta.lastMessageTime = future;
    await sessionManager.saveSession(id);
  }
  const volatile = sessionManager.getAllSessions().get(ids[3])!; volatile.busy = true;
  const port = 40700 + Math.floor(Math.random() * 100); const token = 'binary-token'; const server = new HttpServer(port, token);
  setHttpServer(server); new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true }); await server.start();
  const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    let response = await get('/api/session-list/sidebar?mode=flat-time&limit=2'); const first = await response.json() as any;
    assert.deepEqual(first.sessions.map((item: any) => item.id), ids.slice(0, 2)); assert.ok(first.nextCursor);
    response = await get(`/api/session-list/sidebar?mode=flat-time&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    const second = await response.json() as any; assert.deepEqual(second.sessions.map((item: any) => item.id), ids.slice(2));
    assert.equal(new Set([...first.sessions, ...second.sessions].map((item: any) => item.id)).size, 4, 'no tie skip or duplicate');
  } finally {
    volatile.busy = false; await server.stop(); setHttpServer(null);
    for (const id of ids) await sessionManager.deleteSession(id).catch(() => {});
  }
});

test('restart catalog stubs preserve sanitized timer, waitAll, and exec presentation until hydration', async () => {
  const ids = {
    timer: makeSessionId('webui_wait_timer'),
    waitAll: makeSessionId('webui_wait_all'),
    exec: makeSessionId('webui_wait_exec'),
  };
  const waits: Record<string, any> = {
    [ids.timer]: { id: 'timer-wait', startedAt: 100, reason: 'timer reason', timeoutSeconds: 30 },
    [ids.waitAll]: {
      id: 'all-wait', startedAt: 200,
      waitAll: {
        sessions: ['child-a', 'child-b'], satisfiedSessions: ['child-a'],
        deferredQueue: [{ type: 'background', parts: [{ text: 'private deferred body' }] }],
      },
    },
    [ids.exec]: { id: 'exec-wait', startedAt: 300, waitExecIds: ['exec-a', 'exec-b'] },
  };
  for (const id of Object.values(ids)) {
    const session = await sessionManager.getSession(id);
    session.meta = { lastMessageTime: Date.now(), wait: waits[id] } as Session['meta'];
    await sessionManager.saveSession(id);
  }
  const timer = sessionManager.getAllSessions().get(ids.timer)!;
  await fs.writeJson(getSessionHistoryFilePath(ids.timer), serializeSessionHistoryPayload({
    ...timer,
    meta: { ...timer.meta, wait: { id: 'authority-exec-wait', startedAt: 400, waitExecIds: ['authority-exec'] } },
  } as Session));
  await sessionManager.loadSessions();

  const port = 35100 + Math.floor(Math.random() * 300);
  const server = new HttpServer(port, 'wait-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'wait-token', enableTrigger: false, enableWebUI: true });
  await server.start();
  const list = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: 'Bearer wait-token' } });
    assert.equal(response.status, 200);
    return (await response.json() as any).sessions as any[];
  };
  try {
    const initial = await list();
    const timerStub = initial.find(item => item.id === ids.timer);
    assert.equal(timerStub.runtimeState.state, 'waiting'); assert.equal(timerStub.runtimeState.waiting.waitingFor, 'timer');
    assert.equal(timerStub.runtimeState.waiting.timeoutSeconds, 30);
    const waitAllStub = initial.find(item => item.id === ids.waitAll);
    assert.equal(waitAllStub.runtimeState.waiting.waitingFor, 'sessions');
    assert.deepEqual(waitAllStub.runtimeState.waiting.waitAllSessions, ['child-a', 'child-b']);
    assert.deepEqual(waitAllStub.runtimeState.waiting.satisfiedSessions, ['child-a']);
    const execStub = initial.find(item => item.id === ids.exec);
    assert.equal(execStub.runtimeState.waiting.waitingFor, 'exec');
    assert.deepEqual(execStub.runtimeState.waiting.waitExecIds, ['exec-a', 'exec-b']);

    await sessionManager.getSession(ids.timer);
    const hydrated = (await list()).find(item => item.id === ids.timer);
    assert.equal(hydrated.runtimeState.waiting.waitingFor, 'exec');
    assert.deepEqual(hydrated.runtimeState.waiting.waitExecIds, ['authority-exec']);
  } finally {
    await server.stop(); setHttpServer(null);
    for (const id of Object.values(ids)) await sessionManager.deleteSession(id).catch(() => {});
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
    { type: 'compact-commit' },
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
    debugFixture.obsoleteContextFrontier = [{
      kind: 'legacy-fixture',
      marker: 'obsolete-context-frontier-field',
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
    assert.equal(debugPayload.payload.contextFrontier, undefined, 'obsolete active frontier is not exposed as current debug business state');
    assert.equal(debugPayload.payload.obsoleteContextFrontier[0].marker, 'obsolete-context-frontier-field');
    assert.equal(debugPayload.payload.obsoleteContextFrontier[0].nestedFunctionResponse.functionResponse.response.status, 'kept');
    assert.equal(debugPayload.payload.obsoleteContextFrontier[0].nestedFunctionResponse.functionResponse.response.inlineDataUnavailable.unavailable, true);
    assert.equal(debugPayload.payload.obsoleteContextFrontier[0].nestedLegacyRef.inlineDataRef.unavailable, true);
  } finally {
    await server.stop();
    setHttpServer(null);
    session.busy = false;
    await sessionManager.deleteSession(sessionId).catch(() => {});
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});

test('WebUI session projections and settings routes use the local SessionRuntime DTO seam', async () => {
  const sessionId = makeSessionId('webui_session_runtime_routes');
  const session = await sessionManager.getSession(sessionId);
  session.model = 'legacy/model';
  session.effort = 'low';
  session.childModelDefault = 'legacy/child';
  session.childEffortDefault = 'medium';
  session.cwd = '/tmp/before-runtime-route';
  session.displayName = 'Before Runtime Route';
  await sessionManager.saveSession(sessionId);

  const port = 35000 + Math.floor(Math.random() * 300);
  const token = 'session-runtime-route-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    const modelsPayload = await (await fetch(`http://127.0.0.1:${port}/api/models`, { headers })).json() as any;
    assert.ok(modelsPayload.models.length > 0);
    assert.ok(modelsPayload.models.every((item: any) => Array.isArray(item.allowedEfforts)));
    assert.ok(modelsPayload.models.every((item: any) => Object.prototype.hasOwnProperty.call(item, 'defaultEffort')));

    const cwdRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/cwd`, {
      method: 'POST', headers, body: JSON.stringify({ cwd: '/tmp/after-runtime-route' }),
    });
    assert.equal(cwdRes.status, 200);
    assert.deepEqual(await cwdRes.json(), {
      success: true,
      changed: true,
      previous: '/tmp/before-runtime-route',
      cwd: '/tmp/after-runtime-route',
    });

    const modelRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST', headers, body: JSON.stringify({ clear: true }),
    });
    assert.equal(modelRes.status, 200);
    const modelPayload = await modelRes.json() as any;
    assert.equal(modelPayload.model, null);

    const effortRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST', headers, body: JSON.stringify({ effort: 'none' }),
    });
    assert.equal(effortRes.status, 200);
    assert.equal((await effortRes.json() as any).effort, 'none');

    const childModelRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/child-model`, {
      method: 'POST', headers, body: JSON.stringify({ clear: true }),
    });
    assert.equal(childModelRes.status, 200);
    const childModelPayload = await childModelRes.json() as any;
    assert.equal(childModelPayload.childModelDefault, null);

    const childEffortRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/child-model`, {
      method: 'POST', headers, body: JSON.stringify({ childEffortDefault: 'max' }),
    });
    assert.equal(childEffortRes.status, 200);
    assert.equal((await childEffortRes.json() as any).childEffortDefault, 'max');

    const invalidEffortRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST', headers, body: JSON.stringify({ effort: 'middle' }),
    });
    assert.equal(invalidEffortRes.status, 400);

    const nameRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/name`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'After Runtime Route' }),
    });
    assert.equal(nameRes.status, 200);
    assert.equal((await nameRes.json() as any).displayName, 'After Runtime Route');

    const stateRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/state`, { headers });
    const statePayload = await stateRes.json() as any;
    assert.equal(statePayload.session.cwd, '/tmp/after-runtime-route');
    assert.equal(statePayload.session.model, null);
    assert.equal(statePayload.session.childModelDefault, null);
    assert.equal(statePayload.session.effort, 'none');
    assert.equal(statePayload.session.childEffortDefault, 'max');
    assert.ok(Array.isArray(statePayload.session.effortAllowed));
    assert.equal(statePayload.session.displayName, 'After Runtime Route');

    const listPayload = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers })).json() as any;
    assert.equal(listPayload.sessions.find((item: any) => item.id === sessionId)?.cwd, '/tmp/after-runtime-route');
    const treePayload = await (await fetch(`http://127.0.0.1:${port}/api/agents/tree`, { headers })).json() as any;
    assert.equal(treePayload.agents.find((item: any) => item.id === sessionId)?.displayName, 'After Runtime Route');

    const persisted = await sessionManager.getExistingSession(sessionId);
    assert.equal(persisted?.cwd, '/tmp/after-runtime-route');
    assert.equal(persisted?.model, undefined);
    assert.equal(persisted?.childModelDefault, undefined);
    assert.equal(persisted?.effort, 'none');
    assert.equal(persisted?.childEffortDefault, 'max');
    assert.equal(persisted?.displayName, 'After Runtime Route');
  } finally {
    await server.stop();
    setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
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
    assert.equal(initial.session.messageCount, session.history.length);
    assert.equal(initial.session.historyVersion, session.historyVersion || 0);

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
    session.queue.push({ type: 'compact-commit' });
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
    session.historyVersion = (session.historyVersion || 0) + 1;
    await sessionManager.saveSession(sessionId);

    const idle = await sse.read();
    assert.equal(idle.type, 'session-state');
    assert.equal(idle.session.runtimeState.state, 'idle');
    assert.equal(idle.session.runtimeState.busy, false);
    assert.equal(idle.session.runtimeState.queueLength, 0);
    assert.equal(idle.session.historyVersion, session.historyVersion);
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

test('global SSE sends bounded watched-row deltas plus catalog invalidation without a global list payload', async () => {
  const sessionId = makeSessionId('webui_global_delta'); const port = 40900 + Math.floor(Math.random() * 100);
  const token = 'global-delta-token'; const server = new HttpServer(port, token); setHttpServer(server);
  const channel = new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  const created = await sessionManager.createEmptySession(sessionId); assert.equal(created.created, true); await server.start();
  const alias = `${sessionId}_alias`; sessionManager.getAllSessions().get(sessionId)!.aliases = [alias];
  await sessionManager.saveSessionCatalogEntries([sessionId]);
  let sse: ReturnType<typeof createSseDataReader> | null = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/stream?sessionId=${encodeURIComponent(alias)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const session = sessionManager.getAllSessions().get(sessionId)!; session.busy = true;
    channel.broadcastSessionStateUpdate(sessionId);
    sse = createSseDataReader(response.body!);
    assert.equal((await sse.read()).type, 'connected');
    const initial = await sse.read(); assert.equal(initial.type, 'session-list-delta');
    assert.deepEqual(initial.sessions.map((item: any) => item.id), [sessionId]); assert.equal(initial.sessions[0].history, undefined); assert.equal(initial.sessions[0].busy, false);
    const delta = await sse.read(); assert.equal(delta.type, 'session-list-delta'); assert.equal(delta.sessions[0].busy, true);
    channel.broadcastSessionListUpdate();
    const invalidation = await sse.read(); assert.equal(invalidation.type, 'sessions-updated'); assert.equal(invalidation.catalogInvalidated, true);
    assert.equal(typeof invalidation.eventId, 'number'); assert.equal(typeof invalidation.presentationRevision, 'string');
    await sse.cancel(); sse = null; await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((channel as any).globalSseClients.length, 0, 'disconnect cleanup removes the client before any later bootstrap/keepalive work');
  } finally {
    await sse?.cancel().catch(() => {}); await server.stop(); setHttpServer(null);
    const session = sessionManager.getAllSessions().get(sessionId); if (session) session.busy = false;
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

test('WebUI recursive archive includes deep descendants while unarchive remains single-session', async () => {
  const rootId = makeSessionId('webui_archive_tree_root');
  const childId = makeSessionId('webui_archive_tree_child');
  const grandchildId = makeSessionId('webui_archive_tree_grandchild');
  for (const sessionId of [rootId, childId, grandchildId]) {
    const session = await sessionManager.getSession(sessionId);
    session.agent = 'main';
    session.busy = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);
  }
  await sessionManager.setSessionParent(childId, rootId);
  await sessionManager.setSessionParent(grandchildId, childId);
  await sessionManager.archiveSession(childId, true);

  const port = 35800 + Math.floor(Math.random() * 300);
  const token = 'archive-tree-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();
  const postArchive = (sessionId: string, body: Record<string, unknown>) => fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/archive`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  try {
    let response = await postArchive(rootId, { archived: true });
    assert.equal(response.status, 200);
    let payload = await response.json() as any;
    assert.equal(payload.includeDescendants, false);
    assert.equal(payload.matchedCount, 1);
    assert.equal((await sessionManager.getExistingSession(grandchildId))?.archived, undefined);

    await postArchive(rootId, { archived: false });
    response = await postArchive(rootId, { archived: true, includeDescendants: true });
    assert.equal(response.status, 200);
    payload = await response.json() as any;
    assert.equal(payload.matchedCount, 3);
    assert.deepEqual(new Set(payload.changedSessionIds), new Set([rootId, grandchildId]));
    assert.equal((await sessionManager.getExistingSession(rootId))?.archived, true);
    assert.equal((await sessionManager.getExistingSession(childId))?.archived, true);
    assert.equal((await sessionManager.getExistingSession(grandchildId))?.archived, true);

    response = await postArchive(rootId, { archived: false, includeDescendants: true });
    assert.equal(response.status, 200);
    payload = await response.json() as any;
    assert.equal(payload.includeDescendants, false);
    assert.equal((await sessionManager.getExistingSession(rootId))?.archived, false);
    assert.equal((await sessionManager.getExistingSession(childId))?.archived, true);
    assert.equal((await sessionManager.getExistingSession(grandchildId))?.archived, true);
  } finally {
    await server.stop();
    setHttpServer(null);
    for (const sessionId of [grandchildId, childId, rootId]) {
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('WebUI delete detaches surviving children and recursively preflights before deepest-first deletion', async () => {
  const rootId = makeSessionId('webui_delete_tree_root');
  const childId = makeSessionId('webui_delete_tree_child');
  const grandchildId = makeSessionId('webui_delete_tree_grandchild');
  for (const sessionId of [rootId, childId, grandchildId]) {
    const session = await sessionManager.getSession(sessionId);
    session.agent = 'main';
    session.busy = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);
  }
  await sessionManager.setSessionParent(childId, rootId);
  await sessionManager.setSessionParent(grandchildId, childId);

  const port = 36100 + Math.floor(Math.random() * 300);
  const token = 'delete-tree-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();
  const deleteSession = (sessionId: string, includeDescendants?: boolean) => fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(includeDescendants === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(includeDescendants === undefined ? {} : { body: JSON.stringify({ includeDescendants }) }),
    },
  );

  let replacementRootId: string | undefined;
  const retriggeredSessionIds: string[] = [];
  sessionManager.setSessionTriggerCallback(sessionId => {
    retriggeredSessionIds.push(sessionId);
  });
  try {
    let response = await deleteSession(rootId);
    assert.equal(response.status, 200);
    let payload = await response.json() as any;
    assert.deepEqual(payload.deletedSessionIds, [rootId]);
    assert.deepEqual(payload.detachedChildSessionIds, [childId]);
    assert.equal((await sessionManager.getExistingSession(childId))?.parentSessionId, undefined);
    assert.equal((await sessionManager.getExistingSession(grandchildId))?.parentSessionId, childId);

    replacementRootId = makeSessionId('webui_delete_tree_replacement');
    const replacement = await sessionManager.getSession(replacementRootId);
    replacement.agent = 'main';
    replacement.busy = false;
    replacement.queue = [{ type: 'background', parts: [{ text: 'work retained across a channel-blocked delete' }] }];
    await sessionManager.saveSession(replacementRootId);
    await sessionManager.setSessionParent(childId, replacementRootId);

    sessionManager.attachChannel('telegram', 'delete-tree-blocker', childId);
    response = await deleteSession(replacementRootId, true);
    assert.equal(response.status, 409);
    payload = await response.json() as any;
    assert.equal(payload.code, 'SESSION_DELETE_CHANNEL_BLOCKED');
    assert.deepEqual(payload.blockingSessionIds, [childId]);
    assert.ok(await sessionManager.getExistingSession(replacementRootId));
    assert.ok(await sessionManager.getExistingSession(childId));
    assert.ok(retriggeredSessionIds.includes(replacementRootId));
    sessionManager.detachChannel('telegram', 'delete-tree-blocker');

    const grandchild = await sessionManager.getSession(grandchildId);
    grandchild.busy = true;
    grandchild.queue = [{ type: 'background', parts: [{ text: 'queued work' }] }];
    await sessionManager.saveSession(grandchildId);
    response = await deleteSession(replacementRootId, true);
    assert.equal(response.status, 409);
    payload = await response.json() as any;
    assert.equal(payload.code, 'SESSION_DELETE_BUSY');
    assert.deepEqual(payload.busySessionIds, [grandchildId]);
    assert.ok(await sessionManager.getExistingSession(replacementRootId));
    assert.ok(await sessionManager.getExistingSession(childId));
    assert.equal((await sessionManager.getExistingSession(grandchildId))?.queue.length, 0);

    grandchild.busy = false;
    grandchild.stopping = false;
    await sessionManager.saveSession(grandchildId);
    response = await deleteSession(replacementRootId, true);
    assert.equal(response.status, 200);
    payload = await response.json() as any;
    assert.deepEqual(payload.deletedSessionIds, [grandchildId, childId, replacementRootId]);
    assert.equal(await sessionManager.getExistingSession(replacementRootId), null);
    assert.equal(await sessionManager.getExistingSession(childId), null);
    assert.equal(await sessionManager.getExistingSession(grandchildId), null);
  } finally {
    sessionManager.setSessionTriggerCallback(() => {});
    sessionManager.detachChannel('telegram', 'delete-tree-blocker');
    await server.stop();
    setHttpServer(null);
    for (const sessionId of [grandchildId, childId, rootId, replacementRootId].filter((id): id is string => !!id)) {
      const session = await sessionManager.getExistingSession(sessionId);
      if (session) session.busy = false;
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('WebUI delete claim rejects late channel, relation, child-creation, and work mutations', async () => {
  const rootId = makeSessionId('webui_delete_claim_root');
  const childId = makeSessionId('webui_delete_claim_child');
  const lateSessionId = makeSessionId('webui_delete_claim_late');
  for (const sessionId of [rootId, childId, lateSessionId]) {
    const session = await sessionManager.getSession(sessionId);
    session.agent = 'main';
    session.busy = false;
    session.queue = [];
    await sessionManager.saveSession(sessionId);
  }
  await sessionManager.setSessionParent(childId, rootId);

  const assertClaimError = (error: unknown): boolean => {
    assert.equal((error as any)?.code, 'SESSION_DELETE_IN_PROGRESS');
    return true;
  };
  let hookCalls = 0;
  setWebUiDeleteLifecycleTestHookForTests(async ({ rootSessionId, targetSessionIds }) => {
    hookCalls += 1;
    assert.equal(rootSessionId, rootId);
    assert.deepEqual(targetSessionIds, [rootId, childId]);

    await assert.rejects(() => sessionManager.setSessionParent(lateSessionId, rootId), assertClaimError);
    await assert.rejects(() => sessionManager.createChildSession(rootId, 'claimed-late-child'), assertClaimError);
    await assert.rejects(
      () => sessionManager.moveSessionToTarget({ sourceSessionId: childId, newSessionId: `${childId}_moved` }),
      assertClaimError,
    );
    assert.throws(
      () => sessionManager.attachChannel('telegram', 'late-delete-attach', childId),
      assertClaimError,
    );
    await assert.rejects(
      () => sessionManager.enqueueSessionItem(childId, { type: 'background', parts: [{ text: 'late queued work' }] }),
      assertClaimError,
    );
    await assert.rejects(async () => sessionManager.updateSessionBusyState(await sessionManager.getSession(childId), true), assertClaimError);
    await assert.rejects(() => sessionManager.retrySession(childId), assertClaimError);

    // Simulate an already-in-flight mutation that crossed its commit boundary
    // before claim-aware code could reject it. The route must still revalidate.
    (await sessionManager.getSession(childId)).busy = true;
  });

  const port = 36400 + Math.floor(Math.random() * 200);
  const token = 'delete-claim-token';
  const server = new HttpServer(port, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
  await server.start();

  try {
    let response = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(rootId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeDescendants: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, 'SESSION_DELETE_STATE_CHANGED');
    assert.equal(hookCalls, 1);
    assert.ok(await sessionManager.getExistingSession(rootId));
    assert.ok(await sessionManager.getExistingSession(childId));
    assert.equal((await sessionManager.getExistingSession(lateSessionId))?.parentSessionId, undefined);
    assert.equal(sessionManager.getSessionByChannel('telegram', 'late-delete-attach'), undefined);

    const child = await sessionManager.getSession(childId);
    child.busy = false;
    await sessionManager.saveSession(childId);
    setWebUiDeleteLifecycleTestHookForTests(null);
    response = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(rootId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeDescendants: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(await sessionManager.getExistingSession(rootId), null);
    assert.equal(await sessionManager.getExistingSession(childId), null);
    assert.equal((await sessionManager.getExistingSession(lateSessionId))?.parentSessionId, undefined);
    assert.equal(sessionManager.getSessionByChannel('telegram', 'late-delete-attach'), undefined);
  } finally {
    setWebUiDeleteLifecycleTestHookForTests(null);
    sessionManager.detachChannel('telegram', 'late-delete-attach');
    await server.stop();
    setHttpServer(null);
    for (const sessionId of [childId, rootId, lateSessionId]) {
      const session = await sessionManager.getExistingSession(sessionId);
      if (session) session.busy = false;
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});
