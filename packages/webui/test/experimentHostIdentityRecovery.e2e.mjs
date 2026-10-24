// Actual Main-local move crash and strict-write/reverse-SQL boundaries through loopback model and source-specific journal recovery.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const fixtures = [], requests = [], failures = [], counts = new Map(), route = id => '/api/sessions/' + encodeURIComponent(id)
const segment = id => 'id_' + Buffer.from(id).toString('base64url'), exists = file => access(file).then(() => true, () => false)
const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/RECOVERY-CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0
    counts.set(key, n + 1); requests.push({ key, n, body })
    for (const item of body.input.filter(item => item.type === 'function_call')) assert(body.input.some(output => output.type === 'function_call_output' && output.call_id === item.call_id))
    const args = key === 'strict' ? { newSessionId: 'failed-new' } : key === 'independent' ? { sessionId: 'target', newSessionId: 'target-new' }
      : { createAgent: true, newAgentName: 'copied', createAgentInheritMemory: true }
    const output = n === 0 ? [tool('actual-move', 'call_tool', { source: 'builtin', name: 'move_session', args }), ...(key === 'strict' || key === 'independent' ? [tool('later-file', 'write', { filePath: 'independent-source-side.txt', content: 'Healthy independent caller can continue.' })] : [])]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-RECOVERY-' + key }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'identity-recovery-' + requests.length, output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
async function fixture(key) {
  const value = await createHostFixture('identity-recovery-' + key); fixtures.push(value)
  await mkdir(join(value.work, 'memory/nested'), { recursive: true }); await writeFile(join(value.work, 'memory/ONBOOT.md'), ' \n'); await writeFile(join(value.work, 'memory/nested/notes.md'), 'Source memory byte proof: 漢字\n')
  await writeModelFixture(value.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'] } } }); return value
}
const authority = async (value, id) => JSON.parse(await readFile(join(value.data, 'state/sessions', id + '.json'), 'utf8'))
const journalPath = value => join(value.data, 'state/session-id-move-pending.json')
function mutate(value, sql) { execFileSync('python3', ['-c', 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(sys.argv[2]);c.commit()', join(value.data, 'state/archive-store.sqlite'), sql]) }
async function fault(value, id, suffix) { const dir = join(value.data, 'state/experiment-faults'); await mkdir(dir, { recursive: true }); const path = join(dir, segment(id) + suffix); await writeFile(path, 'once'); return path }
async function send(value, key) { assert.equal((await value.api('POST', route('main') + '/message', { text: 'RECOVERY-CASE:' + key })).status, 202) }
async function crashWithData(value) {
  const pending = await readFile(journalPath(value), 'utf8'); await value.crash(); await access(value.root)
  assert.equal(await readFile(journalPath(value), 'utf8'), pending)
}
async function resumeWithoutMoveReplay(value, key, target = 'main') {
  const before = counts.get(key)
  await value.start()
  await until(async () => { const current = await authority(value, target); return !current.busy && current.history.some(row => row.parts?.some(part => part.text === 'DONE-RECOVERY-' + key)) }, 'busy owner resumes after identity recovery ' + key)
  assert.equal(counts.get(key), before + 1); assert(!(await exists(journalPath(value))))
  const resumed = requests.find(record => record.key === key && record.n === before)
  for (const item of resumed.body.input.filter(item => item.type === 'function_call')) assert.match(resumed.body.input.find(output => output.type === 'function_call_output' && output.call_id === item.call_id).output, /^error:/)
}

try {
  for (const [key, stage, direction] of [['copy-before', 'before-agent-copy', 'rolling-back'], ['copy-after', 'after-agent-copy', 'rolling-back'], ['finishing', 'before-alias-commit', 'finishing']]) {
    const value = await fixture(key); await value.start(); assert.equal((await value.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); const hold = await fault(value, 'main', '.identity-' + stage + '-hold'); await send(value, key)
    await until(() => exists(hold + '.reached'), 'actual ' + stage + ' crash boundary')
    const journal = JSON.parse(await readFile(journalPath(value), 'utf8')); assert.equal(journal.phase, direction); assert.equal(journal.ownsTargetAgentDirectory, true)
    if (key === 'copy-after') assert.equal(await readFile(join(value.data, 'agents/copied/memory/nested/notes.md'), 'utf8'), 'Source memory byte proof: 漢字\n')
    await crashWithData(value)
    if (key === 'copy-before') {
      const file = join(value.data, 'state/sessions/main.json'), bytes = await readFile(file, 'utf8'), before = counts.get(key)
      await unlink(file); await assert.rejects(value.start(), /DirectoryNotFoundException/)
      assert.equal(counts.get(key), before); assert(await exists(journalPath(value))); assert.equal(await exists(file), false)
      await writeFile(file, bytes)
    }
    const target = direction === 'finishing' ? 'copied/main' : 'main'
    await resumeWithoutMoveReplay(value, key, target); assert.equal((await authority(value, target)).busy, false)
    assert.equal(await exists(join(value.data, 'agents/copied')), direction === 'finishing')
    assert.deepEqual(value.sql('SELECT DISTINCT session_id FROM archive_messages'), [[target]])
    if (direction === 'finishing') assert.deepEqual(value.sql('SELECT canonical_session_id FROM archive_session_id_reservations WHERE session_id=?', ['main']), [['copied/main']])
    await value.stop()
  }
  const committed = await fixture('committed'); await committed.start(); assert.equal((await committed.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); await fault(committed, 'main', '.identity-after-alias-commit'); await send(committed, 'committed')
  await until(async () => (await authority(committed, 'copied/main').catch(() => ({ history: [] }))).history.some(row => row.parts?.some(part => part.text === 'DONE-RECOVERY-committed')), 'healthy committed partial complete pair and followup')
  const partial = (await authority(committed, 'copied/main')).history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'actual-move').functionResponse.response
  assert.equal(partial.identityCommitted, true); assert.equal(JSON.parse(await readFile(journalPath(committed), 'utf8')).phase, 'finishing')
  await committed.stop(); const count = counts.get('committed'); await committed.start(); assert.equal(counts.get('committed'), count); assert(!(await exists(journalPath(committed)))); assert.equal((await committed.api('GET', route('main') + '/state')).body.session.id, 'copied/main'); await committed.stop()

  const strict = await fixture('strict'); await strict.start(); assert.equal((await strict.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); await fault(strict, 'failed-new', '.identity-authority-before-rename')
  mutate(strict, "CREATE TRIGGER failed_reverse BEFORE UPDATE OF session_id ON archive_branches WHEN OLD.session_id='failed-new' AND NEW.session_id='main' BEGIN SELECT RAISE(ABORT,'Actual reverse SQL failure after strict target save fault'); END")
  await send(strict, 'strict'); await until(async () => (await strict.api('GET', route('main') + '/state')).status === 500, 'self strict write and reverse authority unavailable')
  const rows = strict.sql('SELECT session_id,seq,role,message_json FROM archive_messages ORDER BY seq'); assert.equal(rows.length, 2); assert(rows.every(row => row[0] === 'failed-new')); assert(!(await exists(join(strict.work, 'independent-source-side.txt'))))
  assert.equal((await strict.api('POST', route('main') + '/message', { text: 'Rejected normal subsequent input.' })).status, 500); await sleep(100); assert.equal(counts.get('strict'), 1); assert.deepEqual(strict.sql('SELECT session_id,seq,role,message_json FROM archive_messages ORDER BY seq'), rows)
  mutate(strict, 'DROP TRIGGER failed_reverse'); await crashWithData(strict); await resumeWithoutMoveReplay(strict, 'strict'); assert.deepEqual(strict.sql('SELECT DISTINCT session_id FROM archive_messages'), [['main']]); await strict.stop()

  const independent = await fixture('independent'); await independent.start(); assert.equal((await independent.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); assert.equal((await independent.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'target' })).status, 200)
  await fault(independent, 'target', '.identity-after-target-persistence'); mutate(independent, "CREATE TRIGGER failed_target_reverse BEFORE UPDATE OF session_id ON archive_branches WHEN OLD.session_id='target-new' AND NEW.session_id='target' BEGIN SELECT RAISE(ABORT,'Actual independent target reverse failure'); END")
  await send(independent, 'independent'); await until(async () => (await authority(independent, 'main')).history.some(row => row.parts?.some(part => part.text === 'DONE-RECOVERY-independent')), 'independent healthy caller partial pair and later effect')
  assert.equal(await readFile(join(independent.work, 'independent-source-side.txt'), 'utf8'), 'Healthy independent caller can continue.')
  const result = (await authority(independent, 'main')).history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'actual-move').functionResponse.response; assert.equal(result.recoveryRequired, true)
  assert.equal((await independent.api('POST', route('target') + '/message', { text: 'Protected target ordinary append.' })).status, 500); assert.equal(independent.sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', ['target'])[0][0], 0)
  mutate(independent, 'DROP TRIGGER failed_target_reverse'); await crashWithData(independent); const before = counts.get('independent'); await independent.start(); assert.equal(counts.get('independent'), before); assert(!(await exists(journalPath(independent)))); assert.equal((await independent.api('GET', route('target') + '/state')).status, 200); await independent.stop()
  assert.equal(failures.length, 0, failures.join('\n')); console.log(JSON.stringify({ roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids), requests: requests.length, actualCopyCrash: true, finishing: true, committedPartial: true, strictReverse: true, independentCaller: true }))
} finally {
  if (fixtures[0]) await writeFile(join(fixtures[0].root, 'identity-recovery-requests.json'), JSON.stringify({ requests, failures, roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids) }, null, 2)).catch(() => {})
  for (const value of fixtures) { await value.cleanup(); if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await assert.rejects(access(value.root), { code: 'ENOENT' }) }
  console.log(JSON.stringify({ finalCleanup: true, rootsRemoved: process.env.FOXWARM_KEEP_E2E_ROOT !== '1', roots: fixtures.map(value => value.root), hosts: fixtures.flatMap(value => value.hostPids) })); await new Promise(done => peer.close(done))
}
