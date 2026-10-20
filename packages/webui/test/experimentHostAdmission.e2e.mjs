// Real original-App lazy owner admission, selective boot and persistent exec continuation.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const fixture = await createHostFixture('admission-app'), route = id => '/api/sessions/' + encodeURIComponent(id)
const requests = [], errors = [], counts = new Map(), sockets = []
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const inputText = body => JSON.stringify(body.input)
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), key = [...inputText(body).matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0
    counts.set(key, n + 1); requests.push({ key, n, body })
    let output = [text('DONE-' + key)]
    if (key === 'cold-reference' && n === 0) output = [call('refs', 'wait', { waitAllSessions: ['<parent>', '<main>'], wakeIfNoActivityAfterSeconds: 60 })]
    if (key.startsWith('exec-') && n === 0) output = [call('shell-' + key, 'exec', { command: `printf '${key}\\n' >> executions; while [ ! -f ${key}-release ]; do sleep 0.1; done; printf '${key}-complete\\n'`, timeout: 1 })]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'admission-' + requests.length, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } }
await writeModelFixture(fixture.data, models)
// This admission probe has no startup task; the real producer is exercised by experimentHostOnboot.
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
const rows = [], state = join(fixture.data, 'state'), sessions = join(state, 'sessions'), faults = join(state, 'experiment-faults')
await mkdir(sessions, { recursive: true }); await mkdir(faults, { recursive: true }); await writeFile(join(faults, 'record-admissions'), 'record')
function authority(id, extra = {}) { return { sessionStateVersion: 1, id, agent: 'main', model: 'a', verbose: false, busy: false, history: [], queue: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }, nextMessageSeq: 1, nextBlockId: 1, meta: { messageCount: 0, lastMessageTime: 0 }, promptCacheKey: randomUUID(), persistentMemorySnapshot: 'Existing selected snapshot', ...extra } }
async function seed(id, extra = {}, metadata = {}) {
  const raw = authority(id, extra); await writeFile(join(sessions, id + '.json'), JSON.stringify(raw))
  rows.push({ id, agent: 'main', busy: false, queueLength: 0, model: 'a', meta: { messageCount: 0, lastMessageTime: 0 }, ...metadata }); return raw
}
for (let index = 0; index < 1000; index++) await seed('cold-' + String(index).padStart(4, '0'))
await seed('joined', {}, { aliases: ['joined-alias'], meta: { messageCount: 0, lastMessageTime: 100 } })
await seed('other'); await seed('main'); await seed('parent-cold', {}, { aliases: ['parent-alias'] })
await seed('child-ref', { parentSessionId: 'parent-alias' }, { parentSessionId: 'parent-alias' })
for (const id of ['missing', 'corrupt', 'unsupported', 'busy', 'stopping']) await seed(id)
await unlink(join(sessions, 'missing.json')); await writeFile(join(sessions, 'corrupt.json'), '{bad')
for (const [id, patch] of [['unsupported', { sessionStateVersion: 99 }], ['busy', { busy: true, busyStartedAt: 1 }], ['stopping', { stopping: true }]]) await writeFile(join(sessions, id + '.json'), JSON.stringify(authority(id, patch)))
// This is an existing crash-style authority/projection mismatch fixture, not a fault-reachability claim.
await seed('lost-hint', { queue: [{ type: 'user', parts: [{ text: 'CASE:lost-hint' }] }] })
const catalogModule = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
const sourceCatalog = new catalogModule.SessionCatalogStore(join(state, 'catalog.sqlite')); sourceCatalog.initializeEmpty(); sourceCatalog.replaceAll(rows); sourceCatalog.close()
const seedFile = join(fixture.root, 'seed-rows.json'); await writeFile(seedFile, JSON.stringify(rows))
execFileSync('node', [resolve('dotnet/session-catalog-seed-ts.mjs'), fixture.data, seedFile], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const database = join(state, 'catalog.sqlite')
function sql(statement, parameters = []) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare(statement).all(...parameters) } finally { db.close() } }
function updateCatalog(id, patch) {
  const db = new DatabaseSync(database), row = JSON.parse(db.prepare('SELECT metadata_json FROM session_catalog WHERE session_id=?').get(id).metadata_json)
  Object.assign(row, patch); if (patch.meta) row.meta = patch.meta
  db.prepare('UPDATE session_catalog SET metadata_json=?,queue_length=?,busy=? WHERE session_id=?').run(JSON.stringify(row), row.queueLength || 0, row.busy ? 1 : 0, id); db.close()
}
const marker = (id, kind) => join(faults, 'id_' + Buffer.from(id).toString('base64url') + '.' + kind)
const events = async () => (await readFile(join(faults, 'record-admissions.events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
const eventsFor = async (stage, id) => (await events()).filter(line => line === stage + ' ' + id)
async function history(id) { const reply = await fixture.api('GET', route(id) + '/history'); assert.equal(reply.status, 200, JSON.stringify(reply)); return reply.body.messages }
async function dto(id) { const reply = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); assert.equal(reply.status, 200); return reply.body.results[0].session }
async function saved(id) { return JSON.parse(await readFile(join(sessions, id + '.json'), 'utf8')) }
async function send(id, value) { assert.equal((await fixture.api('POST', route(id) + '/message', { text: value })).status, value.startsWith('/') ? 200 : 202) }
async function done(id, value) { await until(async () => (await history(id)).some(row => row.parts?.some(part => part.text?.includes('DONE-' + value))) && !(await dto(id)).busy, value + ' completed') }
const token = 'synthetic-admission-app-api'
async function connect() { const frames = [], ws = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer ' + token } }); sockets.push(ws); ws.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(ws, 'open'); return { ws, frames } }
function subscribe(client, revision, semantic = [], listed = []) { client.ws.send(JSON.stringify({ type: 'set-subscriptions', revision, sessionIds: semantic, sessionListIds: listed, sessionListActive: true })) }
const trackedExec = new Map()
const execRecords = async () => JSON.parse(await readFile(join(state, 'running-exec.json'), 'utf8')).execs
async function launch(id) {
  const reply = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id }); assert.equal(reply.status, 200)
  await send(id, 'CASE:' + id); await done(id, id)
  const tool = (await history(id)).flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'shell-' + id)
  const exec = tool.functionResponse.response.output.match(/execId:\s*([\w-]+)/)[1]; trackedExec.set(id, exec)
  assert((await execRecords()).some(record => record.id === exec && record.sessionId === id))
}
try {
  await fixture.start()
  assert.deepEqual(await events(), ['read main', 'admitted main']); assert.equal(requests.length, 0)
  assert.equal(sql('SELECT session_count FROM catalog_count')[0].session_count, rows.length)
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=40')).status, 200)
  assert.equal((await fixture.api('GET', '/api/session-list/architecture?limit=40')).status, 200)
  assert.equal((await fixture.api('POST', '/api/session-list/by-id', { ids: ['joined-alias', 'missing', 'corrupt', 'main'] })).status, 200)
  assert.equal((await fixture.api('GET', '/api/agents')).body.agents[0].sessionCount, rows.length)
  assert.equal((await fixture.api('POST', route('cold-0999') + '/name', { name: 'Cold Main name' })).status, 200)
  const listClient = await connect(); subscribe(listClient, 1, [], ['joined-alias', 'missing'])
  await until(() => listClient.frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 1), 'pure metadata subscription')
  assert.deepEqual(await events(), ['read main', 'admitted main']); assert(!listClient.frames.some(frame => frame.type === 'session-state')); assert.equal(requests.length, 0)

  const before = await readFile(join(sessions, 'other.json'), 'utf8')
  await writeFile(marker('joined', 'admission-hold'), 'hold')
  const controllers = new AbortController(), headers = { authorization: 'Bearer ' + token }
  const canceled = fetch(fixture.origin + route('joined') + '/history', { headers, signal: controllers.signal }).then(() => assert.fail('canceled caller should not complete'), error => error)
  await until(() => access(marker('joined', 'admission-hold') + '.reached').then(() => true, () => false), 'actual shared read held')
  const clients = Array.from({ length: 6 }, () => fixture.api('GET', route('joined-alias') + '/history'))
  const ingress = fixture.api('POST', route('joined') + '/message', { text: 'CASE:joined' }), continuation = fixture.api('POST', route('joined') + '/message', { text: '/continue' })
  const fork = fixture.api('POST', route('joined') + '/fork', { suffix: 'simultaneous' }), chat = await connect()
  subscribe(chat, 1, ['joined-alias'], ['joined-alias']); controllers.abort(); await canceled
  assert.equal((await fixture.api('GET', route('other') + '/history')).status, 200); assert.equal(await readFile(join(sessions, 'other.json'), 'utf8'), before)
  assert.equal((await eventsFor('read', 'joined')).length, 0); assert.equal((await eventsFor('read', 'other')).length, 1)
  const superseded = await connect(); subscribe(superseded, 1, ['joined']); await sleep(30); subscribe(superseded, 2, [], ['joined'])
  await until(() => superseded.frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 2), 'replacement metadata revision while semantic read remains held')
  assert(!superseded.frames.some(frame => frame.type === 'session-state')); superseded.ws.close(); await once(superseded.ws, 'close')
  await unlink(marker('joined', 'admission-hold'))
  assert((await Promise.all(clients)).every(reply => reply.status === 200)); assert.equal((await ingress).status, 202); assert([200, 409].includes((await continuation).status)); assert.equal((await fork).status, 200)
  await until(() => chat.frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 1), 'Chat snapshot/draft/buffer applied after shared admission')
  await done('joined', 'joined'); assert.equal((await eventsFor('read', 'joined')).length, 1); assert.equal((await eventsFor('admitted', 'joined')).length, 1)
  const applied = chat.frames.findIndex(frame => frame.type === 'subscriptions-applied'), snapshot = chat.frames.findIndex(frame => frame.type === 'session-state'), draft = chat.frames.findIndex(frame => frame.type === 'model-stream-state')
  assert(snapshot >= 0 && snapshot < applied); if (draft >= 0) assert(draft < applied)

  await writeFile(marker('published', 'creation-publication-hold'), 'hold')
  const creation = fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'published' })
  await until(() => access(marker('published', 'creation-publication-hold') + '.reached').then(() => true, () => false), 'actual committed creation row before hot owner')
  const joinedCreation = fixture.api('GET', route('published') + '/history'), creationChat = await connect(); subscribe(creationChat, 1, ['published'])
  assert.equal((await dto('published')).id, 'published'); await sleep(40); assert.equal((await eventsFor('read', 'published')).length, 0)
  await unlink(marker('published', 'creation-publication-hold')); assert.equal((await creation).status, 200); assert.equal((await joinedCreation).status, 200)
  await until(() => creationChat.frames.some(frame => frame.type === 'subscriptions-applied'), 'created owner joins Chat'); assert.equal((await eventsFor('created', 'published')).length, 1); assert.equal((await eventsFor('read', 'published')).length, 0)

  for (const id of ['missing', 'corrupt', 'unsupported', 'busy', 'stopping']) {
    const failure = await fixture.api('GET', route(id) + '/history'); assert.equal(failure.status, 500, id + JSON.stringify(failure)); assert((failure.body.detail || failure.body.error || '').length > 0)
    assert.equal((await dto(id)).id, id); assert.equal((await eventsFor('admitted', id)).length, 0)
  }
  const failedChat = await connect(); subscribe(failedChat, 1, ['missing']); await until(() => failedChat.frames.some(frame => frame.code === 'SESSION_STATE_UNAVAILABLE'), 'known missing Chat error'); assert(!failedChat.frames.some(frame => frame.type === 'session-deleted'))
  await writeFile(join(sessions, 'missing.json'), JSON.stringify(authority('missing'))); assert.equal((await fixture.api('GET', route('missing') + '/history')).status, 200)
  assert.equal((await fixture.api('GET', route('unknown') + '/history')).status, 404); assert.equal(sql("SELECT COUNT(*) n FROM session_catalog WHERE session_id='unknown'")[0].n, 0)

  await send('child-ref', 'CASE:cold-reference'); await until(async () => (await saved('child-ref')).meta.wait?.waitAll, 'real child placeholder wait')
  assert.deepEqual((await saved('child-ref')).meta.wait.waitAll.sessions, ['parent-cold', 'main']); assert.equal((await eventsFor('read', 'parent-cold')).length, 0); assert.equal((await eventsFor('read', 'main')).length, 1)
  await send('child-ref', 'CASE:refs-finish'); await done('child-ref', 'refs-finish')
  const priorLost = requests.length; assert.equal((await fixture.api('GET', route('lost-hint') + '/history')).status, 200); await sleep(100)
  assert.equal(requests.length, priorLost); assert.equal((await dto('lost-hint')).queueLength, 1); await send('lost-hint', '/dequeue'); await done('lost-hint', 'lost-hint')

  const page = await fixture.openApp(); await page.evaluate(() => location.hash = 'architecture'); await page.waitForSelector('.foxwarm-architecture-surface-tab'); await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Agents').click())
  await page.waitForSelector('[data-architecture-agent-id="main"]'); await page.evaluate(() => location.hash = 'chat'); await page.waitForSelector('.foxwarm-chat-root'); await page.evaluate(() => window.foxwarmTest.switchToSession('joined'))
  await until(() => page.evaluate(() => document.body.innerText.includes('DONE-joined')), 'original Chat canonical assistant'); assert.equal((await eventsFor('read', 'joined')).length, 1)
  await launch('exec-live'); await launch('exec-finished')
  for (const client of sockets) if (client.readyState === WebSocket.OPEN) client.close()
  await fixture.stop(); const beforeRestart = requests.length
  await writeFile(join(fixture.work, 'exec-finished-release'), 'release')
  await until(async () => { const folder = join(state, 'exec', 'id_' + Buffer.from('exec-finished').toString('base64url'), trackedExec.get('exec-finished')); return access(join(folder, 'status.json')).then(() => true, () => false) }, 'exec finished while no host can deliver')
  // Ordinary persisted onboot is resumed; a pure old compact wake does not manufacture a planner.
  await writeFile(join(sessions, 'cold-0000.json'), JSON.stringify(authority('cold-0000', { queue: [{ type: 'onboot', parts: [{ text: 'CASE:boot-queue' }] }] }))); updateCatalog('cold-0000', { queueLength: 1 })
  await writeFile(join(sessions, 'cold-0001.json'), JSON.stringify(authority('cold-0001', { queue: [{ type: 'compact-commit' }] })))
  await writeFile(join(sessions, 'cold-0002.json'), JSON.stringify(authority('cold-0002', { queue: [{ type: 'user', parts: [{ text: 'CASE:second-lost-hint' }] }] })))
  const indexPlan = sql("EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE json_type(metadata_json,'$.meta.wait.id')='text'"); assert(indexPlan.some(row => row.detail.includes('idx_session_catalog_wait_presence')))
  const observationOffset = (await events()).length; await fixture.start()
  const startupEvents = (await events()).slice(observationOffset)
  assert(['exec-live', 'exec-finished', 'cold-0000'].every(id => startupEvents.includes('read ' + id)))
  await done('exec-finished', 'exec-finished'); await done('cold-0000', 'boot-queue'); assert.equal(counts.get('second-lost-hint'), undefined)
  const restarted = (await events()).slice(observationOffset), readIds = restarted.filter(line => line.startsWith('read ')).map(line => line.slice(5))
  assert(readIds.includes('exec-live') && readIds.includes('exec-finished') && readIds.includes('cold-0000')); assert(!readIds.includes('cold-0001')); assert(!readIds.includes('cold-0002'))
  await writeFile(join(fixture.work, 'exec-live-release'), 'release'); await until(() => (counts.get('exec-live') || 0) === 3, 'live command natural completion after owner admission')
  assert.deepEqual((await readFile(join(fixture.work, 'executions'), 'utf8')).trim().split('\n').sort(), ['exec-finished', 'exec-live'])
  assert(requests.length > beforeRestart); assert.equal((await fixture.api('GET', route('cold-0002') + '/history')).status, 200); assert.equal((await dto('cold-0002')).queueLength, 1); assert.equal(counts.get('second-lost-hint'), undefined)
  assert.equal((await fixture.api('GET', route('cold-0001') + '/history')).status, 200); assert.equal(counts.get('ordinary'), undefined)
  assert.deepEqual(errors, [])
  await launch('exec-bad'); await fixture.stop()
  const retainedExec = (await execRecords()).find(record => record.id === trackedExec.get('exec-bad'))
  const originalExecAuthority = await readFile(join(sessions, 'exec-bad.json'), 'utf8')
  await writeFile(join(fixture.work, 'exec-bad-release'), 'release'); await until(() => access(retainedExec.statusPath).then(() => true, () => false), 'finished exec without an active recipient')
  await writeFile(join(sessions, 'exec-bad.json'), '{bad')
  const expired = { id: 'original-boot-deadline', startedAt: Date.now() - 5000, timeoutSeconds: 0.01, declarationVersion: 1 }
  await writeFile(join(sessions, 'cold-0003.json'), JSON.stringify(authority('cold-0003', { meta: { messageCount: 0, lastMessageTime: 0, wait: expired } })))
  updateCatalog('cold-0003', { meta: { messageCount: 0, lastMessageTime: 0, wait: expired } })
  const beforeFailure = requests.length
  await assert.rejects(fixture.start(), /authority|Authority|JSON|Json|invalid|Invalid/)
  await sleep(400); assert.equal(requests.length, beforeFailure); assert.deepEqual((await saved('cold-0003')).meta.wait, expired)
  assert((await execRecords()).some(record => record.id === retainedExec.id)) // A failed recipient never acknowledges the completion.
  await writeFile(join(sessions, 'exec-bad.json'), originalExecAuthority); await fixture.start()
  await until(() => requests.slice(beforeFailure).some(row => inputText(row.body).includes('wait-timeout')), 'only fully validated restart activates the original expired deadline')
  await until(() => (counts.get('exec-bad') || 0) === 3, 'finished completion delivered only after actual owner admission')
  await until(async () => !(await execRecords()).some(record => record.id === retainedExec.id), 'strict completion acknowledgement')
  assert.deepEqual((await readFile(join(fixture.work, 'executions'), 'utf8')).trim().split('\n').sort(), ['exec-bad', 'exec-finished', 'exec-live'])
  await fixture.stop()
  console.log(JSON.stringify({ ok: true, syntheticProviderRequests: requests.length, coldMembers: rows.length, sameIdRead: 1, creationRead: 0, cleanHosts: 3, mandatoryReadinessFailure: true, deadlineAfterAllValidation: true, failedExecNoAcknowledgement: true, zeroOwnerMetadata: true, requiredMainStartupRead: 1, lostHintExactNoActivation: true, realExecNoReplay: true, persistedOnbootQueue: true, oldCompactWakeNoPlanner: true, hostPids: fixture.hostPids, peerPid: process.pid, root: fixture.root }))
} catch (error) { console.error(fixture.output); throw error } finally {
  console.log(JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids }))
  for (const ws of sockets) ws.terminate()
  for (const id of ['exec-live', 'exec-finished', 'exec-bad']) await writeFile(join(fixture.work, id + '-release'), 'release').catch(() => {})
  await new Promise(done => peer.close(done)); await fixture.cleanup()
}
