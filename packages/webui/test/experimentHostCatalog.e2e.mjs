import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, access, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const fixture = await createHostFixture('catalog-app'), route = id => '/api/sessions/' + encodeURIComponent(id)
const requests = [], held = new Map(), errors = [], frames = []
let socket, lock
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), text = JSON.stringify(body.input), key = [...text.matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary'
    const record = { body, key, response }; requests.push(record)
    record.complete = output => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'catalog-' + requests.length, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n') }
    if (key.startsWith('held-') && !requests.slice(0, -1).some(row => row.key === key)) held.set(key, record)
    else record.complete([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }])
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const model = { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 }, b: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire-b'], contextLimit: 20000 } } }
await writeModelFixture(fixture.data, model)
await mkdir(join(fixture.data, 'state/sessions'), { recursive: true }); await mkdir(join(fixture.work, 'agents/team/memory'), { recursive: true })
await writeFile(join(fixture.data, 'state/agents.json'), JSON.stringify({ version: 1, agents: ['team'] }))
const rows = []
function seed(id, time, extra = {}) {
  const agent = id.includes('/') ? id.split('/')[0] : 'main'
  const record = { id, agent, busy: false, queueLength: 0, model: 'b', meta: { messageCount: 0, lastMessageTime: time }, ...extra }; rows.push(record)
  return writeFile(join(fixture.data, 'state/sessions', id + '.json'), JSON.stringify({ sessionStateVersion: 1, id, agent, model: 'a', verbose: false, busy: false, history: [], queue: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null }, nextMessageSeq: 1, nextBlockId: 1, historyVersion: 0, meta: { messageCount: 0, lastMessageTime: time }, persistentMemorySnapshot: 'seed context', sessionCacheKey: '00000000-0000-0000-0000-000000000001', ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}), displayName: 'old context copy' }))
}
await mkdir(join(fixture.data, 'state/sessions/team'), { recursive: true })
await seed('root', 500, { displayName: 'Source root', aliases: ['root-alias', 'shared'], meta: { messageCount: 0, lastMessageTime: 500, lastChannel: { channelId: 'webui', channelUserId: 'synthetic-room' } } })
await seed('team/child', 490, { parentSessionId: 'root-alias', aliases: ['shared'] })
await seed('dangling', 40, { parentSessionId: 'missing-parent' }); await seed('self', 30, { parentSessionId: 'self' })
await seed('cycle-a', 20, { parentSessionId: 'cycle-b' }); await seed('cycle-b', 10, { parentSessionId: 'cycle-a' })
await seed('pin-child', 400, { parentSessionId: 'root', pinned: true }); await seed('archived', 100, { archived: true })
await seed('ordered', 1, { sidebarOrder: 1 }); for (const id of ['\ue000', '𐐀', '😀', 'İ', 'ΟΣ']) await seed(id, 50)
for (let index = 0; index < 300; index++) await seed('fan-' + String(index).padStart(3, '0'), 300 - index, { parentSessionId: 'root' })
const legacy = JSON.stringify({ sessions: Object.fromEntries(rows.map(row => [row.id, row])) }); await writeFile(join(fixture.data, 'state/sessions.json'), legacy)
const seedRows = join(fixture.root, 'rows.json'); await writeFile(seedRows, JSON.stringify(rows))
execFileSync('node', [resolve('dotnet/session-catalog-seed-ts.mjs'), fixture.data, seedRows], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
const catalogPath = join(fixture.data, 'state/catalog.sqlite')
function sql(statement, args = []) { const db = new DatabaseSync(catalogPath, { readOnly: true }); try { return db.prepare(statement).all(...args) } finally { db.close() } }
function readAuthority(id) { return readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse) }
async function exact(ids) { const reply = await fixture.api('POST', '/api/session-list/by-id', { ids }); assert.equal(reply.status, 200); return reply.body }
async function dto(id) { const value = await exact([id]); return value.results[0].session }
async function message(id, text) { assert.equal((await fixture.api('POST', route(id) + '/message', { text })).status, text.startsWith('/') ? 200 : 202) }
async function idle(id) { await until(async () => !(await dto(id)).busy, id + ' idle') }
function beginLock() { lock = new DatabaseSync(catalogPath); lock.exec('BEGIN IMMEDIATE') }
function releaseLock() { if (lock) { lock.exec('ROLLBACK'); lock.close(); lock = null } }
try {
  await fixture.start()
  assert.equal(await readFile(join(fixture.data, 'state/sessions.json.pre-catalog-sqlite-v1.bak'), 'utf8'), legacy)
  assert.equal(sql('SELECT session_count FROM catalog_count')[0].session_count, rows.length)
  assert.equal(sql('PRAGMA user_version')[0].user_version, 2)
  assert.equal((await dto('root')).model, 'a', 'current JSON semantic model wins old catalog')
  assert.equal((await dto('root')).displayName, 'Source root'); assert.equal((await readAuthority('root')).displayName, 'old context copy')
  const lookup = await exact(['root-alias', 'shared', 'missing', 'retained-not-live', 'dangling', 'self'])
  assert.equal(lookup.results[0].resolution.sessionId, 'root'); assert.equal(lookup.results[1].resolution.kind, 'ambiguous'); assert.equal(lookup.results[3].resolution.kind, 'missing')
  assert.equal(lookup.results[4].session.parentSessionId, null); assert.equal(lookup.results[5].session.parentSessionId, null)
  const paths = await fixture.api('POST', '/api/session-list/by-id', { ids: ['team/child', 'cycle-a'], includePaths: true }); assert.equal(paths.status, 200)
  assert.deepEqual(paths.body.paths['team/child'], ['root', 'team/child']); assert.equal(new Set(paths.body.paths['cycle-a']).size, paths.body.paths['cycle-a'].length)
  const first = await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2'); assert.equal(first.status, 200); assert(first.body.nextCursor)
  const second = await fixture.api('GET', '/api/session-list/sidebar?limit=3&childLimit=2&cursor=' + encodeURIComponent(first.body.nextCursor)); assert.equal(second.body.reset, false)
  assert.equal(new Set([...first.body.sessions, ...second.body.sessions].map(row => row.id)).size, first.body.sessions.length + second.body.sessions.length)
  const defaultChildren = await fixture.api('POST', '/api/session-list/children', { parents: [{ parentSessionId: 'root' }] }); assert.equal(defaultChildren.body.children[0].sessions.length, 10);
  for (const [body, code] of [[{ mode: null, parents: [] }, 'SESSION_LIST_MODE_INVALID'], [{ agent: 'team', parents: [] }, 'SESSION_LIST_MODE_INVALID'], [{ mode: 'time', agent: null, parents: [] }, 'SESSION_LIST_AGENT_INVALID'], [{ parents: [{ parentSessionId: 'root', cursor: null }] }, 'SESSION_LIST_CHILDREN_INVALID']]) {
    const invalid = await fixture.api('POST', '/api/session-list/children', body); assert.equal(invalid.status, 400); assert.equal(invalid.body.code, code);
  }
  const child = await fixture.api('POST', '/api/session-list/children', { parents: [{ parentSessionId: 'root' }], mode: 'time', limit: 2 }); assert.equal(child.status, 200)
  assert.equal(child.body.children[0].total, 301); assert(child.body.children[0].nextCursor)
  const continued = await fixture.api('POST', '/api/session-list/children', { parents: [{ parentSessionId: 'root', cursor: child.body.children[0].nextCursor }], mode: 'time', limit: 2 }); assert.equal(continued.body.reset, false)
  assert.notDeepEqual(child.body.children[0].sessions.map(row => row.id), continued.body.children[0].sessions.map(row => row.id))
  const upper = await fixture.api('GET', '/api/session-list/search?q=' + encodeURIComponent('i\u0307')); assert(upper.body.sessions.some(row => row.id === 'İ'))
  const sigma = await fixture.api('GET', '/api/session-list/search?q=' + encodeURIComponent('ος')); assert(sigma.body.sessions.some(row => row.id === 'ΟΣ'))
  assert.equal((await fixture.api('GET', '/api/session-list/search?q=%20')).body.code, 'SESSION_LIST_SEARCH_INVALID')
  assert(sql("EXPLAIN QUERY PLAN SELECT metadata_json FROM session_catalog WHERE parent_session_id='root' AND pinned=0 ORDER BY archived,recent_rank,session_id LIMIT 3").some(row => /idx_session_catalog_parent_time/.test(row.detail)))
  const page = await fixture.openApp(); await page.evaluate(() => { location.hash = 'architecture' })
  await page.waitForSelector('.foxwarm-architecture-surface-tab'); await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Agents').click()); await page.waitForSelector('[data-architecture-agent-id="team"]'); await page.evaluate(() => { location.hash = 'chat' }); await page.waitForSelector('.foxwarm-chat-root')
  assert.equal(await page.evaluate(() => Boolean(window.foxwarmTest?.switchToSession)), true)
  await page.evaluate(() => window.foxwarmTest.switchToSession('root')); await until(async () => await page.evaluate(() => document.body.innerText.includes('Source root')), 'original Sidebar source name')
  socket = new WebSocket(fixture.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-catalog-app-api' } }); socket.on('message', raw => frames.push(JSON.parse(raw)))
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: [], sessionListIds: ['root-alias', 'shared', 'missing'], sessionListActive: true }))
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied'), 'metadata watch applied')
  const accepted = frames.find(frame => frame.type === 'subscriptions-accepted'); assert.equal(accepted.sessionListResolutions['root-alias'], 'root'); assert.equal(accepted.sessionListResolutions.shared, undefined)
  assert(!frames.some(frame => ['session-state', 'session-history', 'queue-updated'].includes(frame.type)), 'metadata watch never reads semantic subscription')
  const unchanged = await readFile(join(fixture.data, 'state/sessions/root.json'), 'utf8')
  assert.equal((await fixture.api('POST', route('root') + '/name', { name: 'Main named root' })).status, 200)
  assert.equal(await readFile(join(fixture.data, 'state/sessions/root.json'), 'utf8'), unchanged)
  await until(() => frames.some(frame => frame.type === 'session-list-delta' && frame.sessions.some(row => row.displayName === 'Main named root')), 'catalog-only name watch')
  const reset = await fixture.api('GET', '/api/session-list/sidebar?limit=3&cursor=' + encodeURIComponent(first.body.nextCursor)); assert.equal(reset.body.reset, true)
  beginLock(); const failed = await fixture.api('POST', route('root') + '/model', { model: 'b' }); assert.notEqual(failed.status, 200)
  assert.equal((await readAuthority('root')).model, 'b'); assert.equal(JSON.parse(sql("SELECT metadata_json FROM session_catalog WHERE session_id='root'")[0].metadata_json).model, 'a')
  assert.equal((await dto('root')).model, 'b'); assert.equal((await dto('root')).busy, false); releaseLock()
  assert.equal((await fixture.api('POST', route('root') + '/model', { effort: 'low' })).status, 200)
  assert.equal(JSON.parse(sql("SELECT metadata_json FROM session_catalog WHERE session_id='root'")[0].metadata_json).model, 'b')
  beginLock(); const partial = await fixture.api('POST', '/api/sessions', {}); assert.equal(partial.status, 409); assert.equal(partial.body.committed, true); assert(partial.body.sessionId)
  assert.equal(sql('SELECT COUNT(*) AS n FROM session_catalog WHERE session_id=?', [partial.body.sessionId])[0].n, 0); await readAuthority(partial.body.sessionId); releaseLock()
  assert.equal((await fixture.api('POST', route(partial.body.sessionId) + '/model', { effort: 'low' })).status, 200)
  assert.equal(sql('SELECT COUNT(*) AS n FROM session_catalog WHERE session_id=?', [partial.body.sessionId])[0].n, 1)
  await message('root', 'CASE:held-name'); await until(() => held.has('held-name'), 'actual held provider')
  assert.equal((await fixture.api('POST', route('root') + '/name', { name: 'Name during actual provider' })).status, 200)
  held.get('held-name').complete([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-held-name' }] }]); await idle('root')
  assert.equal((await dto('root')).displayName, 'Name during actual provider'); assert.equal((await readAuthority('root')).displayName, 'Name during actual provider')
  assert.equal((await fixture.api('POST', route('ordered') + '/refresh-memory', {})).status, 200);
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionIds: ['ordered', 'root'], sessionListIds: ['root-alias'], sessionListActive: true }));
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 2), 'actual semantic fault subscriptions');
  const providerBefore = requests.length, failedStart = frames.length;
  const appendHold = join(fixture.data, 'state/experiment-faults', 'id_' + Buffer.from('ordered').toString('base64url') + '.canonical-hold-before-rename'); await mkdir(join(fixture.data, 'state/experiment-faults'), { recursive: true }); await writeFile(appendHold, 'hold');
  await message('ordered', 'CASE:no-provider'); await until(async () => await readFile(appendHold + '.reached', 'utf8').catch(() => '') === 'reached', 'actual canonical user publication barrier'); beginLock(); await unlink(appendHold);
  await until(() => frames.slice(failedStart).some(frame => frame.type === 'processing-error' && frame.sessionId === 'ordered'), 'actual pre-provider failure settled', 130000);
  assert.equal(requests.length, providerBefore); assert((await readAuthority('ordered')).history.some(row => JSON.stringify(row).includes('CASE:no-provider'))); releaseLock(); await idle('ordered')
  await message('root', 'CASE:held-effect'); await until(() => held.has('held-effect'), 'actual held effect result'); beginLock()
  const effectFailureStart = frames.length; held.get('held-effect').complete([{ type: 'function_call', call_id: 'effect', name: 'exec', arguments: JSON.stringify({ command: 'printf unsafe > forbidden-effect', timeout: 1 }) }]); await until(() => frames.slice(effectFailureStart).some(frame => frame.type === 'processing-error' && frame.sessionId === 'root'), 'actual assistant projection failure settled', 130000); await idle('root')
  await assert.rejects(access(join(fixture.work, 'forbidden-effect'))); assert((await readAuthority('root')).history.some(row => row.parts?.some(part => part.functionCall?.id === 'effect'))); releaseLock()
  const beforeRestart = (await fixture.api('GET', '/api/session-list/sidebar?limit=3')).body.nextCursor; socket.close(); await once(socket, 'close'); socket = null
  await fixture.stop(); await fixture.start()
  assert.equal((await dto('root')).displayName, 'Name during actual provider'); assert.equal((await dto('root')).model, 'b')
  const stale = await fixture.api('GET', '/api/session-list/sidebar?limit=3&cursor=' + encodeURIComponent(beforeRestart)); assert.equal(stale.body.reset, true)
  assert.equal((await exact(['retained-not-live'])).results[0].resolution.kind, 'missing'); assert.equal((await dto('archived')).archived, true)
  assert.equal(sql('SELECT session_count FROM catalog_count')[0].session_count, rows.length + 1); assert.deepEqual(errors, [])
  await fixture.stop()
  await rename(join(fixture.data, 'state/sessions/archived.json'), join(fixture.root, 'archived-missing.json'))
  await assert.rejects(fixture.start(), /authority|Authority|missing|Missing/)
  console.log(JSON.stringify({ ok: true, syntheticProviderRequests: requests.length, sourceMembers: rows.length, cleanHosts: 2, missingAuthorityRejected: true, hostPids: fixture.hostPids, peerPid: process.pid, root: fixture.root }))
} catch (error) { console.error(fixture.output); throw error } finally { releaseLock(); if (socket) socket.terminate(); for (const row of held.values()) row.response.destroy(); await new Promise(done => peer.close(done)); await fixture.cleanup() }
