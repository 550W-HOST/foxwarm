// Supported independent HTTP deletions over actual channel authority and retained retry identities.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, unlink, rename, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const fixture = await createHostFixture('deletion-concurrency'), state = join(fixture.data, 'state'), faults = join(state, 'experiment-faults')
const bindingsFile = join(state, 'channels.json'), results = [], problems = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const marker = (id, stage) => join(faults, 'id_' + Buffer.from(id).toString('base64url') + '.' + stage)
const exists = path => access(path).then(() => true, () => false)
await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'], contextLimit: 20000 } } })
await mkdir(faults, { recursive: true }); await mkdir(join(state, 'sessions'), { recursive: true })
await writeFile(join(state, 'sessions/alias-target.json'), JSON.stringify({ sessionStateVersion: 1, id: 'alias-target', agent: 'main', model: 'a', busy: false, stopping: false,
  history: [], queue: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: 100, messageCount: 0 }, historyVersion: 0,
  lastAppliedMailboxId: 0, nextMessageSeq: 1, nextBlockId: 1, persistentMemorySnapshot: 'Existing selected snapshot', promptCacheKey: '00000000-0000-0000-0000-000000000001' }))
const catalogModule = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
const catalog = new catalogModule.SessionCatalogStore(join(state, 'catalog.sqlite')); catalog.initializeEmpty()
catalog.replaceAll([{ id: 'alias-target', agent: 'main', aliases: ['nick'], busy: false, queueLength: 0, meta: { lastMessageTime: 100, messageCount: 0 } }]); catalog.close()
async function create(id) { const response = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id }); assert.equal(response.status, 200, JSON.stringify(response)) }
try {
  await fixture.start()
  for (const migration of [false, true]) {
    const a = migration ? 'migration-a' : 'binding-a', b = migration ? 'migration-b' : 'binding-b'; await create(a); await create(b)
    const channels = { 'webui:a': { sessionId: a }, 'webui:b': { sessionId: b }, 'discord:unrelated': { sessionId: 'unrelated', mode: 'send-only' } }
    if (migration) { await unlink(bindingsFile); await writeFile(join(state, 'sessions.json.pre-catalog-sqlite-v1.bak'), JSON.stringify({ channelAttachments: channels })) }
    else await writeFile(bindingsFile, JSON.stringify({ channels }))
    const firstHold = marker(a, migration ? 'channels-migration-before-write-hold' : 'channels-after-read-hold'), secondHold = marker(b, 'delete-catalog-hold')
    await writeFile(firstHold, 'owned actual channel RMW hold'); await writeFile(secondHold, 'owned second deletion catalog hold')
    const first = fixture.api('DELETE', route(a), {}); await until(() => exists(firstHold + '.reached'), 'first actual channel read/write boundary')
    const second = fixture.api('DELETE', route(b), {}); await sleep(1200)
    const secondPublishedBeforeRelease = await exists(secondHold + '.reached')
    const duringHold = await readFile(bindingsFile, 'utf8').then(JSON.parse, () => null)
    await unlink(firstHold); const firstResponse = await first
    await until(() => exists(secondHold + '.reached'), 'second actual deletion reaches catalog publication'); await unlink(secondHold); const secondResponse = await second
    assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse)); assert.equal(secondResponse.status, 200, JSON.stringify(secondResponse))
    const final = JSON.parse(await readFile(bindingsFile, 'utf8')).channels
    results.push({ migration, secondPublishedBeforeRelease, duringHold, final, firstResult: firstResponse.body, secondResult: secondResponse.body })
    if (final['webui:a'] || final['webui:b']) problems.push('A deleted WebUI binding survived independent ' + (migration ? 'migration' : 'primary') + ' deletions')
    assert.deepEqual(final['discord:unrelated'], channels['discord:unrelated']); assert.equal(await exists(join(state, 'sessions', a + '.json')), false); assert.equal(await exists(join(state, 'sessions', b + '.json')), false)
  }
  const target = join(state, 'sessions/alias-target.json'), saved = target + '.held', hold = marker('alias-target', 'delete-json-unlink-hold')
  await writeFile(hold, 'owned real unlink fault'); const partialRequest = fixture.api('DELETE', route('nick'), {})
  await until(() => exists(hold + '.reached'), 'actual alias target is admitted and retired before unlink')
  await rename(target, saved); await mkdir(target); await unlink(hold); const partial = await partialRequest
  assert.equal(partial.status, 500, JSON.stringify(partial)); assert.equal(partial.body.failedStage, 'json-unlink')
  await rm(target, { recursive: true }); await rename(saved, target); await create('nick')
  const newBytes = await readFile(join(state, 'sessions/nick.json'), 'utf8'), retry = await fixture.api('DELETE', route('nick'), {})
  results.push({ aliasCollisionStatus: retry.status, aliasCollisionResult: retry.body, originalTargetStillPresent: await exists(target) })
  if (retry.status !== 409 || retry.body.code !== 'SESSION_DELETE_RETRY_MISMATCH' || !(await exists(target))) problems.push('An exact new alias-named lifetime was confused with the original partial target')
  assert.equal(await readFile(join(state, 'sessions/nick.json'), 'utf8'), newBytes)
  if (retry.status === 409) {
    assert.equal(retry.body.retrySessionId, 'alias-target'); const continued = await fixture.api('DELETE', route('alias-target'), {}); assert.equal(continued.status, 200, JSON.stringify(continued)); assert.equal(continued.body.continuedSameHost, true)
    assert.equal(await readFile(join(state, 'sessions/nick.json'), 'utf8'), newBytes)
  }
  await fixture.stop(); await writeFile(join(fixture.root, 'concurrency-results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ ok: problems.length === 0, root: fixture.root, hostPids: fixture.hostPids, requests: 0, results, problems }))
  assert.deepEqual(problems, [])
} finally { console.log('Owned deletion hosts: ' + JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids })); await fixture.cleanup() }
