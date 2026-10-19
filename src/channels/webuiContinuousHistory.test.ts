import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Session-scoped continuous pages retain originals through compaction, deletion, fork and alias reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-continuous-history-'));
  process.env.FOXWARM_DATA_DIR = root;
  const manager = await import('../sessionManager');
  const runtime = await import('../sessionRuntime');
  const { WebUIChannel } = await import('./webuiChannel');
  const { HttpServer, setHttpServer } = await import('../httpServer');
  const { normalizeAccessConfig } = await import('../accessConfig');
  const { resolveImageBlobPath } = await import('../imageBlobs');
  const { SessionWorkerStore } = await import('../sessionWorkerStore');
  const { SessionWorkerProjectionRegistry } = await import('../sessionWorkerPublicationService');
  const { buildSessionWorkerProjection } = await import('../sessionWorkerPersistence');
  const { writeAuthoritativeSessionState } = await import('../session/stateFile');
  await manager.loadSessions();
  await runtime.initializeSessionRuntime();
  await manager.createEmptySession('continuous-parent');
  await manager.createEmptySession('continuous-other');
  const parent = (await manager.getExistingSession('continuous-parent'))!;
  await manager.appendSessionMessages(parent, Array.from({ length: 305 }, (_, index) => ({
    role: index % 2 ? 'model' as const : 'user' as const,
    parts: [{ text: `Original ${index + 1}`, ...(index === 1 ? { inlineData: { data: png, mimeType: 'image/png' } } : {}) }],
    __meta: { timestamp: 1700000000000 + index },
  })));
  const childId = await manager.forkSession(parent.id, 'fork');
  await manager.appendSessionMessages(parent, [{ role: 'user', parts: [{ text: 'Parent after fork' }, { inlineData: { data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('post-fork')]).toString('base64'), mimeType: 'image/png' } }] }]);
  const child = (await manager.getExistingSession(childId))!;
  await manager.appendSessionMessages(child, [{ role: 'user', parts: [{ text: 'Child after fork' }] }]);
  parent.history = [{ role: 'model', parts: [{ text: 'Generated CTX summary' }], __meta: {
    contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 300 },
  } } as any, ...parent.history.slice(-6)];
  parent.historyVersion = 1;
  await manager.saveSession(parent);
  const server = new HttpServer(0, 'synthetic-admin');
  setHttpServer(server);
  const channel = new WebUIChannel({ token: 'synthetic-admin', enableTrigger: false, enableWebUI: true, router: {} as any,
    accessConfig: normalizeAccessConfig({ identities: { reader: { token: 'synthetic-reader', surfaces: { webui: { sessions: [parent.id, childId] } } } } }),
  });
  await server.start();
  const port = (server as any).httpServer.address().port;
  const request = (url: string, token = 'synthetic-reader', init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  const route = (id: string, query = '') => `/api/sessions/${encodeURIComponent(id)}/history/continuous${query}`;
  let blobId = '';
  let workerStore: InstanceType<typeof SessionWorkerStore> | undefined;
  try {
    const recent = await (await request(route(parent.id))).json() as any;
    assert.equal(recent.messages.length, 100);
    assert.deepEqual([recent.firstSeq, recent.lastSeq, recent.hasMore], [207, 306, true]);
    assert.equal(JSON.stringify(recent).includes('Generated CTX summary'), false);
    const middle = await (await request(route(parent.id, '?beforeSeq=207'))).json() as any;
    const oldest = await (await request(route(parent.id, '?beforeSeq=107'))).json() as any;
    const first = await (await request(route(parent.id, '?beforeSeq=7'))).json() as any;
    const rows = [...first.messages, ...oldest.messages, ...middle.messages, ...recent.messages];
    assert.deepEqual(rows.map(message => message.__meta.seq), Array.from({ length: 306 }, (_, index) => index + 1));
    assert.equal(first.hasMore, false);
    const active = await (await request(`/api/sessions/${encodeURIComponent(parent.id)}/history`)).json() as any;
    assert.equal(active.messages[0].parts[0].text, 'Generated CTX summary');
    assert.equal((await request(route('continuous-other'))).status, 403);
    assert.equal((await request(route(parent.id, '?beforeSeq=20&afterSeq=10'))).status, 400);
    assert.equal((await request(route(parent.id, '?beforeSeq=invalid'))).status, 400);
    assert.equal((await request(route(parent.id, '?limit=100000'))).status, 400);
    const inherited = await (await request(route(childId))).json() as any;
    assert.equal(inherited.messages.at(-1).parts[0].text, 'Child after fork');
    assert.equal(JSON.stringify(inherited).includes('Parent after fork'), false);
    const image = rows[1].parts[0].inlineDataRef;
    blobId = image.blobId;
    assert.match(image.apiPath, /archiveSeq=2$/);
    const imageUrl = `/api${image.apiPath}`;
    assert.equal((await request(imageUrl)).status, 200);
    assert.equal((await request(imageUrl.replace('archiveSeq=2', 'archiveSeq=1'))).status, 403);
    const inheritedImagePage = await (await request(route(childId, '?beforeSeq=3'))).json() as any;
    const inheritedImageUrl = `/api${inheritedImagePage.messages[1].parts[0].inlineDataRef.apiPath}`;
    assert.equal((await request(inheritedImageUrl)).status, 200, 'an inherited image is proven in the target effective lineage');
    const futureBlob = recent.messages.at(-1).parts[1].inlineDataRef.blobId;
    assert.equal((await request(`/api/sessions/${encodeURIComponent(childId)}/blobs/${futureBlob}?archiveSeq=306`)).status, 403, 'post-fork parent content cannot prove a child reference');
    assert.equal((await request(imageUrl.replace(parent.id, 'continuous-other'), 'synthetic-reader')).status, 403);
    const grant = await request(imageUrl.replace('?archiveSeq=2', '/download'), 'synthetic-reader', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archiveSeq: '2', filename: 'original.png', preview: '0' }),
    });
    assert.equal(grant.status, 200);
    const signed = new URL((await grant.json() as any).url, `http://127.0.0.1:${port}${imageUrl}`);
    assert.equal((await fetch(signed)).status, 200, 'an authorized Archive image can be downloaded without browser credentials');
    await manager.deleteMessages(parent.id, -3);
    assert.equal((await (await request(route(parent.id))).json() as any).lastSeq, 306);
    await manager.clearSession(parent.id);
    assert.equal((await (await request(route(parent.id))).json() as any).lastSeq, 306);
    const moved = await manager.moveSessionToTarget({ sourceSessionId: childId, newSessionId: 'continuous-renamed' });
    const alias = await (await request(route(childId))).json() as any;
    assert.equal(alias.messages.at(-1).parts[0].text, 'Child after fork');
    assert.equal(moved.targetSessionId, 'continuous-renamed');

    // The same route follows the detached Worker authority, not Main's empty stub.
    const worker = { ...parent, history: [{ role: 'user' as const, parts: [{ text: 'Worker-owned active context' }], __meta: { seq: 306 } }] };
    await writeAuthoritativeSessionState(worker);
    workerStore = new SessionWorkerStore(path.join(root, 'worker-runtime.sqlite'));
    workerStore.open();
    const ownership = workerStore.beginGeneration(parent.id, 'continuous-worker');
    workerStore.registerCandidate(parent.id, ownership.generation, 'continuous-worker', process.pid, 'synthetic-worker');
    workerStore.activateCandidate(parent.id, ownership.generation, 'continuous-worker', process.pid, 'synthetic-worker');
    const registry = new SessionWorkerProjectionRegistry();
    const identity = { sessionId: parent.id, generation: ownership.generation, incarnationId: 'continuous-worker' };
    registry.establish(identity);
    await registry.apply(identity, buildSessionWorkerProjection(worker));
    await runtime.shutdownSessionRuntime();
    await runtime.initializeSessionRuntime({ worker: { store: workerStore, registry,
      ingress: { ensureWorkerOwner: async () => identity } as any } });
    const workerActive = await (await request(`/api/sessions/${encodeURIComponent(parent.id)}/history`)).json() as any;
    assert.equal(workerActive.messages[0].parts[0].text, 'Worker-owned active context');
    const workerRaw = await (await request(route(parent.id))).json() as any;
    assert.equal(workerRaw.messages.at(-1).parts[0].text, 'Parent after fork');
    assert.equal(parent.history.length, 0, 'Archive browsing never hydrates the Main stub');
  } finally {
    await channel.stop();
    await server.stop();
    setHttpServer(null);
    await runtime.shutdownSessionRuntime();
    workerStore?.close();
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
    await fs.remove(root);
  }
});
