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
const rows = [], state = join(fixture.data, 'state'), sessions = join(state, 'sessions')
await mkdir(sessions, { recursive: true });
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
execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/session-catalog-seed-ts.mjs'), fixture.data, seedFile], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const database = join(state, 'catalog.sqlite')
function sql(statement, parameters = []) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare(statement).all(...parameters) } finally { db.close() } }
function updateCatalog(id, patch) {
  const db = new DatabaseSync(database), row = JSON.parse(db.prepare('SELECT metadata_json FROM session_catalog WHERE session_id=?').get(id).metadata_json)
  Object.assign(row, patch); if (patch.meta) row.meta = patch.meta
  db.prepare('UPDATE session_catalog SET metadata_json=?,queue_length=?,busy=? WHERE session_id=?').run(JSON.stringify(row), row.queueLength || 0, row.busy ? 1 : 0, id); db.close()
}

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
   assert.equal(requests.length, 0)
  assert.equal(sql('SELECT session_count FROM catalog_count')[0].session_count, rows.length)
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=40')).status, 200)
  assert.equal((await fixture.api('GET', '/api/session-list/architecture?limit=40')).status, 200)
  assert.equal((await fixture.api('POST', '/api/session-list/by-id', { ids: ['joined-alias', 'missing', 'corrupt', 'main'] })).status, 200)
  assert.equal((await fixture.api('GET', '/api/agents')).body.agents[0].sessionCount, rows.length)
  assert.equal((await fixture.api('POST', route('cold-0999') + '/name', { name: 'Cold Main name' })).status, 200)
  const listClient = await connect(); subscribe(listClient, 1, [], ['joined-alias', 'missing'])
  await until(() => listClient.frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 1), 'pure metadata subscription')
   assert(!listClient.frames.some(frame => frame.type === 'session-state')); assert.equal(requests.length, 0)

  const clients = await Promise.all(Array.from({ length: 6 }, () => fixture.api('GET', route('joined-alias') + '/history')))
  assert(clients.every(reply => reply.status === 200))
  await send('joined', 'CASE:joined'); await done('joined', 'joined')
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'published' })).status, 200)
  for (const id of ['missing', 'corrupt', 'unsupported', 'stopping']) {
    const failure = await fixture.api('GET', route(id) + '/history'); assert.equal(failure.status, 500, id + JSON.stringify(failure)); assert((failure.body.detail || failure.body.error || '').length > 0)
    assert.equal((await dto(id)).id, id);
  }
  assert.equal((await fixture.api('GET', route('busy') + '/history')).status, 200)
  const recovered = await saved('busy')
  assert.equal(recovered.busy, false); assert.equal(recovered.queue.length, 1)
  assert.match(recovered.queue[0].parts[0].system, /session-resumed/)

  await send('busy', '/dequeue'); await done('busy', 'ordinary')
  const failedChat = await connect(); subscribe(failedChat, 1, ['missing']); await until(() => failedChat.frames.some(frame => frame.code === 'SESSION_STATE_UNAVAILABLE'), 'known missing Chat error'); assert(!failedChat.frames.some(frame => frame.type === 'session-deleted'))
  await writeFile(join(sessions, 'missing.json'), JSON.stringify(authority('missing'))); assert.equal((await fixture.api('GET', route('missing') + '/history')).status, 200)
  assert.equal((await fixture.api('GET', route('unknown') + '/history')).status, 404); assert.equal(sql("SELECT COUNT(*) n FROM session_catalog WHERE session_id='unknown'")[0].n, 0)

  await send('child-ref', 'CASE:cold-reference'); await until(async () => (await saved('child-ref')).meta.wait?.waitAll, 'real child placeholder wait')
  assert.deepEqual((await saved('child-ref')).meta.wait.waitAll.sessions, ['parent-cold', 'main']);
  await send('child-ref', 'CASE:refs-finish'); await done('child-ref', 'refs-finish')
  const priorLost = requests.length; assert.equal((await fixture.api('GET', route('lost-hint') + '/history')).status, 200); await sleep(100)
  assert.equal(requests.length, priorLost); assert.equal((await dto('lost-hint')).queueLength, 1); await send('lost-hint', '/dequeue'); await done('lost-hint', 'lost-hint')

  const page = await fixture.openApp(); await page.evaluate(() => location.hash = 'architecture'); await page.waitForSelector('.foxwarm-architecture-surface-tab'); await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Agents').click())
  await page.waitForSelector('[data-architecture-agent-id="main"]'); await page.evaluate(() => location.hash = 'chat'); await page.waitForSelector('.foxwarm-chat-root'); await page.evaluate(() => window.foxwarmTest.switchToSession('joined'))
  await until(() => page.evaluate(() => document.body.innerText.includes('DONE-joined')), 'original Chat canonical assistant');
  await launch('exec-live'); await launch('exec-finished')
  for (const client of sockets) if (client.readyState === WebSocket.OPEN) client.close()
  await fixture.stop(); const beforeRestart = requests.length
  await writeFile(join(fixture.work, 'exec-finished-release'), 'release')
  const finishedExec = (await execRecords()).find(record => record.id === trackedExec.get('exec-finished'))
  await until(() => access(finishedExec.statusPath).then(() => true, () => false), 'exec finished while no host can deliver')
  // Ordinary persisted onboot is resumed; a pure old compact wake does not manufacture a planner.
  await writeFile(join(sessions, 'cold-0000.json'), JSON.stringify(authority('cold-0000', { queue: [{ type: 'onboot', parts: [{ text: 'CASE:boot-queue' }] }] }))); updateCatalog('cold-0000', { queueLength: 1 })
  await writeFile(join(sessions, 'cold-0001.json'), JSON.stringify(authority('cold-0001', { queue: [{ type: 'compact-commit' }] })))
  await writeFile(join(sessions, 'cold-0002.json'), JSON.stringify(authority('cold-0002', { queue: [{ type: 'user', parts: [{ text: 'CASE:second-lost-hint' }] }] })))
  const indexPlan = sql("EXPLAIN QUERY PLAN SELECT session_id FROM session_catalog WHERE json_type(metadata_json,'$.meta.wait.id')='text'"); assert(indexPlan.some(row => row.detail.includes('idx_session_catalog_wait_presence')))
   await fixture.start()

  await done('exec-finished', 'exec-finished'); await done('cold-0000', 'boot-queue'); assert.equal(counts.get('second-lost-hint'), undefined)

  await writeFile(join(fixture.work, 'exec-live-release'), 'release'); await until(() => (counts.get('exec-live') || 0) === 3, 'live command natural completion after owner admission')
  assert.deepEqual((await readFile(join(fixture.work, 'executions'), 'utf8')).trim().split('\n').sort(), ['exec-finished', 'exec-live'])
  assert(requests.length > beforeRestart); assert.equal((await fixture.api('GET', route('cold-0002') + '/history')).status, 200); assert.equal((await dto('cold-0002')).queueLength, 1); assert.equal(counts.get('second-lost-hint'), undefined)
  assert.equal((await fixture.api('GET', route('cold-0001') + '/history')).status, 200); assert.equal(counts.get('ordinary'), 1)
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
  console.log(JSON.stringify({ ok: true, syntheticProviderRequests: requests.length, coldMembers: rows.length, cleanHosts: 3, mandatoryReadinessFailure: true, deadlineAfterAllValidation: true, failedExecNoAcknowledgement: true, lostHintExactNoActivation: true, realExecNoReplay: true, persistedOnbootQueue: true, oldCompactWakeNoPlanner: true, hostPids: fixture.hostPids, peerPid: process.pid, root: fixture.root }))
} catch (error) { console.error(fixture.output); throw error } finally {
  console.log(JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids }))
  for (const ws of sockets) ws.terminate()
  for (const id of ['exec-live', 'exec-finished', 'exec-bad']) await writeFile(join(fixture.work, id + '-release'), 'release').catch(() => {})
  await new Promise(done => peer.close(done)); await fixture.cleanup()
}
