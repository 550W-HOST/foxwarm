// Original Sidebar/Architecture and Chat over real Main-owned presentation transactions.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const fixture = await createHostFixture('presentation-app'), route = id => '/api/sessions/' + encodeURIComponent(id)
const requests = [], held = new Map(), frames = [], errors = []
let socket, blocker, page
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary'
    const record = { key, body }; requests.push(record)
    record.complete = () => { if (response.writableEnded || response.destroyed) return; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'presentation-' + requests.length, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }], usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n') }
    if (key.startsWith('held-')) held.set(key, record); else record.complete()
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const state = join(fixture.data, 'state'), sessions = join(state, 'sessions'), faults = join(state, 'experiment-faults'), rows = []
await mkdir(sessions, { recursive: true }); await mkdir(faults, { recursive: true }); await writeFile(join(faults, 'record-admissions'), '')
async function seed(id, extra = {}, authority = {}) {
  rows.push({ id, agent: 'main', aliases: [], busy: false, queueLength: 0, meta: { lastMessageTime: 100, messageCount: 0 }, ...extra })
  await writeFile(join(sessions, id + '.json'), JSON.stringify({ sessionStateVersion: 1, id, agent: 'main', model: 'a', busy: false, stopping: false, history: [], queue: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, meta: { lastMessageTime: 100, messageCount: 0 }, historyVersion: 0, lastAppliedMailboxId: 0,
    nextMessageSeq: 1, nextBlockId: 1, persistentMemorySnapshot: 'Existing seed snapshot', promptCacheKey: '00000000000000000000000000000001', parentSessionId: 'old-context-copy', ...authority }))
}
await seed('root', { displayName: 'Presentation root', aliases: ['root-alias'] })
await seed('child', { parentSessionId: 'root', pinned: true }); await seed('grandchild', { parentSessionId: 'child', archived: true })
await seed('target'); await seed('live'); await seed('ui-child', { parentSessionId: 'root' })
await seed('foreign', { currentNode: 'unsupported-node' }, { currentNode: 'unsupported-node' }); await seed('missing'); await unlink(join(sessions, 'missing.json'))
await seed('self', { parentSessionId: 'self' }); await seed('x', { parentSessionId: 'y' }); await seed('y', { parentSessionId: 'x' })
await seed('A'); await seed('B', { aliases: ['A', 'shared'] }); await seed('C', { aliases: ['shared'] }); await seed('alias-child', { parentSessionId: 'A' }); await seed('ambiguous-child', { parentSessionId: 'shared' })
for (let index = 0; index < 1000; index++) await seed('cold-' + String(index).padStart(4, '0'), { parentSessionId: 'root', archived: index === 500, pinned: index === 700 })
const catalogModule = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
const catalog = new catalogModule.SessionCatalogStore(join(state, 'catalog.sqlite')); catalog.initializeEmpty(); catalog.replaceAll(rows); catalog.close()
const seedFile = join(fixture.root, 'seed.json'); await writeFile(seedFile, JSON.stringify(rows))
execFileSync('node', [resolve('dotnet/session-catalog-seed-ts.mjs'), fixture.data, seedFile], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const database = join(state, 'catalog.sqlite')
function sql(text, args = []) { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare(text).all(...args) } finally { db.close() } }
function retained() { const db = new DatabaseSync(join(state, 'archive-store.sqlite'), { readOnly: true }); try { return ['archive_messages', 'archive_blocks', 'archive_branches'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()) } finally { db.close() } }
async function dto(id) { const result = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] }); assert.equal(result.status, 200); return result.body.results[0].session }
async function action(id, name, body = {}, status = 200) { const result = await fixture.api('POST', route(id) + '/' + name, body); assert.equal(result.status, status, JSON.stringify(result)); return result.body }
async function command(id, text) { return action(id, 'message', { text }) }
const observations = async () => (await readFile(join(faults, 'record-admissions.events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
const originals = new Map()
for (const row of rows.filter(row => row.id !== 'missing')) originals.set(row.id, await readFile(join(sessions, row.id + '.json'), 'utf8'))
const initialRetained = retained()
try {
  await fixture.start()
  const archiveBytes = await readFile(join(state, 'archive-store.sqlite'))
  socket = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-presentation-app-api' } })
  socket.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: [], sessionListIds: ['root', 'child', 'foreign'], sessionListActive: true }))
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied'), 'Main-only watch applied')
  const first = await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2'), cursor = first.body.nextCursor
  const archived = await action('root-alias', 'archive', { includeDescendants: true })
  assert.equal(archived.matchedCount, 1004); assert.equal(archived.changedCount, 1002); assert(archived.matchedSessionIds.includes('grandchild'))
  const unarchived = await action('root', 'archive', { archived: false, includeDescendants: true }); assert.deepEqual(unarchived.matchedSessionIds, ['root']); assert.equal(unarchived.includeDescendants, false); assert.equal((await dto('child')).archived, true)
  await action('foreign', 'pin', { pinned: true }); await action('missing', 'archive', {})
  await command('foreign', '/session unarchive missing'); await command('foreign', '/session parent target child'); await command('foreign', '/session unparent child')
  await action('child', 'move', { parentSessionId: 'root', position: 'last' }); assert.equal(sql("SELECT COUNT(*) n FROM session_catalog WHERE parent_reference='root' AND sidebar_order IS NOT NULL")[0].n, 1002)
  const ranksBefore = sql("SELECT session_id,sidebar_order FROM session_catalog WHERE parent_reference='root' ORDER BY session_id")
  await action('child', 'move', { parentSessionId: 'target', updateOrder: false }); assert.deepEqual(sql("SELECT session_id,sidebar_order FROM session_catalog WHERE parent_reference='root' ORDER BY session_id"), ranksBefore.filter(row => row.session_id !== 'child'))
  await action('child', 'promote', { targetParentId: null }); assert.equal((await dto('child')).parentSessionId, null)
  await action('self', 'archive', { includeDescendants: true }, 409); await action('x', 'archive', { includeDescendants: true }, 409)
  await action('self', 'pin', { pinned: true }); await action('self', 'archive', {})
  const exactTree = await action('A', 'archive', { includeDescendants: true }); assert.deepEqual(exactTree.matchedSessionIds, ['A', 'alias-child']); assert.equal((await dto('B')).archived, false); assert.equal((await dto('ambiguous-child')).archived, false)
  await action('root', 'move', { parentSessionId: 'ui-child' }, 400)
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2&cursor=' + encodeURIComponent(cursor))).body.reset, true)
  await until(() => frames.some(frame => frame.type === 'session-list-invalidated'), 'committed mutation invalidates watch')
  assert.deepEqual(await observations(), []); assert.equal(requests.length, 0)
  for (const [id, bytes] of originals) assert.equal(await readFile(join(sessions, id + '.json'), 'utf8'), bytes, id + ' byte-identical')
  assert.deepEqual(retained(), initialRetained); assert.deepEqual(await readFile(join(state, 'archive-store.sqlite')), archiveBytes)
  const foreignHistory = await fixture.api('GET', route('foreign') + '/history')
  assert.equal(foreignHistory.status, 200); assert.equal(foreignHistory.body.session.currentNode, 'unsupported-node')
  assert.equal((await fixture.api('GET', route('missing') + '/history')).status, 500)
  const beforeFault = sql('SELECT metadata_json,parent_session_id,sidebar_order FROM session_catalog ORDER BY session_id'), revision = (await fixture.api('GET', '/api/session-list/sidebar?limit=3')).body.presentationRevision
  blocker = new DatabaseSync(database); blocker.exec('BEGIN IMMEDIATE')
  await action('root', 'archive', { includeDescendants: true }, 500); await action('ui-child', 'move', { parentSessionId: 'target' }, 500)
  assert.deepEqual(sql('SELECT metadata_json,parent_session_id,sidebar_order FROM session_catalog ORDER BY session_id'), beforeFault)
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=3')).body.presentationRevision, revision)
  blocker.exec('ROLLBACK'); blocker.close(); blocker = null
  await action('root', 'archive', { archived: false }); await action('ui-child', 'archive', { archived: false })
  page = await fixture.openApp(); await page.setViewport({ width: 1440, height: 1200 }); page.on('response', async response => { if (/\/descendants\//.test(response.url())) console.log('Original UI descendants: ' + response.status() + ' ' + await response.text().catch(() => '')) }); page.on('request', request => { if (/\/(archive|pin|move|promote)$/.test(request.url())) console.log('Original UI action: ' + request.url().slice(fixture.origin.length) + ' ' + (request.postData() || '')) }); await page.evaluate(() => window.foxwarmTest.switchToSession('live')); await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.innerText.includes('session live')); await sleep(350)
  const commandHistory = await readFile(join(sessions, 'live.json'), 'utf8'), commandAudit = retained()
  await page.evaluate(() => window.foxwarmTest.sendMessage('/session archive target'))
  await until(async () => (await page.evaluate(() => document.body.innerText)).includes('target') && (await page.evaluate(() => document.body.innerText)).includes('archived.'), 'real Chat temporary command response')
  assert.equal(await readFile(join(sessions, 'live.json'), 'utf8'), commandHistory); assert.deepEqual(retained(), commandAudit); assert.equal(requests.length, 0)
  // Real Sidebar context menu and original pin/archive endpoints.
  await page.waitForSelector('[data-session-id="root"]'); await page.click('[data-session-id="root"]', { button: 'right' })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Pin to top')); await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Pin to top').click()); await until(async () => (await dto('root')).pinned, 'Sidebar pin committed')
  await page.waitForFunction(() => document.querySelector('[data-session-section="pinned"] [data-session-id="root"]')); await page.click('[data-session-id="root"]', { button: 'right' }); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Archive' && !node.disabled)); await page.evaluate(() => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Archive').click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Archive session')); await page.evaluate(() => { const modal = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Archive session').parentElement.parentElement; modal.querySelector('input[type=checkbox]').click() }); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => /^Archive \d+ sessions$/.test(node.textContent.trim()))); await page.evaluate(() => [...document.querySelectorAll('button')].find(node => /^Archive \d+ sessions$/.test(node.textContent.trim())).click()); await until(async () => (await dto('root')).archived, 'Sidebar explicit recursive archive committed')
  await action('root', 'archive', { archived: false }); await action('root', 'pin', { pinned: false }); await action('ui-child', 'archive', { archived: false })
  await action('target', 'archive', { archived: false }); await page.evaluate(() => window.foxwarmTest.switchToSession('ui-child'))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.innerText.includes('session ui-child'))
  await page.evaluate(() => { location.hash = 'architecture' }); await page.waitForSelector('.foxwarm-architecture-surface-tab'); await page.waitForSelector('[data-session-id="ui-child"]')
  await page.click('button[aria-label^="Session list mode"]'); await page.waitForFunction(() => document.querySelector('button[aria-label^="Session list mode"]')?.getAttribute('aria-label') === 'Session list mode: Time')
  await sleep(500)
  await page.$eval('[data-session-id="ui-child"]', node => node.scrollIntoView({ block: 'nearest' })); await sleep(200)
  const rectangles = await page.evaluate(() => ['ui-child', 'target'].map(id => { const r = document.querySelector('[data-session-id="' + id + '"]')?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height } }))
  const [a, b] = rectangles; assert(a && b); console.log('Original drag rectangles: ' + JSON.stringify(rectangles))
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(a.x + 12, a.y + 12, { steps: 5 }); await sleep(200)
  // Activating a drag displays the original root-drop area and changes row positions.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await page.$eval('[data-session-id="target"]', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await page.mouse.move(current.x, current.y, { steps: attempt ? 2 : 12 }); if (attempt < 2) await sleep(100)
  }
  await page.mouse.up()
  await until(async () => (await dto('ui-child')).parentSessionId === 'target', 'actual Sidebar parent drag with Architecture mounted')
  await page.evaluate(() => { location.hash = 'chat' })
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionIds: ['live'], sessionListIds: ['live'], sessionListActive: true })); await until(() => frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 2), 'real warm subscription')
  assert.equal((await fixture.api('POST', route('live') + '/message', { text: 'CASE:held-provider' })).status, 202); await until(() => held.has('held-provider'), 'real held provider')
  await action('live', 'archive', {}); await action('live', 'pin', { pinned: true }); await action('live', 'move', { parentSessionId: 'target', updateOrder: false }); assert.equal((await dto('live')).busy, true)
  held.get('held-provider').complete(); await until(async () => !(await dto('live')).busy, 'provider drains without archive Stop')
  assert.equal((await dto('live')).archived, true); assert.equal((await dto('live')).parentSessionId, 'target')
  const hold = join(faults, 'id_' + Buffer.from('live').toString('base64url') + '.canonical-hold-before-rename'); await writeFile(hold, 'hold')
  assert.equal((await fixture.api('POST', route('live') + '/message', { text: 'CASE:held-save' })).status, 202)
  await until(async () => await readFile(hold + '.reached', 'utf8').catch(() => '') === 'reached', 'real JSON canonical publication held')
  await action('live', 'move', { parentSessionId: 'root', updateOrder: false }); await action('live', 'archive', { archived: false }); await action('live', 'pin', { pinned: false }); await unlink(hold)
  await until(() => held.has('held-save'), 'held save proceeds to provider'); held.get('held-save').complete(); await until(async () => !(await dto('live')).busy, 'held save completes')
  assert.equal((await dto('live')).parentSessionId, 'root'); assert.equal((await dto('live')).archived, false); assert.equal((await dto('live')).pinned, false)
  const audit = new DatabaseSync(join(state, 'archive-store.sqlite'), { readOnly: true })
  try { assert.equal(audit.prepare("SELECT COUNT(*) n FROM archive_messages WHERE session_id='live'").get().n, 4) } finally { audit.close() }
  socket.close(); await once(socket, 'close'); socket = null
  const beforeRestart = (await fixture.api('GET', '/api/session-list/sidebar?limit=3')).body.nextCursor
  await fixture.stop(); await fixture.start()
  assert.equal((await dto('live')).parentSessionId, 'root'); assert.equal((await dto('live')).archived, false); assert.equal((await dto('live')).pinned, false)
  assert.equal((await fixture.api('GET', '/api/session-list/sidebar?limit=3&cursor=' + encodeURIComponent(beforeRestart))).body.reset, true)
  assert.equal(sql('SELECT session_count FROM catalog_count')[0].session_count, rows.length); assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(join(fixture.root, 'synthetic-peer-records.json'), JSON.stringify(requests.map(row => ({ key: row.key, body: row.body })))); await writeFile(join(fixture.root, 'presentation-frames.json'), JSON.stringify(frames))
  console.log(JSON.stringify({ requests: requests.length, members: rows.length, zeroOwnerPresentation: true, coldJsonArchiveUnchanged: true, wholeGroups: true, actualChatCommands: true, actualSidebarArchitecture: true, realSQLiteAtomicFailure: true, heldSaveMainWins: true, hostPids: fixture.hostPids, peerPid: process.pid, root: fixture.root }))
} catch (error) { if (page) console.error('Original UI: ' + JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, rows: [...document.querySelectorAll('[data-session-id]')].map(node => node.dataset.sessionId) })).catch(() => ({})))); console.error(fixture.output); console.error('Owned root: ' + fixture.root + '\nOwned PIDs: ' + JSON.stringify(fixture.hostPids)); throw error }
finally { if (blocker) { blocker.exec('ROLLBACK'); blocker.close() } socket?.close(); for (const record of held.values()) record.complete(); await fixture.cleanup(); peer.close(); peer.closeAllConnections() }
