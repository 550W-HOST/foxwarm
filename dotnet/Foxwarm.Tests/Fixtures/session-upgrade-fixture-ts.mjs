import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [root, state = 'inactive'] = process.argv.slice(2);
if (!root || !['inactive', 'candidate'].includes(state)) throw new Error('Expected owned root and inactive|candidate.');
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../../../scripts/test/test-process-env.cjs');
Object.assign(process.env, isolatedApplicationEnv(root));
await fs.mkdir(path.join(root, 'state/sessions'), { recursive: true });
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../../..');
const source = file => import(pathToFileURL(path.join(repository, 'lib', file + '.js')).href);
const { serializeSessionHistoryPayload } = await source('session/metadataStore');
const { performSessionWorkerHandback } = await source('sessionWorkerHandback');
const { SessionWorkerStore } = await source('sessionWorkerStore');
const { SessionCatalogStore } = await source('session/catalogStore');
const store = new SessionWorkerStore(path.join(root, 'state/session-runtime.sqlite'));
const catalog = new SessionCatalogStore(path.join(root, 'state/catalog.sqlite'));
store.open();
catalog.initializeEmpty();
const session = { id: 'retained', agent: 'main',
  history: [{ role: 'user', parts: [{ text: 'Synthetic retained history.' }], __meta: { seq: 1, timestamp: 1000 } }],
  nextMessageSeq: 2, persistentMemorySnapshot: 'Synthetic retained prompt',
  systemPromptFiles: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
  busy: false, queue: [], meta: { lastMessageTime: 1000, messageCount: 1 }, lastAppliedMailboxId: 0 };
const identity = { sessionId: session.id, incarnationId: 'synthetic-incarnation', generation: 1 };
store.beginGeneration(session.id, identity.incarnationId);
store.registerCandidate(session.id, identity.generation, identity.incarnationId, process.pid, 'synthetic-process-identity');
store.activateCandidate(session.id, identity.generation, identity.incarnationId, process.pid, 'synthetic-process-identity');
const applied = store.enqueueIntent(session.id, 'applied-fixture', 'enqueue', { type: 'user', parts: [{ text: 'Synthetic already-applied input.' }] });
const pending = store.enqueueIntent(session.id, 'pending-fixture', 'enqueue', { type: 'user', parts: [{ text: 'Synthetic retained input; do not replay.' }] });
session.lastAppliedMailboxId = applied.id;
const file = path.join(root, 'state/sessions/retained.json');
await fs.writeFile(file, JSON.stringify(serializeSessionHistoryPayload(session)));
const before = await fs.readFile(file, 'utf8');
store.acknowledgeMailboxPrefix({ ...identity, expectedCursor: 0, upToId: applied.id });
store.markDraining(session.id, identity.generation, identity.incarnationId);
const stubs = new Map([[session.id, session]]);
await performSessionWorkerHandback({ store, getCatalogSession: id => stubs.get(id),
  upsertCatalogSession: value => stubs.set(value.id, value),
  saveCatalog: async id => catalog.upsertMany([stubs.get(id)]), stateFilePath: () => file }, identity);
assert.equal(await fs.readFile(file, 'utf8'), before);
assert.equal(store.getOwnership(session.id).mailboxCursor, applied.id);
store.markExitObserved(session.id, identity.generation, identity.incarnationId, 'synthetic handback completed');
if (state === 'candidate') store.beginGeneration(session.id, 'next-synthetic-incarnation');
assert.equal(store.countPendingIntents(session.id), 1);
store.close(); catalog.close();
console.log(JSON.stringify({ cursor: applied.id, pending: pending.id, state }));
