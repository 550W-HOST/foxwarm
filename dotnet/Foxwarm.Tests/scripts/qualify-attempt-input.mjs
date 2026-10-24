#!/usr/bin/env node
// Normal HTTP host, official Node client, controlled providers and canonical persistence.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from '../../../packages/webui/test/experimentHostFixture.mjs'

const f = await createHostFixture('attempt-input')
const requests = [], rounds = new Map(), gates = new Map(), failures = []
let client
const gate = key => { let release; const promise = new Promise(done => { release = done }); gates.set(key, { promise, release }); return gates.get(key) }
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const done = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE:' + key }] }]
const peer = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const bytes of req) raw += bytes
    const body = JSON.parse(raw), text = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...text.matchAll(/PHASE4:([\w-]+)/g)].at(-1)?.[1] || 'assignment'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    requests.push({ key, round, body })
    if (gates.has(key + '-' + round)) await gates.get(key + '-' + round).promise
    if (key === 'retry' && round < 2 || key === 'failover' && round === 0) { res.writeHead(503); res.end('owned retry'); return }
    const output = key === 'wait' && round === 0 ? [call('wait-call', 'wait', { waitForInput: true })]
      : key === 'exec' && round === 0 ? [call('exec-call', 'exec', { command: 'sleep 2; printf background-done', timeout: 1 })]
      : done(key)
    const names = new Set((body.tools || []).map(tool => tool.name))
    for (const item of output.filter(item => item.type === 'function_call')) assert(names.has(item.name), 'Tool must be advertised: ' + item.name)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
  } catch (error) { failures.push(error.stack); res.writeHead(500); res.end('fixture failure') }
})
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(f.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const notices = state => state.history.filter(row => row.parts?.some(part => part.system?.includes('kind="session-settings-changed"')))
async function post(path, body, status = 200) { const result = await f.api('POST', path, body); assert.equal(result.status, status, JSON.stringify(result)); return result.body }
async function create(id) { return (await post('/api/sessions', { agentId: 'main', sessionId: id })).sessionId }
async function idle(id) { return until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await saved(id); return !(await f.api('GET', route(id) + '/state')).body.session.busy ? state : null }, 'idle ' + id) }
async function begin(id, key) { await post(route(id) + '/message', { text: 'PHASE4:' + key }, 202) }
async function send(id, key) { await begin(id, key); return until(async () => { const state = await idle(id); return state.history.some(row => row.parts?.some(part => part.text === 'DONE:' + key)) ? state : null }, 'answer ' + key) }
async function reached(key, round = 0) { return until(() => requests.find(row => row.key === key && row.round === round), 'request ' + key + '-' + round) }
async function model(id, selection) { await post(route(id) + '/model', selection) }
const journalSql = sql => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2]).fetchall()))', join(f.data, 'state/llm-request-journal.sqlite'), sql], { encoding: 'utf8' }))
try {
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  const baseUrl = `http://127.0.0.1:${peer.address().port}`
  const models = { default: 'a', providers: {
    a: { providerType: 'openai-responses', baseUrl, models: ['a-wire'] },
    b: { providerType: 'openai-responses', baseUrl, models: ['b-wire'] },
    pool: { providerType: 'failover', targets: ['a', 'b'], failureThreshold: 1 },
  } }
  await writeFile(f.modelPath, JSON.stringify(models))
  await f.start()
  const paths = { runtime: join(f.root, 'node-runtime'), agents: join(f.root, 'node-agents') }
  await mkdir(paths.runtime); await mkdir(join(paths.agents, 'main'), { recursive: true })
  const credential = await post('/api/nodes/onboarding/create', { fallbackUrl: f.origin, nodeId: 'owned-node' })
  client = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', f.origin, '--id', 'owned-node', '--auth-token', credential.authToken, '--credentials-file', join(paths.runtime, 'credentials.json'), '--no-local-trigger'], { cwd: paths.runtime, env: { ...process.env, FOXWARM_AGENTS_DIR: paths.agents }, stdio: 'ignore' })
  await until(async () => (await f.api('GET', '/api/nodes')).body.nodes.some(node => node.id === 'owned-node' && node.online), 'owned official Node')
  const actor = await create('attempt-owner')
  let state = await send(actor, 'initial'); assert.equal(notices(state).length, 0); assert.equal(state.meta.lastEffectiveRequest.modelId, 'a/a-wire')
  await model(actor, { model: 'a/a-wire', effort: 'low' })
  await post(route(actor) + '/child-model', { model: 'b' })
  await post(route(actor) + '/node', { nodeId: 'owned-node' }); await post(route(actor) + '/node', { nodeId: 'master' })
  state = await send(actor, 'alias'); assert.equal(notices(state).length, 0); assert.equal(state.meta.lastEffectiveRequest.effort, 'low')
  await model(actor, { model: 'b' }); state = await send(actor, 'switch'); assert.equal(notices(state).length, 1)
  await post(route(actor) + '/node', { nodeId: 'owned-node' }); state = await send(actor, 'node'); assert.equal(notices(state).length, 2); assert.equal(state.meta.lastEffectiveRequest.nodeId, 'owned-node')
  await post(route(actor) + '/node', { nodeId: 'master' }); await model(actor, { model: 'a', effort: 'high' })
  const first = gate('retry-0'), second = gate('retry-1')
  await begin(actor, 'retry'); await reached('retry')
  const cacheKey = (await saved(actor)).promptCacheKey
  await model(actor, { model: 'a/a-wire', effort: 'low' }); first.release()
  assert.equal((await reached('retry', 1)).body.reasoning.effort, 'low')
  await model(actor, { effort: 'max' }); second.release()
  assert.equal((await reached('retry', 2)).body.reasoning.effort, 'low'); state = await idle(actor)
  assert.equal(state.promptCacheKey, cacheKey); assert.equal(state.meta.lastEffectiveRequest.effort, 'low')
  await model(actor, { model: 'b' })
  const withoutB = structuredClone(models); delete withoutB.providers.b; delete withoutB.providers.pool
  await f.save(withoutB)
  state = await send(actor, 'missing-one'); const count = notices(state).length
  assert.equal(state.meta.lastEffectiveRequest.missingModelKey, 'b'); assert(notices(state).at(-1).parts[0].system.includes('reason="missing-model"'))
  state = await send(actor, 'missing-two'); assert.equal(notices(state).length, count)
  await f.save(models); await model(actor, { model: 'pool' }); state = await send(actor, 'failover')
  assert(notices(state).at(-1).parts[0].system.includes('reason="failover"')); assert.equal(state.meta.lastEffectiveRequest.modelId, 'b/b-wire')
  const delayed = gate('delayed-0')
  await begin(actor, 'delayed'); await reached('delayed')
  await begin(actor, 'followup')
  await post('/api/tasks', { title: 'Provider-time event', ownerSessionId: actor, notifySession: true }, 201)
  delayed.release(); state = await until(async () => { const value = await idle(actor); return value.history.some(row => row.parts?.some(part => part.text === 'DONE:followup')) ? value : null }, 'delayed input')
  const queuedRows = state.history.filter(row => row.parts?.some(part => part.system?.includes('queueInputHint=')))
  assert(queuedRows.some(row => JSON.stringify(row).includes('PHASE4:followup')))
  assert(queuedRows.some(row => JSON.stringify(row).includes('Provider-time event')))
  assert(!state.history.find(row => JSON.stringify(row).includes('PHASE4:initial')).parts.some(part => part.system?.includes('queueInputHint=')))
  const execHold = gate('exec-1')
  await begin(actor, 'exec'); await reached('exec', 1)
  await until(async () => (await saved(actor)).queue.some(item => JSON.stringify(item).includes('background-process-finished')), 'actual exec completion')
  execHold.release(); state = await until(async () => { const value = await idle(actor); return value.queue.length === 0 && value.history.some(row => JSON.stringify(row).includes('background-process-finished') && row.parts?.some(part => part.system?.includes('queueInputHint='))) ? value : null }, 'exec event committed')
  const passive = await create('passive-owner')
  const task = await post('/api/tasks', { title: 'Passive ownership', ownerSessionId: passive, notifySession: true }, 201)
  await until(async () => (await saved(passive)).history.some(row => row.parts?.some(part => part.text === 'DONE:assignment')), 'assignment response')
  await begin(passive, 'wait'); await reached('wait'); state = await idle(passive)
  const waitId = state.meta.wait.id, beforeRequests = requests.length
  await post('/api/tasks/' + task.task.id + '/assign', { ownerSessionId: null, notifySession: true })
  state = await saved(passive); assert.equal(state.meta.wait.id, waitId); assert.equal(state.queue.length, 1); assert.equal(state.queue[0].trigger, false)
  assert.equal(requests.length, beforeRequests)
  await post(route(passive) + '/message', { text: '/dequeue' })
  state = await until(async () => { const value = await idle(passive); return value.queue.length === 0 && !value.meta.wait ? value : null }, 'explicit passive dequeue')
  assert.equal(requests.length, beforeRequests + 1)
  for (const id of [actor, passive]) {
    const current = await saved(id)
    const archive = f.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [id]).map(row => JSON.parse(row[0]))
    const immutableRows = rows => rows.filter(row => row.__meta?.noticeType !== 'llm-retry')
    assert.deepEqual(immutableRows(archive), immutableRows(current.history))
    for (let i = 0; i < current.history.length; i++) if (current.history[i].parts?.some(part => part.functionCall)) assert.equal(current.history[i + 1].role, 'tool')
  }
  const starts = journalSql('SELECT r.requested_model_key,a.concrete_model_id,a.virtual_model_key FROM llm_journal_attempt_starts a JOIN llm_journal_requests r USING(request_id) ORDER BY a.rowid')
  assert(starts.some(row => row[0] === 'a/a-wire' && row[1] === 'a/a-wire'))
  assert(starts.some(row => row[0] === 'pool' && row[1] === 'b/b-wire' && row[2] === 'pool'))
  assert(journalSql("SELECT COUNT(*) FROM llm_journal_objects WHERE payload LIKE '%queueInputHint%'")[0][0] > 0)
  assert.equal(failures.length, 0)
  console.log(JSON.stringify({ requests: requests.length, canonicalNotices: notices(await saved(actor)).length, deferredRows: queuedRows.length, journalAttempts: starts.length, actualNode: true, actualTask: true, actualExec: true, passiveExplicitDequeue: true }))
  await f.stop()
} finally {
  for (const value of gates.values()) value.release()
  if (client && client.exitCode === null) { client.kill('SIGTERM'); await once(client, 'exit').catch(() => {}) }
  await new Promise(done => peer.close(done))
  await f.cleanup()
}
