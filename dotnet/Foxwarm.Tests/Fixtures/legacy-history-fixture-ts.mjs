import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Expected an owned fixture root.');
// Every application import, including the normal Source hydration/save path,
// runs with disposable configuration and persistence paths.
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../../../scripts/test/test-process-env.cjs');
Object.assign(process.env, isolatedApplicationEnv(root));
process.env.FOXWARM_VECTOR_ENABLED = 'false';
await fs.mkdir(path.join(root, 'state/sessions'), { recursive: true });
await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\n');
await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a/wire\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: synthetic-not-a-key\n    models: [wire]\n');
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../../..');
const load = file => import(pathToFileURL(path.join(repository, 'lib', file + '.js')).href);
const { serializeSessionHistoryPayload } = await load('session/metadataStore');
const { SessionCatalogStore } = await load('session/catalogStore');
const archive = await load('session/archiveStore');
const text = (content, meta) => ({ role: 'user', parts: [{ text: content }], ...(meta === undefined ? {} : { __meta: meta }) });
const call = (id, meta) => ({ role: 'model', parts: [{ functionCall: { id, name: 'read', args: { filePath: 'synthetic.txt' } } }], __meta: meta });
const response = (id, content, meta) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'read', response: { output: content } } }], ...(meta === undefined ? {} : { __meta: meta }) });
const history = [
  { ...text('Legacy opening Ω'), retainedField: { source: 'synthetic historical producer' } },
  call('legacy-tool', { timestamp: 1000.25, modelId: 'a/wire', sourceSessionId: 'historical-origin', retained: ['provenance'] }),
  response('legacy-tool', 'Legacy tool result without metadata'),
  text('Legacy empty metadata', {}),
  text('Recorded sequence without recorded time', { seq: 7 }),
  call('mixed-tool', { seq: 10, timestamp: 10000 }),
  response('mixed-tool', 'Unsequenced large response ' + 'u'.repeat(5000), { timestamp: 10001 }),
  { role: 'model', parts: [{ text: 'Retained unsequenced diagnostic' }], modelVisible: false },
  { role: 'user', parts: [{ system: '<foxwarm-system kind="session-boundary" event="compact-completed" />' }] },
  text('Explicit missing optional identity', { seq: null, timestamp: null }),
  call('numbered-tool', { seq: 20, timestamp: 20000 }),
  response('numbered-tool', 'Archived large response ' + 'r'.repeat(5000), { seq: 21, timestamp: 21000 }),
  ...Array.from({ length: 19 }, (_, index) => text('Numbered work ' + (index + 22) + ' ' + 'x'.repeat(1600), { seq: index + 22, timestamp: (index + 22) * 1000 })),
];
const session = { id: 'legacy', agent: 'main', parentSessionId: null, history,
  persistentMemorySnapshot: 'Synthetic retained prompt', promptCacheKey: 'synthetic-cache', systemPromptFiles: [],
  stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
  busy: false, queue: [], meta: { lastMessageTime: 40000, messageCount: history.length } };
const parent = { ...session, id: 'parent', history: [], meta: { lastMessageTime: 0, messageCount: 0 } };
const catalog = new SessionCatalogStore(path.join(root, 'state/catalog.sqlite'));
catalog.initializeEmpty();
catalog.upsertMany([parent, { ...session, parentSessionId: 'parent' }]);
catalog.close();
const authority = JSON.stringify(serializeSessionHistoryPayload(session));
const file = path.join(root, 'state/sessions/legacy.json');
await fs.writeFile(file, authority);
await fs.writeFile(path.join(root, 'state/sessions/parent.json'), JSON.stringify(serializeSessionHistoryPayload(parent)));
await archive.initArchiveStore();
await archive.ensureSessionBranch(session.id);
// Stored row identity is historical evidence independent of missing payload metadata.
// Its existence must not be used to assign a sequence to the active opening row.
const records = [ { seq: 1, timestamp: 500, message: history[0] },
  ...history.filter(message => Number.isSafeInteger(message.__meta?.seq) && message.__meta.seq > 0)
    .map(message => ({ seq: message.__meta.seq, timestamp: message.__meta.timestamp ?? 7000, message }))
].map(record => ({ v: 1, kind: 'message', sessionId: session.id, agent: 'main', role: record.message.role, ...record }));
await archive.writeArchiveMessages(records);
const sm = await load('sessionManager');
await sm.loadSessions();
const hydrated = await sm.getSession(session.id);
assert.deepEqual(hydrated.history, history);
assert.equal(hydrated.nextMessageSeq, 41);
assert.equal(hydrated.parentSessionId, 'parent');
await sm.saveSessionForSessionCritical(hydrated);
const saved = JSON.parse(await fs.readFile(file, 'utf8'));
assert.deepEqual(saved.history, history);
assert.equal(saved.nextMessageSeq, 41);
assert.deepEqual((await archive.readLocalArchiveMessages(session.id)).map(record => record.message), records.map(record => record.message));
// Return the original Source-serialized historical fixture, so C# independently
// exercises null-parent overlay and missing-next inference rather than Source's saved defaults.
await fs.writeFile(file, authority);
console.log('LEGACY_HISTORY_FIXTURE:' + JSON.stringify({ history, next: 41, sourceSaved: true }));
process.exit(0);
