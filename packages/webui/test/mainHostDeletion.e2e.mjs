// Original App and actual provider/tool/session lifetimes over Main-local coordinated deletion.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const fixture = await createHostFixture('deletion-app'), route = id => '/api/sessions/' + encodeURIComponent(id)
const records = [], errors = [], held = new Map(), frames = [], counts = new Map(), shells = []
let socket, page
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), input = JSON.stringify(body.input), key = [...input.matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0
    counts.set(key, n + 1)
    const record = { body, key, n, closed: false }; records.push(record)
    response.on('close', () => { record.closed = true })
    record.complete = output => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'delete-' + records.length, status: 'completed', output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
    }
    if (input.includes('COMPACTION STARTED:')) { record.planning = true; held.set('plan', record); return }
    if (key === 'exec-finished' && n === 2) { held.set('retained-completion', record); return }
    if (key.startsWith('held-')) { held.set(key, record); return }
    if (key === 'model-delete' && n < 2) {
      record.complete(n === 0 ? [call('discover-delete', 'search_tools', { query: 'delete_session', sources: ['builtin'], limit: 5 })]
        : [call('registry-delete', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'registry-target' } })]); return
    }
    if (key === 'source-child' && n === 0) { record.complete([call('delete-parent', 'call_tool', { source: 'builtin', name: 'delete_session', args: { sessionId: 'parent-model' } })]); return }
    if (key === 'self' && n === 0) { record.complete([call('self-delete', 'delete_session', { sessionId: 'source-alias' })]); return }
    if (key === 'isolated' && n === 0) { record.complete([call('isolated-delete', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'isolated-target' } })]); return }
    if (key === 'wait-sibling' && n === 0) { record.complete([call(key, 'wait', { wakeIfNoActivityAfterSeconds: 2 })]); return }
    if (key.startsWith('exec-') && n === 0) {
      record.complete([call(key, 'exec', { command: `printf '${key}\\n' >> deletion-executions; while [ ! -f ${key}-release ]; do sleep 0.05; done; printf '${key}-finished\\n'`, timeout: 1 })]); return
    }
    record.complete(final('DONE-' + key))
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
// This focused deletion probe owns no startup task; the producer is covered by mainHostOnboot.
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000, asyncCompact: true } } })
const state = join(fixture.data, 'state'), sessions = join(state, 'sessions'), rows = []
await mkdir(sessions, { recursive: true });
await mkdir(join(fixture.data, 'agents', 'locked', 'memory'), { recursive: true })
await writeFile(join(state, 'agents.json'), JSON.stringify({ locked: { isolated: true } }))
async function seed(id, metadata = {}, extra = {}) {
  const agent = id.includes('/') ? id.split('/')[0] : 'main'
  rows.push({ id, agent, aliases: [], busy: false, queueLength: 0, meta: { lastMessageTime: 100, messageCount: 0 }, ...metadata })
  const path = join(sessions, id + '.json'); await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionStateVersion: 1, id, agent, model: 'a', busy: false, stopping: false, history: [], queue: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: 100, messageCount: 0 }, historyVersion: 0,
    lastAppliedMailboxId: 0, nextMessageSeq: 1, nextBlockId: 1, persistentMemorySnapshot: 'Existing selected snapshot', promptCacheKey: '00000000-0000-0000-0000-000000000001', ...extra }))
}
await seed('root', { aliases: ['root-alias'] })
for (let index = 0; index < 1000; index++) await seed('cold-' + String(index).padStart(4, '0'), { parentSessionId: 'root', archived: index === 500, pinned: index === 700 })
// Malformed placement exercises admission failure; valid offline Node IDs remain readable.
await seed('foreign-child', { parentSessionId: 'root', currentNode: 'invalid node' }, { currentNode: 'invalid node' })
for (const id of ['source', 'registry-target', 'isolated-target', 'command-target', 'live', 'background', 'exec-live', 'exec-finished', 'exec-bad', 'wait-sibling']) await seed(id, id === 'source' ? { aliases: ['source-alias'], pinned: true } : {})
await seed('locked/main'); await seed('parent-model'); await seed('child-source', { parentSessionId: 'parent-model' })
for (const root of ['00-ui-single', '00-ui-tree', 'tree', 'bad-tree']) {
  await seed(root, { pinned: root.startsWith('00-') }); await seed(root + '-child', { parentSessionId: root, pinned: true }); await seed(root + '-grand', { parentSessionId: root + '-child', archived: true })
}
await seed('bad-tree-foreign', { parentSessionId: 'bad-tree', currentNode: 'invalid node' }, { currentNode: 'invalid node' })
await seed('self-cycle', { parentSessionId: 'self-cycle' }); await seed('worker-target'); await seed('worker-orphan')
const catalogModule = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
const catalog = new catalogModule.SessionCatalogStore(join(state, 'catalog.sqlite')); catalog.initializeEmpty(); catalog.replaceAll(rows); catalog.close()
const seedFile = join(fixture.root, 'seed.json'); await writeFile(seedFile, JSON.stringify(rows))
execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/session-catalog-seed-ts.mjs'), fixture.data, seedFile], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const channelsFile = join(state, 'channels.json')
function audit() { const db = new DatabaseSync(join(state, 'archive-store.sqlite'), { readOnly: true }); try { return ['archive_messages', 'archive_blocks', 'archive_branches'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()) } finally { db.close() } }
const saved = id => readFile(join(sessions, id + '.json'), 'utf8').then(JSON.parse)
async function dto(id) { const reply = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); assert.equal(reply.status, 200); return reply.body.results[0].session }
async function remove(id, recursive = false, status = 200) { const reply = await fixture.api('DELETE', route(id), { includeDescendants: recursive }); assert.equal(reply.status, status, JSON.stringify(reply)); return reply.body }
async function message(id, text, status = 202) { const reply = await fixture.api('POST', route(id) + '/message', { text }); assert.equal(reply.status, status, JSON.stringify(reply)); return reply.body }
const idle = current => current && !current.busy && !current.runtimeState?.processing && !current.queueLength
const finals = async (id, key) => (await saved(id)).history.filter(row => row.role === 'model' && row.parts?.some(part => part.text === 'DONE-' + key)).length
async function done(id, key, expectedFinals = 1) { await until(async () => idle(await dto(id)) && await finals(id, key) === expectedFinals, 'completed ' + key) }
async function send(id, key, extra = '') { await message(id, 'CASE:' + key + ' ' + extra); await done(id, key) }
const fileFor = id => join(sessions, id + '.json')

const coldBytes = new Map(); for (const row of rows.filter(row => row.parentSessionId === 'root')) coldBytes.set(row.id, await readFile(fileFor(row.id), 'utf8'))
let retainedBefore = audit(); const independent = join(state, 'toolscript-runs', 'retained-run.json')
await mkdir(join(state, 'toolscript-runs'), { recursive: true }); await writeFile(independent, '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}')
try {
  await fixture.start()
  socket = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-deletion-app-api' } })
  socket.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: [], sessionListIds: ['root', 'source', 'tree'], sessionListActive: true }))
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied'), 'metadata-only initial subscriptions')
  assert.equal(records.length, 0)
  assert(!audit()[2].some(row => row.session_id === 'main')); retainedBefore = audit()
  const cursor = (await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2')).body.nextCursor
  const single = await remove('root-alias'); assert.deepEqual(single.deletedSessionIds, ['root']); assert.equal(single.detachedChildSessionIds.length, 1001)
  for (const [id, bytes] of coldBytes) { assert.equal(await readFile(fileFor(id), 'utf8'), bytes); assert.equal((await dto(id)).parentSessionId, null) }
  assert.equal((await fixture.api('GET', route('foreign-child') + '/history')).status, 500)
  assert.deepEqual(audit(), retainedBefore); assert.equal(await readFile(independent, 'utf8'), '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}')
  await until(() => frames.some(frame => frame.type === 'session-list-delta' && frame.deletedIds?.includes('root')), 'real live deletion list event')
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2&cursor=' + encodeURIComponent(cursor))).body.reset, true)
  await remove('root', false, 404); const reservedRoot = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'root' }); assert.equal(reservedRoot.status, 409); assert.match(reservedRoot.body.error, /reserved/)
  const badBytes = await readFile(fileFor('bad-tree'), 'utf8'); await remove('bad-tree', true, 500); assert.equal(await readFile(fileFor('bad-tree'), 'utf8'), badBytes)
  await remove('self-cycle', true, 409); const tree = await remove('tree', true); assert.deepEqual(tree.deletedSessionIds, ['tree-grand', 'tree-child', 'tree'])
  const beforeBlocked = audit(); await writeFile(channelsFile, JSON.stringify({ channels: { 'discord:room': { sessionId: 'command-target' }, 'webui:chat': { sessionId: 'command-target' }, 'discord:alias': { sessionId: 'source-alias' } } }))
  const blocker = await remove('command-target', false, 409); assert.equal(blocker.code, 'SESSION_DELETE_CHANNEL_BLOCKED'); assert.deepEqual(audit(), beforeBlocked)
  await writeFile(channelsFile, '{broken'); await remove('command-target', false, 500); assert(await dto('command-target'))
  await unlink(channelsFile); await writeFile(join(state, 'sessions.json.pre-catalog-sqlite-v1.bak'), JSON.stringify({ channelAttachments: { 'webui:chat': 'command-target', 'discord:alias': { sessionId: 'source-alias', mode: 'push-only', dangerouslyAllowAllGroupMembers: true } } }))
  await send('source', 'self'); assert(await dto('source')); assert((await saved('source')).history.some(row => JSON.stringify(row).includes('SESSION_DELETE_CURRENT')))
  await send('source', 'model-delete'); assert.equal(await dto('registry-target'), null)
  assert(records.filter(row => !row.planning).every(row => !row.body.tools.some(tool => tool.name === 'delete_session')))
  await send('child-source', 'source-child'); assert.equal(await dto('parent-model'), null); assert.equal((await dto('child-source')).parentSessionId, null)
  const childHistory = (await saved('child-source')).history; assert(childHistory.some(row => row.role === 'tool' && JSON.stringify(row).includes('deleted successfully'))); assert.equal(childHistory.at(-1).parts[0].text, 'DONE-source-child')
  await send('locked/main', 'isolated'); assert(await dto('isolated-target')); assert((await saved('locked/main')).history.some(row => JSON.stringify(row).includes('tool_authorization_denied')))
  page = await fixture.openApp(); await page.setViewport({ width: 1440, height: 1200 }); await page.evaluate(() => window.foxwarmTest.switchToSession('source'))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.innerText.includes('session source')); await sleep(350)
  const sourceBytes = await readFile(fileFor('source'), 'utf8'), commandAudit = audit(), providerCount = records.length
  await page.evaluate(() => window.foxwarmTest.sendMessage('/session delete command-target'))
  await until(async () => (await page.evaluate(() => document.body.innerText)).includes('command-target') && (await page.evaluate(() => document.body.innerText)).includes('deleted.'), 'actual temporary delete command Chat response')
  assert.equal(await readFile(fileFor('source'), 'utf8'), sourceBytes); assert.deepEqual(audit(), commandAudit); assert.equal(records.length, providerCount)
  const bindings = JSON.parse(await readFile(channelsFile, 'utf8')).channels; assert(!bindings['webui:chat']); assert.equal(bindings['discord:alias'].sessionId, 'source-alias'); assert.equal(bindings['discord:alias'].mode, 'send-only')
  for (const [id, recursive] of [['00-ui-single', false], ['00-ui-tree', true]]) {
    await page.waitForSelector('[data-session-id="' + id + '"]'); await page.click('[data-session-id="' + id + '"]', { button: 'right' })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Delete' && !button.disabled))
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Delete').click())
    await page.waitForSelector('.foxwarm-session-delete-modal'); await page.waitForFunction(() => document.querySelector('.foxwarm-session-delete-confirm-button') && !document.querySelector('.foxwarm-session-delete-confirm-button').disabled)
    if (recursive) await page.click('.foxwarm-session-delete-modal input[type="checkbox"]')
    await page.click('.foxwarm-session-delete-confirm-button'); await until(async () => !(await dto(id)), 'original Sidebar deletes ' + id)
    if (recursive) assert.equal(await dto(id + '-grand'), null); else { assert(await dto(id + '-grand')); assert.equal((await dto(id + '-child')).parentSessionId, null) }
  }
  // A busy target is stopped and retried, not silently deleted or replayed.
  await message('live', 'CASE:held-provider'); await until(() => held.has('held-provider'), 'actual held provider')
  await message('live', 'queued work before deletion'); const busy = await remove('live', false, 409); assert.equal(busy.code, 'SESSION_DELETE_BUSY'); assert.equal(busy.droppedQueueItems, 1)
  await until(async () => idle(await dto('live')), 'busy target foreground stopped'); assert(held.get('held-provider').closed); assert(await dto('live')); await remove('live')
  // A retained background planner is not canceled on foreground Stop/retry; final idle retirement drains it.
  for (let index = 0; index < 7; index++) await send('background', 'seed-' + index, ('ordered-context-' + index + '-').repeat(400))
  const compact = await message('background', '/compact', 200); assert.equal(compact.success, true); await until(() => held.has('plan'), 'actual background planner')
  await message('background', 'CASE:held-background'); await until(() => held.has('held-background'), 'foreground held alongside planner')
  await remove('background', false, 409); await until(async () => idle(await dto('background')), 'foreground drained without planner cancellation'); assert.equal(held.get('plan').closed, false)
  await remove('background'); await until(() => held.get('plan').closed, 'only final retirement cancels planner'); assert.equal(await dto('background'), null)
  // Real primary empty authority takes precedence over selected older migration evidence.
  await writeFile(channelsFile, JSON.stringify({ channels: {} })); await writeFile(join(state, 'sessions.json.pre-catalog-sqlite-v1.bak'), JSON.stringify({ channelAttachments: { 'discord:old': 'worker-target' } }))
  const workerFile = join(state, 'session-runtime.sqlite')
  execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/session-delete-worker-fixture-ts.mjs'), workerFile, 'active', 'worker-target'], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
  const activeWorker = await remove('worker-target', false, 409); assert.equal(activeWorker.code, 'SESSION_DELETE_WORKER_UNSUPPORTED'); assert(await dto('worker-target'))
  let db = new DatabaseSync(workerFile); db.exec("UPDATE session_worker_ownership SET state='inactive',incarnation_id=NULL WHERE session_id='worker-target'; PRAGMA user_version=1"); db.close()
  await remove('worker-target', false, 500); db = new DatabaseSync(workerFile); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); db.exec('PRAGMA user_version=2; DROP INDEX idx_session_worker_mailbox_pending'); db.close()
  await remove('worker-target', false, 500); db = new DatabaseSync(workerFile); assert(!db.prepare("SELECT name FROM sqlite_master WHERE name='idx_session_worker_mailbox_pending'").get()); db.exec('CREATE INDEX idx_session_worker_mailbox_pending ON session_worker_mailbox(session_id,id) WHERE applied_at IS NULL'); db.close()
  const inactive = await remove('worker-target'); assert.deepEqual(inactive.workerRowsRemovedSessionIds, ['worker-target'])
  execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/session-delete-worker-fixture-ts.mjs'), workerFile, 'orphan', 'worker-orphan'], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
  const orphan = await remove('worker-orphan'); assert.deepEqual(orphan.workerRowsRemovedSessionIds, [])
  db = new DatabaseSync(workerFile, { readOnly: true }); assert.equal(db.prepare("SELECT COUNT(*) n FROM session_worker_mailbox WHERE session_id='worker-orphan'").get().n, 1); assert(!db.prepare("SELECT * FROM session_worker_ownership WHERE session_id='worker-orphan'").get()); db.close()
  // Launched shell/output are preserved while only exact tracking/callback ownership retires.
  const execRecords = async () => JSON.parse(await readFile(join(state, 'running-exec.json'), 'utf8')).execs
  async function launch(id) {
    await send(id, id); const current = await saved(id)
    const result = current.history.flatMap(row => row.parts || []).map(part => part.functionResponse?.response?.output || '').find(value => value.includes('execId:'))
    const execId = result?.match(/execId: ([a-z-]+)/)?.[1]
    assert(execId)
    const record = (await execRecords()).find(record => record.id === execId && record.sessionId === id)
    assert(record); shells.push(record.pid); return record
  }
  const liveFolder = await launch('exec-live'), finishedFolder = await launch('exec-finished')
  await remove('exec-live'); assert.equal((await execRecords()).some(record => record.id === liveFolder.id), false); await access(liveFolder.logPath)
  socket.close(); await fixture.stop(); await writeFile(join(fixture.work, 'exec-finished-release'), '')
  await until(() => access(finishedFolder.statusPath).then(() => true, () => false), 'one shell naturally finishes with no host')
  const prior = records.length; await fixture.start(); await until(() => counts.get('exec-finished') === 3, 'only real retained recipient receives completion')
  await writeFile(join(fixture.work, 'exec-live-release'), ''); await until(() => access(liveFolder.statusPath).then(() => true, () => false), 'deleted recipient shell is not killed or replayed')
  assert.equal(counts.get('exec-live'), 2); assert.equal(await dto('exec-live'), null); assert(records.length > prior)
  // Request arrival is observable before the resumed answer commits or its processor settles.
  const completion = held.get('retained-completion'); assert(completion && !completion.closed)
  assert.equal(idle(await dto('exec-finished')), false); assert.equal(await finals('exec-finished', 'exec-finished'), 1)
  completion.complete(final('DONE-exec-finished')); await done('exec-finished', 'exec-finished', 2)
  await remove('exec-finished')
  const badFolder = await launch('exec-bad'); await message('wait-sibling', 'CASE:wait-sibling')
  await until(async () => (await saved('wait-sibling')).meta.wait && !(await dto('wait-sibling')).busy, 'actual persisted wait declaration')
  await fixture.stop(); const execAuthority = await readFile(fileFor('exec-bad'), 'utf8'); await unlink(fileFor('exec-bad')); await writeFile(join(fixture.work, 'exec-bad-release'), '')
  await until(() => access(badFolder.statusPath).then(() => true, () => false), 'bad recipient shell naturally finishes'); await sleep(2100)
  const pendingArchive = audit()[0].filter(row => row.session_id === 'exec-bad')
  await fixture.start()
  await until(() => counts.get('wait-sibling') === 2, 'healthy deadline resumes with an unavailable exec recipient')
  assert.equal((await fixture.api('GET', route('wait-sibling') + '/state')).status, 200)
  for (const [method, path, body] of [['GET', '/history'], ['POST', '/message', { text: 'must not admit input without authority' }]]) {
    const unavailable = await fixture.api(method, route('exec-bad') + path, body)
    assert.equal(unavailable.status, 500)
    if (method === 'GET') assert.equal(unavailable.body.code, 'SESSION_STATE_UNAVAILABLE')
    else assert.equal(unavailable.body.status, 500) // Message ingress retains its Problem response envelope.
    const diagnostic = method === 'GET' ? unavailable.body.error : unavailable.body.detail
    assert.match(diagnostic, /state\/sessions\/exec-bad\.json/)
  }
  assert.match(fixture.output, /Session recovery failed:/)
  await assert.rejects(readFile(fileFor('exec-bad')), { code: 'ENOENT' })
  assert.equal(counts.get('exec-bad'), 2)
  assert.deepEqual(audit()[0].filter(row => row.session_id === 'exec-bad'), pendingArchive)
  assert((await execRecords()).some(record => record.id === badFolder.id)) // No failed-recipient acknowledgement.
  await writeFile(fileFor('exec-bad'), execAuthority)
  assert.equal((await fixture.api('GET', route('exec-bad') + '/history')).status, 200)
  await until(() => counts.get('exec-bad') === 3, 'ordinary repaired admission receives the retained completion')
  await until(async () => !(await execRecords()).some(record => record.id === badFolder.id), 'completion is acknowledged only after delivery')
  assert.equal(counts.get('wait-sibling'), 2)
  await until(async () => !(await dto('exec-bad')).busy && !(await dto('wait-sibling')).busy, 'final resumed recipients idle')
  const executed = (await readFile(join(fixture.work, 'deletion-executions'), 'utf8')).trim().split('\n').sort(); assert.deepEqual(executed, ['exec-bad', 'exec-finished', 'exec-live'])
  assert.equal(await readFile(independent, 'utf8'), '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}'); assert.deepEqual(errors, [])
  await writeFile(join(fixture.root, 'provider-records.json'), JSON.stringify(records.map(({ body, key, n, planning, closed }) => ({ body, key, n, planning, closed }))))
  await writeFile(join(fixture.root, 'frames.json'), JSON.stringify(frames)); await fixture.stop()
  console.log(JSON.stringify({ ok: true, root: fixture.root, requests: records.length, hostPids: fixture.hostPids, shellPids: shells, coldSurvivors: coldBytes.size, localRecoveryIsolation: true, missingAuthorityNotRebuilt: true, healthyDeadlineContinues: true, failedExecNotAcknowledged: true, repairedCompletionWithoutReplay: true }))
} catch (error) { console.error(fixture.output); throw error } finally {
  await writeFile(join(fixture.root, 'owned-hosts.json'), JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids, shellPids: shells })).catch(() => {})
  await writeFile(join(fixture.root, 'provider-records.json'), JSON.stringify(records.map(({ body, key, n, planning, closed }) => ({ body, key, n, planning, closed })))).catch(() => {})
  console.log('Owned deletion hosts: ' + JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids, shellPids: shells }))
  for (const key of ['exec-live', 'exec-finished', 'exec-bad']) await writeFile(join(fixture.work, key + '-release'), '').catch(() => {})
  for (const record of held.values()) record.complete(final('cleanup'))
  peer.closeAllConnections?.(); await new Promise(done => peer.close(done)); socket?.terminate(); await fixture.cleanup()
}
