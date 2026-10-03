// Original App and actual provider/tool/session lifetimes over Main-local coordinated deletion.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, rename, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const fixture = await createHostFixture('deletion-app'), route = id => '/api/sessions/' + encodeURIComponent(id)
const records = [], errors = [], held = new Map(), frames = [], counts = new Map(), shells = []
let socket, page, writer
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
    if (key.startsWith('held-')) { held.set(key, record); return }
    if (key === 'model-delete' && n < 2) {
      record.complete(n === 0 ? [call('discover-delete', 'search_tools', { query: 'delete_session', sources: ['builtin'], limit: 5 })]
        : [call('registry-delete', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'registry-target' } })]); return
    }
    if (key === 'source-child' && n === 0) { record.complete([call('delete-parent', 'call_tool', { source: 'builtin', name: 'delete_session', args: { sessionId: 'parent-model' } })]); return }
    if (key === 'self' && n === 0) { record.complete([call('self-delete', 'delete_session', { sessionId: 'source-alias' })]); return }
    if (key === 'isolated' && n === 0) { record.complete([call('isolated-delete', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'isolated-target' } })]); return }
    if (key.startsWith('reciprocal-') && n === 0) {
      held.set(key, record); return
    }
    if (key === 'reciprocal-b' && n === 1) { held.set('paired-b', record); return }
    if (key === 'wait-sibling' && n === 0) { record.complete([call(key, 'wait', { wakeIfNoActivityAfterSeconds: 2 })]); return }
    if (key.startsWith('exec-') && n === 0) {
      record.complete([call(key, 'exec', { command: `printf '${key}\\n' >> deletion-executions; while [ ! -f ${key}-release ]; do sleep 0.05; done; printf '${key}-finished\\n'`, timeout: 1 })]); return
    }
    record.complete(final('DONE-' + key))
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
// This focused deletion probe owns no startup task; the producer is covered by experimentHostOnboot.
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000, asyncCompact: true } } })
const state = join(fixture.data, 'state'), sessions = join(state, 'sessions'), faults = join(state, 'experiment-faults'), rows = [], legacy = new Set()
await mkdir(sessions, { recursive: true }); await mkdir(faults, { recursive: true }); await writeFile(join(faults, 'record-admissions'), '')
await mkdir(join(fixture.work, 'agents', 'locked', 'memory'), { recursive: true })
await writeFile(join(state, 'agents.json'), JSON.stringify({ version: 2, agents: ['locked'], metadata: { locked: { isolated: true } } }))
async function seed(id, metadata = {}, extra = {}, reserve = true) {
  const agent = id.includes('/') ? id.split('/')[0] : 'main'
  rows.push({ id, agent, aliases: [], busy: false, queueLength: 0, meta: { lastMessageTime: 100, messageCount: 0 }, ...metadata })
  const path = join(sessions, id + '.json'); await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionStateVersion: 1, id, agent, model: 'a', busy: false, stopping: false, history: [], queue: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: 100, messageCount: 0 }, historyVersion: 0,
    lastAppliedMailboxId: 0, nextMessageSeq: 1, nextBlockId: 1, persistentMemorySnapshot: 'Existing selected snapshot', promptCacheKey: '00000000-0000-0000-0000-000000000001', ...extra }))
  if (!reserve) legacy.add(id)
}
await seed('root', { aliases: ['root-alias'] })
for (let index = 0; index < 1000; index++) await seed('cold-' + String(index).padStart(4, '0'), { parentSessionId: 'root', archived: index === 500, pinned: index === 700 })
await seed('foreign-child', { parentSessionId: 'root', currentNode: 'unsupported-node' }, { currentNode: 'unsupported-node' })
for (const id of ['source', 'registry-target', 'isolated-target', 'command-target', 'live', 'background', 'reciprocal-a', 'reciprocal-b', 'exec-live', 'exec-finished', 'exec-bad', 'wait-sibling', 'late-save']) await seed(id, id === 'source' ? { aliases: ['source-alias'], pinned: true } : {})
await seed('locked/main'); await seed('parent-model'); await seed('child-source', { parentSessionId: 'parent-model' })
for (const root of ['00-ui-single', '00-ui-tree', 'tree', 'partial', 'bad-tree', 'queued-tree', 'partial-restart']) {
  await seed(root, { pinned: root.startsWith('00-') }); await seed(root + '-child', { parentSessionId: root, pinned: true }); await seed(root + '-grand', { parentSessionId: root + '-child', archived: true })
}
await seed('bad-tree-foreign', { parentSessionId: 'bad-tree', currentNode: 'other-node' }, { currentNode: 'other-node' })
await seed('legacy-source', {}, {}, false); await seed('legacy-target', {}, {}, false)
await seed('self-cycle', { parentSessionId: 'self-cycle' }); await seed('worker-target'); await seed('worker-orphan')
const catalogModule = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
const catalog = new catalogModule.SessionCatalogStore(join(state, 'catalog.sqlite')); catalog.initializeEmpty(); catalog.replaceAll(rows); catalog.close()
const seedFile = join(fixture.root, 'seed.json'); await writeFile(seedFile, JSON.stringify(rows.filter(row => !legacy.has(row.id))))
execFileSync('node', [resolve('dotnet/session-catalog-seed-ts.mjs'), fixture.data, seedFile], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const database = join(state, 'catalog.sqlite'), channelsFile = join(state, 'channels.json')
function sql(text, args = []) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare(text).all(...args) } finally { db.close() } }
function audit() { const db = new DatabaseSync(join(state, 'archive-store.sqlite'), { readOnly: true }); try { return ['archive_messages', 'archive_blocks', 'archive_branches'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()) } finally { db.close() } }
const saved = id => readFile(join(sessions, id + '.json'), 'utf8').then(JSON.parse)
async function dto(id) { const reply = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); assert.equal(reply.status, 200); return reply.body.results[0].session }
async function remove(id, recursive = false, status = 200) { const reply = await fixture.api('DELETE', route(id), { includeDescendants: recursive }); assert.equal(reply.status, status, JSON.stringify(reply)); return reply.body }
async function message(id, text, status = 202) { const reply = await fixture.api('POST', route(id) + '/message', { text }); assert.equal(reply.status, status, JSON.stringify(reply)); return reply.body }
async function done(id, key) { await until(async () => { const current = await dto(id); return current && !current.busy && (await saved(id)).history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) }, 'completed ' + key) }
async function send(id, key, extra = '') { await message(id, 'CASE:' + key + ' ' + extra); await done(id, key) }
const fileFor = id => join(sessions, id + '.json'), marker = (id, suffix) => join(faults, 'id_' + Buffer.from(id).toString('base64url') + '.' + suffix)
const observations = async () => (await readFile(join(faults, 'record-admissions.events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
const coldBytes = new Map(); for (const row of rows.filter(row => row.parentSessionId === 'root')) coldBytes.set(row.id, await readFile(fileFor(row.id), 'utf8'))
let retainedBefore = audit(); const independent = join(state, 'toolscript-runs', 'retained-run.json')
await mkdir(join(state, 'toolscript-runs'), { recursive: true }); await writeFile(independent, '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}')
try {
  await fixture.start()
  socket = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-deletion-app-api' } })
  socket.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: [], sessionListIds: ['root', 'source', 'tree'], sessionListActive: true }))
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied'), 'metadata-only initial subscriptions')
  assert.deepEqual(await observations(), ['created main']); assert.equal(records.length, 0)
  assert(audit()[2].some(row => row.session_id === 'main')); retainedBefore = audit()
  const cursor = (await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2')).body.nextCursor
  const single = await remove('root-alias'); assert.deepEqual(single.deletedSessionIds, ['root']); assert.equal(single.detachedChildSessionIds.length, 1001)
  for (const [id, bytes] of coldBytes) { assert.equal(await readFile(fileFor(id), 'utf8'), bytes); assert.equal((await dto(id)).parentSessionId, null) }
  assert.deepEqual((await observations()).filter(line => line.startsWith('read ')), ['read root']); assert.equal((await fixture.api('GET', route('foreign-child') + '/history')).status, 500)
  assert.deepEqual(audit(), retainedBefore); assert.equal(await readFile(independent, 'utf8'), '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}')
  await until(() => frames.some(frame => frame.type === 'session-list-delta' && frame.deletedIds?.includes('root')), 'real live deletion list event')
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2&cursor=' + encodeURIComponent(cursor))).body.reset, true)
  await remove('root', false, 404); assert.equal((await fixture.api('POST', '/api/sessions', { sessionId: 'root' })).status, 400)
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
  await until(async () => !(await dto('live')).busy, 'busy target foreground stopped'); assert(held.get('held-provider').closed); assert(await dto('live')); await remove('live')
  // A retained background planner is not canceled on foreground Stop/retry; final idle retirement drains it.
  for (let index = 0; index < 7; index++) await send('background', 'seed-' + index, ('ordered-context-' + index + '-').repeat(400))
  await message('background', '/compact', 202); await until(() => held.has('plan'), 'actual background planner')
  await message('background', 'CASE:held-background'); await until(() => held.has('held-background'), 'foreground held alongside planner')
  await remove('background', false, 409); await until(async () => !(await dto('background')).busy, 'foreground drained without planner cancellation'); assert.equal(held.get('plan').closed, false)
  await remove('background'); await until(() => held.get('plan').closed, 'only final retirement cancels planner'); assert.equal(await dto('background'), null)
  // Reciprocal real model calls: only the cross-delete admission conflicts; paired saves remain legal.
  const reciprocalHold = marker('reciprocal-b', 'delete-prepare-hold'); await writeFile(reciprocalHold, 'hold')
  await Promise.all([message('reciprocal-a', 'CASE:reciprocal-a'), message('reciprocal-b', 'CASE:reciprocal-b')])
  await until(() => held.has('reciprocal-a') && held.has('reciprocal-b'), 'both actual model turns admitted')
  held.get('reciprocal-a').complete([call('delete-b', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'reciprocal-b' } })])
  await until(() => access(reciprocalHold + '.reached').then(() => true, () => false), 'first model holds deletion preparation')
  held.get('reciprocal-b').complete([call('delete-a', 'call_tool', { toolId: 'builtin:delete_session', args: { sessionId: 'reciprocal-a' } })])
  await until(() => held.has('paired-b'), 'reciprocal conflict has actual paired result before next provider')
  assert((await saved('reciprocal-b')).history.some(row => row.role === 'tool' && JSON.stringify(row).includes('SESSION_DELETE_CONFLICT')))
  await unlink(reciprocalHold); await done('reciprocal-a', 'reciprocal-a'); await until(async () => !(await dto('reciprocal-b')).busy, 'stopped reciprocal target finishes paired turn')
  assert(held.get('paired-b').closed); await remove('reciprocal-a'); await remove('reciprocal-b')
  // Real SQLite writer failure after unlink is a truthful partial, never a fake rollback.
  const partialRetained = audit(), hold = marker('partial', 'delete-catalog-hold'); await writeFile(hold, 'hold')
  const partialRequest = fixture.api('DELETE', route('partial'), {})
  await until(() => access(hold + '.reached').then(() => true, () => false), 'JSON unlinked before catalog removal')
  assert.equal(await access(fileFor('partial')).then(() => true, () => false), false)
  writer = new DatabaseSync(database); writer.exec('BEGIN IMMEDIATE'); await unlink(hold)
  const partial = await partialRequest; assert.equal(partial.status, 500); assert.equal(partial.body.failedStage, 'catalog'); assert.deepEqual(partial.body.deletedSessionIds, [])
  assert.deepEqual(partial.body.authorityRemovedSessionIds, ['partial']); assert.deepEqual(partial.body.detachedChildSessionIds, ['partial-child']); assert.deepEqual(partial.body.stillClaimedSessionIds, ['partial'])
  assert(await dto('partial')); assert.equal((await fixture.api('GET', route('partial') + '/history')).status, 500)
  writer.exec('ROLLBACK'); writer.close(); writer = null
  const retry = await remove('partial'); assert.equal(retry.continuedSameHost, true); assert.equal(await dto('partial'), null); assert.deepEqual(audit(), partialRetained)
  // Real primary empty authority takes precedence over selected older migration evidence.
  await writeFile(channelsFile, JSON.stringify({ channels: {} })); await writeFile(join(state, 'sessions.json.pre-catalog-sqlite-v1.bak'), JSON.stringify({ channelAttachments: { 'discord:old': 'worker-target' } }))
  const workerFile = join(state, 'session-runtime.sqlite')
  execFileSync('node', [resolve('dotnet/session-delete-worker-fixture-ts.mjs'), workerFile, 'active', 'worker-target'], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
  const activeWorker = await remove('worker-target', false, 409); assert.equal(activeWorker.code, 'SESSION_DELETE_WORKER_UNSUPPORTED'); assert(await dto('worker-target'))
  let db = new DatabaseSync(workerFile); db.exec("UPDATE session_worker_ownership SET state='inactive',incarnation_id=NULL WHERE session_id='worker-target'; PRAGMA user_version=1"); db.close()
  await remove('worker-target', false, 500); db = new DatabaseSync(workerFile); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); db.exec('PRAGMA user_version=2; DROP INDEX idx_session_worker_mailbox_pending'); db.close()
  await remove('worker-target', false, 500); db = new DatabaseSync(workerFile); assert(!db.prepare("SELECT name FROM sqlite_master WHERE name='idx_session_worker_mailbox_pending'").get()); db.exec('CREATE INDEX idx_session_worker_mailbox_pending ON session_worker_mailbox(session_id,id) WHERE applied_at IS NULL'); db.close()
  const inactive = await remove('worker-target'); assert.deepEqual(inactive.workerRowsRemovedSessionIds, ['worker-target'])
  execFileSync('node', [resolve('dotnet/session-delete-worker-fixture-ts.mjs'), workerFile, 'orphan', 'worker-orphan'], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
  const orphan = await remove('worker-orphan'); assert.deepEqual(orphan.workerRowsRemovedSessionIds, [])
  db = new DatabaseSync(workerFile, { readOnly: true }); assert.equal(db.prepare("SELECT COUNT(*) n FROM session_worker_mailbox WHERE session_id='worker-orphan'").get().n, 1); assert(!db.prepare("SELECT * FROM session_worker_ownership WHERE session_id='worker-orphan'").get()); db.close()
  // An exact cold read already accepted settles; all new mutation boundaries reject the claim.
  const coldHold = marker('queued-tree', 'admission-hold'), retirementHold = marker('queued-tree', 'delete-retire-hold')
  await writeFile(coldHold, 'hold'); const reading = fixture.api('GET', route('queued-tree') + '/history'); await until(() => access(coldHold + '.reached').then(() => true, () => false), 'real exact admission held')
  await writeFile(retirementHold, 'hold'); const deleting = fixture.api('DELETE', route('queued-tree'), {})
  await sleep(100); assert(await dto('queued-tree')); await unlink(coldHold); assert.equal((await reading).status, 200)
  await until(() => access(retirementHold + '.reached').then(() => true, () => false), 'same owner admission joins deletion')
  assert.equal((await fixture.api('POST', route('queued-tree') + '/message', { text: 'late mutation' })).status, 500)
  assert.notEqual((await fixture.api('POST', route('queued-tree') + '/continue')).status, 200)
  assert.notEqual((await fixture.api('POST', route('queued-tree') + '/fork', { suffix: 'late' })).status, 200)
  assert.notEqual((await fixture.api('POST', route('source') + '/move', { parentSessionId: 'queued-tree', updateOrder: false })).status, 200)
  await unlink(retirementHold); assert.equal((await deleting).status, 200); assert.equal(await dto('queued-tree'), null)
  // A committed creation row joins the same exact slot; delete cannot race a later owner publication.
  const createHold = marker('published-delete', 'creation-publication-hold'); await writeFile(createHold, 'hold')
  let creationFinished = false, deleteFinished = false
  const creating = fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'published-delete' }).then(reply => { creationFinished = true; return reply })
  await until(() => access(createHold + '.reached').then(() => true, () => false), 'actual creation authority and catalog before publication')
  const createdDeletion = fixture.api('DELETE', route('published-delete'), {}).then(reply => { deleteFinished = true; return reply })
  const lateFork = fixture.api('POST', route('published-delete') + '/fork', { suffix: 'late' })
  await send('source', 'creation-unrelated'); assert.equal(creationFinished, false); assert.equal(deleteFinished, false)
  await unlink(createHold); assert.equal((await creating).status, 200); assert.equal((await createdDeletion).status, 200); assert.notEqual((await lateFork).status, 200)
  assert.equal(await dto('published-delete'), null); assert.equal(await access(fileFor('published-delete')).then(() => true, () => false), false)
  assert.equal((await fixture.api('GET', route('published-delete') + '/history')).status, 404)
  // An accepted canonical publication drains ahead of target unlink; the late old save cannot resurrect it.
  const userHold = marker('late-save', 'canonical-hold-before-rename'); await writeFile(userHold, 'hold')
  await message('late-save', 'CASE:held-save'); await until(() => access(userHold + '.reached').then(() => true, () => false), 'actual canonical user rename held')
  let savedDeletionFinished = false
  const savedDeletion = fixture.api('DELETE', route('late-save'), {}).then(reply => { savedDeletionFinished = true; return reply })
  await sleep(80); assert.equal(savedDeletionFinished, false); await access(fileFor('late-save')); await unlink(userHold)
  const stoppedSave = await savedDeletion; assert.equal(stoppedSave.status, 409); await until(async () => !(await dto('late-save')).busy, 'accepted user write finishes before Stop')
  assert((await saved('late-save')).history.some(row => row.role === 'user' && JSON.stringify(row).includes('CASE:held-save')))
  await remove('late-save'); await sleep(100); assert.equal(await access(fileFor('late-save')).then(() => true, () => false), false); assert.equal(await dto('late-save'), null)

  // A read-old command source has no Archive rows; replacing its lifetime cannot continue its predecessor operation.
  const legacyTarget = fileFor('legacy-target'), legacyOriginal = legacyTarget + '.held', legacyHold = marker('legacy-target', 'delete-json-unlink-hold')
  await writeFile(legacyHold, 'hold'); const legacyCommand = fixture.api('POST', route('legacy-source') + '/message', { text: '/session delete legacy-target' })
  await until(() => access(legacyHold + '.reached').then(() => true, () => false), 'read-old source command at actual unlink boundary')
  await rename(legacyTarget, legacyOriginal); await mkdir(legacyTarget); await unlink(legacyHold); const legacyPartial = await legacyCommand; assert.equal(legacyPartial.status, 500)
  await remove('legacy-source'); const recreated = await fixture.api('POST', '/api/sessions', { sessionId: 'legacy-source' }); assert.equal(recreated.status, 200)
  await rm(legacyTarget, { recursive: true }); await rename(legacyOriginal, legacyTarget); const legacyBytes = await readFile(legacyTarget, 'utf8')
  const refused = await message('legacy-source', '/session delete legacy-target', 200); assert.equal(refused.result.code, 'SESSION_DELETE_RETRY_MISMATCH'); assert.equal(await readFile(legacyTarget, 'utf8'), legacyBytes)
  // No in-memory continuation survives restart; dormant metadata remains available, exact missing authority fails.
  const restartBytes = await readFile(fileFor('partial-restart'), 'utf8'), restartHold = marker('partial-restart', 'delete-catalog-hold')
  await writeFile(restartHold, 'hold'); const restartingDelete = fixture.api('DELETE', route('partial-restart'), {})
  await until(() => access(restartHold + '.reached').then(() => true, () => false), 'actual durable partial before restart')
  writer = new DatabaseSync(database); writer.exec('BEGIN IMMEDIATE'); await unlink(restartHold)
  const restartPartial = await restartingDelete; assert.equal(restartPartial.status, 500); assert.equal(restartPartial.body.failedStage, 'catalog')
  writer.exec('ROLLBACK'); writer.close(); writer = null; socket.close(); await fixture.stop()
  const beforeDormantRestart = records.length; await fixture.start(); assert.equal(records.length, beforeDormantRestart); assert(await dto('partial-restart'))
  assert.equal((await fixture.api('GET', route('partial-restart') + '/history')).status, 500)
  const noResume = await fixture.api('DELETE', route('partial-restart'), {}); assert.equal(noResume.status, 500); assert.equal(noResume.body.continuedSameHost, undefined)
  assert.equal(await access(fileFor('partial-restart')).then(() => true, () => false), false)
  await writeFile(fileFor('partial-restart'), restartBytes); const repaired = await remove('partial-restart'); assert.equal(repaired.continuedSameHost, undefined)

  // Launched shell/output are preserved while only exact tracking/callback ownership retires.
  async function launch(id) {
    await send(id, id); const current = await saved(id)
    const result = current.history.flatMap(row => row.parts || []).map(part => part.functionResponse?.response?.output || '').find(value => value.includes('execId:'))
    const execId = result?.match(/execId: ([a-z-]+)/)?.[1]
    assert(execId); const folder = join(state, 'exec', 'id_' + Buffer.from(id).toString('base64url'), execId)
    const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8')); shells.push(meta.Pid)
    await access(join(folder, 'tracking.json')); return folder
  }
  const liveFolder = await launch('exec-live'), finishedFolder = await launch('exec-finished')
  await remove('exec-live'); assert.equal(await access(join(liveFolder, 'tracking.json')).then(() => true, () => false), false); await access(join(liveFolder, 'output.log'))
  socket.close(); await fixture.stop(); await writeFile(join(fixture.work, 'exec-finished-release'), '')
  await until(() => access(join(finishedFolder, 'status.json')).then(() => true, () => false), 'one shell naturally finishes with no host')
  const prior = records.length; await fixture.start(); await until(() => counts.get('exec-finished') === 3, 'only real retained recipient receives completion')
  await writeFile(join(fixture.work, 'exec-live-release'), ''); await until(() => access(join(liveFolder, 'status.json')).then(() => true, () => false), 'deleted recipient shell is not killed or replayed')
  assert.equal(counts.get('exec-live'), 2); assert.equal(await dto('exec-live'), null); assert(records.length > prior); await remove('exec-finished')
  const badFolder = await launch('exec-bad'); await message('wait-sibling', 'CASE:wait-sibling')
  await until(async () => (await saved('wait-sibling')).meta.wait && !(await dto('wait-sibling')).busy, 'actual persisted wait declaration')
  await fixture.stop(); const execAuthority = await readFile(fileFor('exec-bad'), 'utf8'); await unlink(fileFor('exec-bad')); await writeFile(join(fixture.work, 'exec-bad-release'), '')
  await until(() => access(join(badFolder, 'status.json')).then(() => true, () => false), 'bad recipient shell naturally finishes'); await sleep(2100)
  const beforeFailure = records.length; await assert.rejects(fixture.start(), /missing|authority|Authority/); assert.equal(records.length, beforeFailure); await access(join(badFolder, 'tracking.json'))
  await writeFile(fileFor('exec-bad'), execAuthority); await fixture.start(); await until(() => counts.get('exec-bad') === 3 && counts.get('wait-sibling') === 2, 'only all-validated restart resumes deadline and exec delivery')
  await until(async () => !(await dto('exec-bad')).busy && !(await dto('wait-sibling')).busy, 'final resumed recipients idle')
  const executed = (await readFile(join(fixture.work, 'deletion-executions'), 'utf8')).trim().split('\n').sort(); assert.deepEqual(executed, ['exec-bad', 'exec-finished', 'exec-live'])
  assert.equal(await readFile(independent, 'utf8'), '{"status":"active","ownerSessionId":"root","relatedManagedSessions":["root"]}'); assert.deepEqual(errors, [])
  await writeFile(join(fixture.root, 'provider-records.json'), JSON.stringify(records.map(({ body, key, n, planning, closed }) => ({ body, key, n, planning, closed }))))
  await writeFile(join(fixture.root, 'frames.json'), JSON.stringify(frames)); await fixture.stop()
  console.log(JSON.stringify({ ok: true, root: fixture.root, requests: records.length, hostPids: fixture.hostPids, shellPids: shells, coldSurvivors: coldBytes.size }))
} finally {
  await writeFile(join(fixture.root, 'owned-hosts.json'), JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids, shellPids: shells })).catch(() => {})
  await writeFile(join(fixture.root, 'provider-records.json'), JSON.stringify(records.map(({ body, key, n, planning, closed }) => ({ body, key, n, planning, closed })))).catch(() => {})
  console.log('Owned deletion hosts: ' + JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids, shellPids: shells }))
  if (writer) { writer.exec('ROLLBACK'); writer.close() }
  for (const key of ['exec-live', 'exec-finished', 'exec-bad']) await writeFile(join(fixture.work, key + '-release'), '').catch(() => {})
  for (const record of held.values()) record.complete(final('cleanup'))
  peer.closeAllConnections?.(); await new Promise(done => peer.close(done)); socket?.terminate(); await fixture.cleanup()
}
