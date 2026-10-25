#!/usr/bin/env node
// Owned Main process shutdown/restart with actual provider, exec and compact owners.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from '../../../packages/webui/test/experimentHostFixture.mjs'

const f = await createHostFixture('shutdown-recovery', { stopTimeout: 18000 })
const requests = [], failures = [], rounds = new Map(), gates = new Map()
let restarted = false
const gate = key => { let release; const promise = new Promise(resolve => { release = resolve }); const value = { promise, release }; gates.set(key, value); return value }
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL:' + key }] }]
const textOf = body => (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
const execCwd = join(f.work, 'exec-cwd')
const effect = join(f.work, 'exec-effect.txt'), skipped = join(f.work, 'must-not-exist.txt')
const peer = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw), text = textOf(body), planning = text.includes('COMPACTION STARTED:')
    const key = planning ? 'planner' : [...text.matchAll(/SHUTDOWN:([\w-]+)/g)].at(-1)?.[1] || 'unknown'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const observation = { key, round, body, restarted }; requests.push(observation)
    res.once('close', () => { observation.closed = true })
    if (!restarted && gates.has(key)) await Promise.race([gates.get(key).promise, once(res, 'close')])
    if (res.destroyed) return
    let output = final(key), usage
    if (!restarted && key === 'tools') output = [
      call('launched-exec', 'exec', { command: `cd '${execCwd}'; printf effect >> '${effect}'; sleep 8; printf done >> '${effect}'`, timeout: 60 }),
      call('unstarted-write', 'write', { filePath: skipped, content: 'must not execute' }),
    ]
    if (!restarted && key === 'compact') {
      output = [call('before-required-wait', 'read', { filePath: join(f.work, 'fixture.txt') })]
      usage = { input_tokens: 21000, output_tokens: 1, total_tokens: 21001 }
    }
    if (key === 'waiting') output = [call('real-wait', 'wait', { waitForInput: true })]
    const advertised = new Set((body.tools || []).map(tool => tool.name))
    for (const item of output.filter(item => item.type === 'function_call')) assert(advertised.has(item.name), 'Returned tool is advertised: ' + item.name)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, ...(usage ? { usage } : {}) } }) + '\n\n')
  } catch (error) { failures.push(error.stack); if (!res.destroyed) { res.writeHead(500); res.end('fixture failure') } }
})
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(f.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
async function post(path, body, status = 200) { const result = await f.api('POST', path, body); assert.equal(result.status, status, JSON.stringify(result)); return result.body }
async function create(id) { return (await post('/api/sessions', { agentId: 'main', sessionId: id })).sessionId }
async function send(id, key, clientMessageId = key) { await post(route(id) + '/message', { text: 'SHUTDOWN:' + key, clientMessageId }, 202) }
async function idle(id) { return until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await saved(id); return !state.busy ? state : null }, 'idle ' + id) }
async function reached(key) { return until(() => requests.find(row => row.key === key), 'provider ' + key) }
function assertPairs(state) {
  for (let index = 0; index < state.history.length; index++) {
    const calls = state.history[index].parts?.filter(part => part.functionCall).map(part => part.functionCall.id) || []
    if (!calls.length) continue
    const responses = state.history[index + 1]?.parts?.filter(part => part.functionResponse).map(part => part.functionResponse.tool_use_id) || []
    assert.deepEqual(responses, calls)
  }
}
const hasResume = state => state.history.some(row => row.parts?.some(part => part.system?.includes('type="session-resumed"')))
const byClient = (state, id) => state.history.filter(row => row.__meta?.clientMessageId === id)
try {
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  await writeFile(f.modelPath, JSON.stringify({ default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 20000 } } }))
  await writeFile(join(f.work, 'fixture.txt'), 'committed read result')
  await mkdir(execCwd)
  await f.start()
  const interrupt = await create('interrupted'), tools = await create('tools'), compact = await create('compact'), genuine = await create('genuine-final'), waiting = await create('terminal-wait')
  // Build real compact candidates through ordinary turns, not snapshot mutation.
  for (let index = 0; index < 7; index++) {
    await post(route(compact) + '/message', { text: 'SHUTDOWN:seed-' + index + ' ' + 'x'.repeat(5000), clientMessageId: 'seed-' + index }, 202)
    await idle(compact)
  }
  gate('planner')
  await post(route(compact) + '/message', { text: '/compact' }, 202)
  await reached('planner')
  await send(compact, 'compact')
  await until(async () => (await saved(compact)).history.some(row => JSON.stringify(row).includes('committed read result')), 'complete pair before required planning wait')
  await sleep(100) // Let the actual continuation reach its independently held planning wait.
  await send(compact, 'compact-followup')
  gate('interrupt')
  await send(interrupt, 'interrupt'); await reached('interrupt'); await send(interrupt, 'interrupt-followup')
  await send(tools, 'tools')
  await until(async () => (await readFile(effect, 'utf8').catch(() => '')) === 'effect', 'actual exec side effect before shutdown')
  await send(tools, 'tools-followup')
  const finalGate = gate('genuine')
  await send(genuine, 'genuine'); await reached('genuine'); await send(genuine, 'genuine-followup')
  await send(waiting, 'waiting'); const terminal = await idle(waiting); assert(terminal.meta.wait?.id)
  const waitId = terminal.meta.wait.id
  await f.stop(() => finalGate.release())
  const stopped = Object.fromEntries(await Promise.all([interrupt, tools, compact, genuine, waiting].map(async id => [id, await saved(id)])))
  for (const id of [interrupt, tools, compact]) {
    assert.equal(stopped[id].busy, true, id)
    assert.equal(stopped[id].stopping, false)
    assert.equal(stopped[id].queue.filter(item => item.clientMessageId?.endsWith('followup')).length, 1, JSON.stringify({ id, queue: stopped[id].queue }))
    assert(!hasResume(stopped[id]))
  }
  assert.equal(stopped[genuine].busy, false)
  assert.equal(stopped[genuine].queue.length, 1)
  assert(stopped[genuine].history.some(row => row.parts?.some(part => part.text === 'FINAL:genuine')))
  assert.equal(stopped[waiting].busy, false); assert.equal(stopped[waiting].meta.wait.id, waitId)
  assert.equal(stopped[tools].cwd, execCwd, 'Accepted exec cwd settlement survives admission closure')
  const launched = stopped[tools].history.find(row => row.role === 'tool')
  assert(launched.parts[0].functionResponse.response.output.includes('Foreground wait ended by process shutdown'))
  assert(launched.parts[0].functionResponse.response.output.includes('execId:'))
  assert(JSON.stringify(launched.parts[1]).includes('not started because process shutdown'))
  assert(!JSON.stringify(launched.parts[0]).includes('not started'))
  assert.equal(await readFile(skipped, 'utf8').catch(() => null), null)
  for (const state of Object.values(stopped)) assertPairs(state)
  assert.equal(requests.filter(row => row.key === 'planner').length, 1)
  assert.equal(requests.filter(row => row.key === 'compact').length, 1)
  // The foreground wait did not kill its independent process.
  await until(async () => (await readFile(effect, 'utf8').catch(() => '')) === 'effectdone', 'independent exec completes after Main exit', 12000)
  restarted = true
  for (const value of gates.values()) value.release()
  await f.start()
  for (const [id, client] of [[interrupt, 'interrupt-followup'], [tools, 'tools-followup'], [compact, 'compact-followup'], [genuine, 'genuine-followup']]) {
    const state = await until(async () => { const value = await saved(id); return !value.busy && byClient(value, client).length === 1 ? value : null }, 'recovered pending input ' + id)
    assert.equal(byClient(state, client).length, 1)
    assert.equal(hasResume(state), id !== genuine)
    assertPairs(state)
    for (const row of state.history) {
      const archived = f.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [id, row.__meta.seq])
      assert.deepEqual(archived.map(value => JSON.parse(value[0])), [row])
    }
  }
  const afterWait = await saved(waiting)
  assert.equal(afterWait.meta.wait.id, waitId); assert(!hasResume(afterWait))
  assert.equal(await readFile(effect, 'utf8'), 'effectdone')
  assert.equal(await readFile(skipped, 'utf8').catch(() => null), null)
  assert.equal(requests.filter(row => row.key === 'tools').length, 1)
  assert.equal(requests.filter(row => row.key === 'compact').length, 1)
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(JSON.stringify({ ownedHostStarts: f.hostPids.length, interruptedOwners: 3, terminalOwners: 2, recoveredFollowups: 4, providerRequests: requests.length, completePairs: true, independentExecPreserved: true, canonicalArchiveEqual: true }))
  // Exercise ConsoleLifetime's signal path as well as the first admin path.
  f.signalStop()
  assert.deepEqual(await f.waitForExit(), { code: 0, signal: null }, f.output)

} finally {
  for (const value of gates.values()) value.release()
  if (await readFile(effect, 'utf8').catch(() => null))
    await until(async () => (await readFile(effect, 'utf8').catch(() => '')) === 'effectdone', 'owned exec cleanup', 12000).catch(() => {})
  await f.cleanup()
  await new Promise(resolve => peer.close(resolve))
}
