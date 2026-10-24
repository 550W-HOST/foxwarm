// Retained execution placement, native cwd resolution and fail-before-effects startup.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const repo = resolve('.')
const options = {}
const fixture = await createHostFixture('execution-context', options)
Object.assign(process.env, testEnvironment.isolatedApplicationEnv(fixture.data))
const { SessionCatalogStore } = await import('../../../lib/session/catalogStore.js')
options.cwd = fixture.root
const counts = new Map(), requests = [], failures = []
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1]
    assert(key)
    const n = counts.get(key) || 0; counts.set(key, n + 1); requests.push({ key, n })
    const output = n === 0 ? [
      call('write-' + key, 'write', { filePath: key + '-write.txt', content: 'owned-' + key }),
      call('exec-' + key, 'exec', { command: `pwd > ${key}-pwd.txt; printf 'owned-${key}' > ${key}-exec.txt`, timeout: 3, ...(key === 'explicit-cwd' ? { cwd: 'intended' } : {}) }),
    ] : [message('DONE-' + key)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: randomUUID(), status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); res.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const state = join(fixture.data, 'state'), sessions = join(state, 'sessions')
const intended = join(fixture.work, 'intended'), relative = join(fixture.root, 'work')
await mkdir(sessions, { recursive: true }); await mkdir(intended); await mkdir(join(relative, 'work'), { recursive: true })
const variants = [
  ['omitted', {}], ['master', { currentNode: 'master' }], ['empty', { currentNode: '', cwd: '' }], ['null', { currentNode: null, cwd: null }],
  ['trimmed', { currentNode: '\ufeff master\t', cwd: '\ufeff \n' }], ['default-cwd', { currentNode: 'master', cwd: fixture.work + '/.' }],
  ['explicit-cwd', { currentNode: 'master' }], ['queued-default', { cwd: fixture.work }, true],
  ['custom-cwd', { currentNode: 'master', cwd: intended }], ['remote', { currentNode: 'owned-unavailable-node' }],
  ['remote-cwd', { currentNode: 'owned-unavailable-node', cwd: intended }], ['relative-cwd', { cwd: 'work' }],
]
const offline = new Set(['remote', 'remote-cwd'])
const rows = [], originals = new Map(), results = []
function seedAuthority(id, patch, queued = false) {
  return { sessionStateVersion: 1, id, agent: 'main', model: 'a', verbose: false, busy: false, history: [], queue: queued ? [{ type: 'user', parts: [{ text: 'CASE:' + id }] }] : [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }, nextMessageSeq: 1, nextBlockId: 1, meta: { messageCount: 0, lastMessageTime: 0 }, promptCacheKey: randomUUID(), persistentMemorySnapshot: 'Owned existing snapshot', ...patch }
}
for (const [id, patch, queued] of variants) {
  const raw = seedAuthority(id, patch, queued), serialized = JSON.stringify(raw)
  await writeFile(join(sessions, id + '.json'), serialized); originals.set(id, serialized)
  rows.push({ id, agent: 'main', busy: false, queueLength: queued ? 1 : 0, model: 'a', meta: raw.meta, ...patch })
}
const catalog = new SessionCatalogStore(join(state, 'catalog.sqlite'))
catalog.initializeEmpty(); catalog.replaceAll(rows); catalog.close()
function seedBranches(name, rows) {
  const seed = join(fixture.root, name + '.json')
  return writeFile(seed, JSON.stringify(rows)).then(() => execFileSync(process.execPath, [join(repo, 'dotnet/session-catalog-seed-ts.mjs'), fixture.data, seed], { env: { ...process.env, FOXWARM_TS_ROOT: repo } }))
}
await seedBranches('seed', rows)
const exists = path => access(path).then(() => true, () => false)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const authority = id => readFile(join(sessions, id + '.json'), 'utf8').then(JSON.parse)
async function done(id) {
  await until(async () => {
    const reply = await fixture.api('GET', route(id) + '/history')
    return !reply.body.session.busy && reply.body.messages.some(row => row.parts?.some(part => part.text === 'DONE-' + id))
  }, id + ' committed pairs and idle')
}
try {
  await fixture.start()
  const exact = async id => {
    const reply = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); assert.equal(reply.status, 200)
    return reply.body.results[0].session
  }
  for (const [id, patch, queued] of variants) {
    const cold = await exact(id), before = await fixture.api('GET', route(id) + '/history')
    assert.equal(before.status, 200)
    const warm = await exact(id); assert.equal(warm.currentNode, String(cold.currentNode || 'master').trim() || 'master')
    if (!queued) {
      // Projection and admission keep retained raw context; actual exec later publishes its cwd.
      assert.equal(await readFile(join(sessions, id + '.json'), 'utf8'), originals.get(id))
      assert.equal(warm.cwd, cold.cwd)
      assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'CASE:' + id })).status, 202)
    }
    await done(id)
    const actual = await authority(id)
    const paired = actual.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse)
    assert.equal(paired.length, 2)
    if (offline.has(id)) {
      assert(paired.every(part => part.response.error), 'Unavailable selected Node fails both actual tools.')
      for (const root of [fixture.work, intended, fixture.root, relative]) {
        assert.equal(await exists(join(root, id + '-write.txt')), false)
        assert.equal(await exists(join(root, id + '-exec.txt')), false)
      }
      assert.equal(actual.currentNode, patch.currentNode); assert.equal(actual.cwd, patch.cwd)
      results.push({ id, admittedOffline: true, pairedErrors: 2, noNativeFallback: true })
      continue
    }
    assert(paired.every(part => !part.response.error), JSON.stringify(paired))
    const fileRoot = id === 'custom-cwd' ? intended : id === 'relative-cwd' ? relative : fixture.work
    const execRoot = ['explicit-cwd', 'custom-cwd'].includes(id) ? intended : id === 'relative-cwd' ? join(relative, 'work') : fixture.work
    assert.equal(await readFile(join(fileRoot, id + '-write.txt'), 'utf8'), 'owned-' + id)
    assert.equal(await readFile(join(execRoot, id + '-exec.txt'), 'utf8'), 'owned-' + id)
    assert.equal((await readFile(join(execRoot, id + '-pwd.txt'), 'utf8')).trim(), execRoot)
    assert.equal(actual.cwd, execRoot, 'Direct exec segment replays the actual resolved cwd.')
    if ('currentNode' in patch) assert.equal(actual.currentNode, patch.currentNode)
    results.push({ id, queued: Boolean(queued), pairedCalls: 2, fileRoot, execRoot, contextPreservedUntilEffect: true })
  }
  await fixture.stop()
  // Malformed identity is an admission error; a valid unavailable Node remains inspectable.
  const bootRows = []
  for (const [id, node] of [['mandatory-good', 'master'], ['mandatory-bad', 'provider/instance/invalid']]) {
    const raw = seedAuthority(id, { currentNode: node }, true)
    await writeFile(join(sessions, id + '.json'), JSON.stringify(raw))
    bootRows.push({ id, agent: 'main', model: 'a', busy: false, queueLength: 1, meta: raw.meta, currentNode: node })
  }
  const bootCatalog = new SessionCatalogStore(join(state, 'catalog.sqlite')); bootCatalog.upsertMany(bootRows); bootCatalog.close()
  await seedBranches('boot-seed', bootRows)
  const bootBefore = await Promise.all(bootRows.map(row => readFile(join(sessions, row.id + '.json'), 'utf8'))), requestCount = requests.length
  await assert.rejects(() => fixture.start(), /InvalidDataException/)
  assert.equal(requests.length, requestCount)
  for (let i = 0; i < bootRows.length; i++) {
    // Earlier admitted recovery candidates may receive a normal strict save, but no input is consumed.
    const retained = await authority(bootRows[i].id)
    for (const [key, value] of Object.entries(JSON.parse(bootBefore[i]))) assert.deepEqual(retained[key], value)
    assert.equal(await exists(join(fixture.work, bootRows[i].id + '-exec.txt')), false)
    assert.equal(await exists(join(fixture.work, bootRows[i].id + '-write.txt')), false)
  }
  const repaired = JSON.parse(bootBefore[1]); repaired.currentNode = 'master'
  await writeFile(join(sessions, 'mandatory-bad.json'), JSON.stringify(repaired))
  await fixture.start()
  for (const row of bootRows) await done(row.id)
  await fixture.stop(); assert.deepEqual(failures, [])
  console.log(JSON.stringify({ ok: true, root: fixture.root, hostPids: fixture.hostPids, requests: requests.length, mandatoryGlobalFailureBeforeSiblingEffects: true, repairRetry: true, results }, null, 2))
} finally { await fixture.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
