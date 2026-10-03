// Original App and real model calls over a same-owner identity move and its strict partial-failure boundary.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const fixtures = [], requests = [], failures = [], counts = new Map()
const route = id => '/api/sessions/' + encodeURIComponent(id)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/MOVE-CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0
    counts.set(key, n + 1); requests.push({ key, n, body })
    for (const value of body.input.filter(value => value.type === 'function_call')) assert(body.input.some(item => item.type === 'function_call_output' && item.call_id === value.call_id))
    let output
    if (key === 'self' && n === 0) output = [call('discover', 'search_tools', { query: 'move_session', sources: ['builtin'], limit: 1 })]
    else if (key === 'self' && n === 1) output = [call('self-move', 'call_tool', { toolId: 'builtin:move_session', args: { newSessionId: 'middle' } }), call('after-self', 'write', { filePath: 'after-self.txt', content: 'Same lifetime followup.' })]
    else if (key === 'reverse' && n === 0) output = [call('failed-self-move', 'move_session', { newSessionId: 'failed-new' }), call('forbidden-effect', 'write', { filePath: 'must-not-run.txt', content: 'Must never run.' })]
    else output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-MOVE-' + key }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'identity-' + requests.length, output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } }
async function fixture(name) {
  const owned = await createHostFixture(name); fixtures.push(owned)
  await mkdir(join(owned.work, 'memory'), { recursive: true }); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
  await writeModelFixture(owned.data, models); return owned
}
function mutate(owned, sql) { const db = new DatabaseSync(join(owned.data, 'state/archive-store.sqlite')); try { db.exec(sql) } finally { db.close() } }
try {
  const owned = await fixture('identity-move-app'); await owned.start(); const page = await owned.openApp()
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'parent' })).status, 200)
  const sameBytes = await readFile(join(owned.data, 'state/sessions/main.json'), 'utf8')
  const same = await owned.api('POST', route('main') + '/message', { text: '/session move main --parent parent' }); assert.equal(same.status, 409)
  assert.equal(await readFile(join(owned.data, 'state/sessions/main.json'), 'utf8'), sameBytes)
  await page.evaluate(() => window.foxwarmTest.sendMessage('MOVE-CASE:self'))
  await until(async () => { const history = await owned.api('GET', route('middle') + '/history'); return history.body.messages?.some(value => value.parts?.some(part => part.text === 'DONE-MOVE-self')) }, 'self move complete pair and followup')
  const saved = JSON.parse(await readFile(join(owned.data, 'state/sessions/middle.json'), 'utf8'))
  const results = saved.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse)
  assert.equal(results.length, 3); assert.equal(results.find(value => value.tool_use_id === 'self-move').response.targetSessionId, 'middle')
  assert.equal(await readFile(join(owned.work, 'after-self.txt'), 'utf8'), 'Same lifetime followup.')
  assert.deepEqual(owned.sql('SELECT DISTINCT session_id FROM archive_messages'), [['middle']])
  assert.equal((await owned.api('GET', route('main') + '/state')).body.session.id, 'middle')
  await until(async () => (await page.evaluate(() => document.body.textContent)).includes('DONE-MOVE-self'), 'original Chat subscription receives moved-owner followup')
  const before = await readFile(join(owned.data, 'state/sessions/middle.json'), 'utf8')
  const command = await owned.api('POST', route('main') + '/message', { text: '/session move current' }); assert.equal(command.status, 200, JSON.stringify(command.body))
  assert.equal(command.body.result.targetSessionId, 'current'); assert.equal(requests.length, 3)
  const current = JSON.parse(await readFile(join(owned.data, 'state/sessions/current.json'), 'utf8')); assert.equal(current.promptCacheKey, JSON.parse(before).promptCacheKey)
  assert.deepEqual(current.history, JSON.parse(before).history); assert.equal(current.persistentMemorySnapshot, JSON.parse(before).persistentMemorySnapshot)
  await owned.stop(); await owned.start(); assert.equal((await owned.api('GET', route('middle') + '/state')).body.session.id, 'current'); assert.equal(requests.length, 3)
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'chain-old' })).status, 200)
  assert.equal((await owned.api('POST', route('chain-old') + '/message', { text: 'MOVE-CASE:chain' })).status, 202)
  await until(async () => (await owned.api('GET', route('chain-old') + '/history')).body.messages.some(row => row.parts?.some(part => part.text === 'DONE-MOVE-chain')), 'actual named immutable chain seed')
  for (const target of ['chain-middle', 'chain-current']) assert.equal((await owned.api('POST', route('chain-old') + '/message', { text: '/session move ' + target })).status, 200)
  const chainAudit = owned.sql('SELECT seq,agent,message_json FROM archive_messages WHERE session_id=? ORDER BY seq', ['chain-current'])
  assert.equal(chainAudit.length, 2); assert.deepEqual(owned.sql('SELECT session_id,canonical_session_id FROM archive_session_id_reservations WHERE session_id IN (?,?,?) ORDER BY session_id', ['chain-old', 'chain-middle', 'chain-current']), [['chain-middle', 'chain-current'], ['chain-old', 'chain-middle']])
  assert.equal((await owned.api('DELETE', route('chain-old'))).status, 200)
  assert.deepEqual(owned.sql('SELECT seq,agent,message_json FROM archive_messages WHERE session_id=? ORDER BY seq', ['chain-current']), chainAudit)
  await owned.stop(); await owned.start(); assert.equal(requests.length, 4)
  for (const id of ['chain-old', 'chain-middle', 'chain-current']) { assert.notEqual((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200); assert.equal((await owned.api('GET', route(id) + '/state')).status, 404) }
  assert.deepEqual(owned.sql('SELECT seq,agent,message_json FROM archive_messages WHERE session_id=? ORDER BY seq', ['chain-current']), chainAudit); await owned.stop()

  const broken = await fixture('identity-move-reverse'); await broken.start()
  const fault = join(broken.data, 'state/experiment-faults'); await mkdir(fault, { recursive: true });
  await writeFile(join(fault, 'id_' + Buffer.from('main').toString('base64url') + '.identity-after-target-persistence'), 'once')
  mutate(broken, "CREATE TRIGGER failed_reverse BEFORE UPDATE OF session_id ON archive_branches WHEN OLD.session_id='failed-new' AND NEW.session_id='main' BEGIN SELECT RAISE(ABORT,'Real reverse SQL failure'); END")
  assert.equal((await broken.api('POST', route('main') + '/message', { text: 'MOVE-CASE:reverse' })).status, 202)
  await until(async () => JSON.parse(await readFile(join(broken.data, 'state/session-id-move-pending.json'), 'utf8').catch(() => '{}')).phase === 'rolling-back', 'actual reverse failure journal')
  await until(async () => (await broken.api('GET', route('main') + '/state')).status === 500, 'affected owner authority unavailable')
  await sleep(100); assert.equal(counts.get('reverse'), 1)
  const audit = broken.sql('SELECT session_id,seq,role,message_json FROM archive_messages ORDER BY seq'); assert.equal(audit.length, 2); assert(audit.every(row => row[0] === 'failed-new'))
  assert(!audit.some(row => row[2] === 'tool')); assert(!broken.sql('SELECT session_id FROM archive_branches').some(([id]) => id === 'main'))
  const append = await broken.api('POST', route('main') + '/message', { text: 'Blocked normal input.' }); assert.equal(append.status, 500)
  assert.deepEqual(broken.sql('SELECT session_id,seq,role,message_json FROM archive_messages ORDER BY seq'), audit)
  mutate(broken, 'DROP TRIGGER failed_reverse'); await broken.crash(); await access(broken.root); assert.equal(JSON.parse(await readFile(join(broken.data, 'state/session-id-move-pending.json'), 'utf8')).phase, 'rolling-back'); await broken.start().then(() => assert.fail('Recovered identity must still reject the actual durable busy turn.'), error => assert.match(error.message, /busy|non-idle|stopping/i))
  assert.deepEqual(broken.sql('SELECT DISTINCT session_id FROM archive_messages'), [['main']]); assert.equal(counts.get('reverse'), 1)
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(JSON.stringify({ requests: requests.length, roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids), originalApp: true, sameOwner: true, failedReverseWriteBarrier: true }))
} finally {
  if (fixtures[0]) await writeFile(join(fixtures[0].root, 'identity-requests.json'), JSON.stringify({ requests, failures, roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids) }, null, 2)).catch(() => {})
  for (const owned of fixtures) { await owned.cleanup(); if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await assert.rejects(access(owned.root), { code: 'ENOENT' }) }
  console.log(JSON.stringify({ finalCleanup: true, rootsRemoved: process.env.FOXWARM_KEEP_E2E_ROOT !== '1', roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids) })); await new Promise(done => peer.close(done))
}
