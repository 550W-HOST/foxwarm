// Original App, real source-generated moved/deleted audit and fail-before-effects startup.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixtures = [], requests = [], failures = []
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    for (const item of body.input.filter(item => item.type === 'function_call')) assert(body.input.some(value => value.type === 'function_call_output' && value.call_id === item.call_id))
    const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
    const output = body.input.at(-1)?.type === 'function_call_output'
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-ARCHIVE-IDENTITY' }] }]
      : [call('agent', 'create_agent', { agentName: 'archive-proof', createMainSession: false }), call('old', 'create_session', { agentName: 'main', sessionName: 'archive_old' }), call('middle', 'create_session', { agentName: 'main', sessionName: 'archive_middle' }),
        call('current', 'create_session', { agentName: 'archive-target', sessionName: 'current' }), call('allowed', 'write', { filePath: 'archive-proof.txt', content: 'Committed compatibility retains ordinary paired effects.' })]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'archive-' + requests.length, output, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); if (!response.destroyed) { response.writeHead(500); response.end() } }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } }
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function create(name) {
  const fixture = await createHostFixture(name); fixtures.push(fixture)
  const stdout = execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/archive-identity-fixture-ts.mjs'), 'seed', fixture.data], { encoding: 'utf8', env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') } })
  fixture.source = JSON.parse(stdout.split('\n').find(line => line.startsWith('ARCHIVE_FIXTURE:')).slice('ARCHIVE_FIXTURE:'.length))
  await writeFile(fixture.modelPath, JSON.stringify(models)); await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
  return fixture
}
async function catalog(fixture, rows) {
  const module = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href), store = new module.SessionCatalogStore(join(fixture.data, 'state/catalog.sqlite'))
  store.open(); store.replaceAll(rows); store.close()
}
const row = (id, extra = {}) => ({ id, agent: 'main', busy: false, queueLength: 0, model: 'a', meta: { messageCount: 0, lastMessageTime: 0 }, ...extra })

function mutate(fixture, sql) { const db = new DatabaseSync(join(fixture.data, 'state/archive-store.sqlite')); try { db.exec(sql) } finally { db.close() } }
try {
  const fixture = await create('archive-identity-app'), ledger = join(fixture.data, 'state/session-id-reservations.jsonl')
  const cold = Array.from({ length: 1000 }, (_, index) => row('cold-' + index)); cold[0].aliases = ['unique-cold']; cold[1].aliases = ['ambiguous']; cold[2].aliases = ['ambiguous']
  await catalog(fixture, cold);
  await unlink(ledger)
  const before = fixture.sql('SELECT session_id,agent,seq,timestamp,role,message_json FROM archive_messages ORDER BY session_id,seq')
  await fixture.start(); await fixture.openApp()
   assert.equal((await fixture.api('GET', '/api/session-list/architecture')).status, 200)
  const mappings = fixture.sql('SELECT session_id,canonical_session_id FROM archive_session_id_reservations'); assert(mappings.some(([id, target]) => id === 'unique-cold' && target === 'cold-0')); assert(!mappings.some(([id]) => id === 'ambiguous'))
  for (let index = 0; index < cold.length; index += 100) assert.equal((await fixture.api('POST', '/api/session-list/by-id', { ids: cold.slice(index, index + 100).map(value => value.id) })).status, 200)
   assert.equal(requests.length, 0)
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'ARC-TASK:reserved-identities' })).status, 202)
  await until(async () => { const history = await fixture.api('GET', route('main') + '/history'); return history.body.messages?.some(value => value.parts?.some(part => part.text === 'DONE-ARCHIVE-IDENTITY')) }, 'full actual provider pairs')
  const saved = JSON.parse(await readFile(join(fixture.data, 'state/sessions/main.json'), 'utf8')), results = saved.history.flatMap(value => value.parts || []).filter(value => value.functionResponse).map(value => value.functionResponse)
  assert.equal(results.length, 5); assert(results.find(value => value.tool_use_id === 'agent')?.response?.output); for (const id of ['old', 'middle', 'current']) assert(results.find(value => value.tool_use_id === id)?.response?.error)
  assert.equal(await readFile(join(fixture.work, 'archive-proof.txt'), 'utf8'), 'Committed compatibility retains ordinary paired effects.')
  for (const id of ['archive_old', 'archive_middle', 'archive-target/current']) await assert.rejects(access(join(fixture.data, 'state/sessions', id + '.json')))
  const original = fixture.sql("SELECT session_id,agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id<>'main' ORDER BY session_id,seq"); assert.deepEqual(original, before)
   await fixture.stop(); await fixture.start(); assert.equal(requests.length, 2); await fixture.stop()

  // Existing durable mappings remain independent authority, not presentation aliases.
  for (const failure of ['cycle', 'conflict', 'pending', 'lost-archive', 'lost-journal', 'archive-marker', 'journal-marker']) {
    const broken = await create('archive-identity-' + failure), state = join(broken.data, 'state'), beforeRequests = requests.length
    const queued = { sessionStateVersion: 1, id: 'queued', agent: 'main', model: 'a', verbose: false, busy: false, history: [], queue: [{ type: 'onboot', parts: [{ system: 'Must not reach a provider.' }] }],
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }, nextMessageSeq: 1, nextBlockId: 1, meta: {}, wait: { id: 'expired', startedAt: 1, timeoutSeconds: 1, declarationVersion: 1 } }
    await mkdir(join(state, 'sessions'), { recursive: true }); const queuedFile = join(state, 'sessions/queued.json'); await writeFile(queuedFile, JSON.stringify(queued)); await catalog(broken, [row('queued', { queueLength: 1 })])
    if (failure === 'cycle') mutate(broken, "INSERT INTO archive_session_id_reservations VALUES('cycle-a','cycle-b',1,1),('cycle-b','cycle-a',1,1)")
    if (failure === 'conflict') mutate(broken, "UPDATE archive_session_id_reservations SET canonical_session_id='other' WHERE session_id='archive_old'")
    if (failure === 'pending') await writeFile(join(state, 'session-id-move-pending.json'), '{"v":1,"phase":"finishing"}')
    if (failure.startsWith('lost-')) for (const suffix of ['', '-wal', '-shm']) await unlink(join(state, (failure === 'lost-archive' ? 'archive-store.sqlite' : 'llm-request-journal.sqlite') + suffix)).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (failure === 'archive-marker') mutate(broken, "DELETE FROM archive_store_metadata WHERE key='sqlite_authority_migration'")
    if (failure === 'journal-marker') { const db = new DatabaseSync(join(state, 'llm-request-journal.sqlite')); db.exec("DELETE FROM llm_journal_metadata WHERE key='sqlite_authority_migration'"); db.close() }
    await assert.rejects(broken.start()); assert.equal(requests.length, beforeRequests); assert.equal(await readFile(queuedFile, 'utf8'), JSON.stringify(queued)); await assert.rejects(access(join(state, 'sessions/main.json')))
    if (failure.startsWith('lost-')) await assert.rejects(access(join(state, failure === 'lost-archive' ? 'archive-store.sqlite' : 'llm-request-journal.sqlite')))
    assert(!broken.output.includes('Now listening')); await broken.cleanup()
  }
  assert.deepEqual(failures, []); console.log(JSON.stringify({ requests: requests.length, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids), cold: cold.length, failures: 7 }))
} finally {
  await writeFile(join(fixtures[0].root, 'archive-requests.json'), JSON.stringify({ requests, failures, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids) }))
  for (const fixture of fixtures) { console.log('Owned fixture: ' + JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids })); await fixture.cleanup() }
  await new Promise(done => peer.close(done))
}
