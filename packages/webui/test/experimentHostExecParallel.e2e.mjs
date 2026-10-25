import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'

const fixture = await createHostFixture('exec-parallel'), records = [], errors = [], scripts = new Map(), hostPids = fixture.hostPids, shellPids = [], releases = new Set()
Object.assign(process.env, testEnvironment.isolatedApplicationEnv(fixture.data))
const { SessionCatalogStore } = await import('../../../lib/session/catalogStore.js')
const route = id => '/api/sessions/' + encodeURIComponent(id)
const exists = path => access(path).then(() => true, () => false)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const own = join(fixture.data, 'agents/team'), marks = join(own, 'marks')
const tool = (id, name, args, raw) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: raw ?? JSON.stringify(args) })
const call = (id, command, args = {}) => tool(id, 'exec', { command, timeout: 60, ...args })
function shell(id, extra = '') {
  releases.add(id)
  return `mkdir -p marks; printf '%s' "$$" > marks/pid-${id}; printf '%s\\n' "$$" >> marks/runs-${id}; touch marks/start-${id}; while [ ! -f marks/release-${id} ]; do sleep 0.02; done; ${extra}printf 'END-${id}\\n'; pwd; touch marks/done-${id}`
}
const release = id => writeFile(join(marks, 'release-' + id), '')
const started = ids => until(async () => (await Promise.all(ids.map(id => exists(join(marks, 'start-' + id))))).every(Boolean), 'actual launched shells ' + ids.join(','))
const idle = id => until(async () => { const value = await history(id); return !value.session.busy && !value.session.runtimeState.queueLength }, 'idle ' + id)
const send = (id, key, calls) => { if (calls) scripts.set(key, calls); return fixture.api('POST', route(id) + '/message', { text: 'PAR-TASK:' + key }) }
const pair = async (id, callId) => (await history(id)).messages.flatMap(row => row.parts || []).map(part => part.functionResponse).find(result => result?.tool_use_id === callId)
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), text = body.input.filter(item => item.role === 'user').flatMap(item => item.content || []).map(part => part.text || '').join('\n')
    const key = [...text.matchAll(/PAR-TASK:([a-z0-9-]+)/g)].at(-1)?.[1] || 'unknown', calls = scripts.get(key) || []
    const complete = !calls.length || body.input.some(item => item.type === 'function_call_output' && item.call_id === calls[0].call_id)
    const output = complete ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }] : calls
    records.push({ key, body }); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-' + records.length, status: 'completed', output, usage: { input_tokens: 30, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, apiKey: 'synthetic-parallel-provider', models: ['wire'] } } }))
// Persisted identities retain their old spelling; new-name validation is a separate caller.
const percent = 'x%2Fy'
await mkdir(join(fixture.data, 'state/sessions'), { recursive: true })
const legacy = { sessionStateVersion: 1, id: percent, agent: 'main', model: 'local', currentNode: 'master', verbose: false, busy: false, history: [], queue: [], stats: {}, nextMessageSeq: 1, nextBlockId: 1, meta: { messageCount: 0, lastMessageTime: 0 }, promptCacheKey: 'retained-percent-identity', persistentMemorySnapshot: 'Retained fixture identity.' }
await writeFile(join(fixture.data, 'state/sessions', percent + '.json'), JSON.stringify(legacy))
const catalog = new SessionCatalogStore(join(fixture.data, 'state/catalog.sqlite'))
catalog.initializeEmpty(); catalog.replaceAll([{ id: percent, agent: 'main', model: 'local', currentNode: 'master', busy: false, queueLength: 0, meta: legacy.meta }]); catalog.close()
const seed = join(fixture.root, 'legacy-seed.json'); await writeFile(seed, JSON.stringify([{ id: percent }]))
execFileSync(process.execPath, ['dotnet/Foxwarm.Tests/Fixtures/session-catalog-seed-ts.mjs', fixture.data, seed], { env: { ...process.env, FOXWARM_TS_ROOT: process.cwd() } })
let stopped = true
async function start() { await fixture.start(); stopped = false }
async function create(name, agent = 'team') { const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId }
try {
  await start(); await fixture.openApp(); assert([201, 409].includes((await fixture.api('POST', '/api/agents', { agentId: 'team' })).status)); await mkdir(marks, { recursive: true })
    const launch = await create('launch'), deniedCwd = join(own, 'no-search'); await mkdir(deniedCwd); await chmod(deniedCwd, 0)
    try {
      const before = records.length; await send(launch, 'launch-failure', [call('launch-success-one', 'touch launch-success-one; printf success-one'), call('launch-error', 'printf forbidden', { cwd: 'no-search' }), call('launch-success-two', 'touch launch-success-two; printf success-two')])
      await until(async () => !(await history(launch)).session.busy, 'real launch failure and successful siblings settle')
      assert(await exists(join(own, 'launch-success-one'))); assert(await exists(join(own, 'launch-success-two')))
      const snapshot = await history(launch); console.log(JSON.stringify({ realCwdFailureProbe: true, responseCount: snapshot.messages.flatMap(row => row.parts || []).filter(part => part.functionResponse).length, providerRequests: records.length - before, state: (await fixture.api('GET', route(launch) + '/state')).body.session }))
      assert(await pair(launch, 'launch-error'), 'ordinary launch failure must retain its own paired response')
      assert.equal((await pair(launch, 'launch-error')).response.error.type, 'tool_io_error'); assert((await pair(launch, 'launch-error')).executionTiming); assert((await pair(launch, 'launch-success-one')).response.output.includes('success-one')); assert((await pair(launch, 'launch-success-two')).response.output.includes('success-two'))
    } finally { await chmod(deniedCwd, 0o700) }
  if (process.env.FOXWARM_EXEC_PARALLEL_LAUNCH_ONLY === '1') {
    await fixture.stop(); stopped = true; console.log(JSON.stringify({ ok: true, launchOnly: true, root: fixture.root, hostPids, requests: records.length }))
  } else {
  const capped = await create('capped'), ids = Array.from({ length: 6 }, (_, index) => 'cap' + (index + 1))
  await send(capped, 'capped', ids.map(id => call(id, shell(id)))); await started(ids.slice(0, 4))
  assert(!await exists(join(marks, 'start-cap5'))); assert(!await exists(join(marks, 'start-cap6')))
  const initial = await history(capped); assert(initial.messages.some(row => row.parts?.filter(part => part.functionCall).length === 6)); assert(!initial.messages.some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'cap1')))
  await release('cap3'); await started(['cap5']); assert(!await exists(join(marks, 'start-cap6'))); assert.equal((await history(capped)).session.runtimeState.state, 'running-tool')
  await release('cap5'); await started(['cap6']); await release('cap6'); await until(() => exists(join(marks, 'done-cap6')), 'out-of-order task finished')
  for (const id of ['cap1', 'cap2', 'cap4']) await release(id); await idle(capped)
  const responses = (await history(capped)).messages.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'cap1')).parts.map(part => part.functionResponse)
  assert.deepEqual(responses.map(result => result.tool_use_id), ids)
  for (const result of responses) { assert(result.response.output.includes('END-' + result.tool_use_id)); assert(result.executionTiming.durationMs > 0); assert(result.executionTiming.completedAt >= result.executionTiming.startedAt) }
  assert(responses[2].executionTiming.completedAt < responses[0].executionTiming.completedAt); assert(responses[4].executionTiming.completedAt < responses[1].executionTiming.completedAt)
  const barriers = await create('barriers'), prefix = ['before1', 'before2'], suffix = ['after1', 'after2']
  await send(barriers, 'barriers', [...prefix.map(id => call(id, shell(id))), tool('file-barrier', 'write', { filePath: 'file-barrier', content: 'ordered' }), tool('neutral-barrier', 'call_tool', { toolId: 'node:master/exec', args: { command: shell('neutral'), timeout: 60 } }), ...suffix.map(id => call(id, shell(id)))])
  await started(prefix); assert(!await exists(join(own, 'file-barrier'))); assert(!await exists(join(marks, 'start-neutral')))
  for (const id of prefix) await release(id); await started(['neutral']); assert(await exists(join(own, 'file-barrier'))); for (const id of suffix) assert(!await exists(join(marks, 'start-' + id)))
  await release('neutral'); await started(suffix); for (const id of suffix) await release(id); await idle(barriers)
  await mkdir(join(own, 'explicit'), { recursive: true }); const explicit = await create('explicit')
  await send(explicit, 'explicit', [call('cwd-own', 'pwd'), call('cwd-explicit', 'pwd', { cwd: 'explicit' }), call('ordinary-exit', 'printf ordinary; exit 7'), tool('malformed', 'exec', {}, '{"command":'), call('single-cancel', 'touch canceled-effect', { __cancelTool: true }), tool('invalid-control', 'exec', { command: 'touch invalid-control-effect', __cancelTool: false })]); await idle(explicit)
  assert((await pair(explicit, 'cwd-own')).response.output.includes(own)); assert((await pair(explicit, 'cwd-explicit')).response.output.includes(join(own, 'explicit'))); assert((await pair(explicit, 'ordinary-exit')).response.output.includes('Exit code: 7'))
  assert.equal((await pair(explicit, 'malformed')).response.error.type, 'invalid_tool_arguments'); assert(!(await pair(explicit, 'malformed')).executionTiming)
  assert((await pair(explicit, 'single-cancel')).response.canceled); assert.equal((await pair(explicit, 'invalid-control')).response.error.type, 'invalid_tool_control_argument'); assert(!await exists(join(own, 'canceled-effect'))); assert(!await exists(join(own, 'invalid-control-effect')))
  const canceled = await create('canceled'); await send(canceled, 'canceled', [call('global-first', 'touch canceled-first'), call('global-second', 'touch canceled-second', { __cancelAllToolsThisTurn: true })]); await idle(canceled); assert((await pair(canceled, 'global-first')).response.canceled); assert(!await exists(join(own, 'canceled-first')))
  await send(canceled, 'malformed-cancellation', [call('not-globally-canceled', 'touch malformed-not-canceled'), tool('malformed-cancellation', 'exec', {}, '{"__cancelAllToolsThisTurn":true,"command":')]); await idle(canceled)
  assert(await exists(join(own, 'malformed-not-canceled'))); assert.equal((await pair(canceled, 'malformed-cancellation')).response.error.type, 'invalid_tool_arguments')
  const ruled = await create('ruled'); await writeFile(join(own, 'deny-policy.yaml'), 'version: 1\nrules: [{id: command, action: deny, match: {tool: {source: node, name: exec}, args: {command: "touch ordinary-denied-effect"}}}]')
  await send(ruled, 'ordinary-denied', [tool('install-ordinary-policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: 'deny-policy.yaml' } }), call('allowed-one', 'printf allowed-one'), call('ordinary-denied', 'touch ordinary-denied-effect'), call('allowed-two', 'printf allowed-two')]); await idle(ruled)
  assert.equal((await pair(ruled, 'ordinary-denied')).response.error.type, 'tool_authorization_denied'); assert(!(await pair(ruled, 'ordinary-denied')).executionTiming); assert(!await exists(join(own, 'ordinary-denied-effect'))); assert((await pair(ruled, 'allowed-two')).response.output.includes('allowed-two'))
  await writeFile(join(own, 'allow-policy.yaml'), 'version: 1\n'); await send(ruled, 'ordinary-repaired', [tool('install-allow-policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: 'allow-policy.yaml' } })]); await idle(ruled)
  const policy = join(fixture.data, 'state/tool-authorization.yaml')
  const loss = await create('loss'), held = ['loss1', 'loss2', 'loss3', 'loss4']
  await writeFile(policy, 'version: 1\n'); await send(loss, 'loss', [...held.map(id => call(id, shell(id))), call('loss5', 'touch loss5-effect'), call('loss6', 'touch loss6-effect'), tool('loss-preset', 'exec', { command: 'touch loss-preset-effect', __cancelTool: true }), tool('loss-later-file', 'write', { filePath: 'loss-file-effect', content: 'forbidden' })]); await started(held)
  await send(loss, 'retained'); await sleep(11000); await writeFile(policy, 'version: 1\nrules: null\n'); const beforeLoss = records.length
  await release('loss4'); await until(async () => await exists(join(marks, 'done-loss4')) && (await history(loss)).session.runtimeState.state === 'running-tool', 'first sibling returns while others remain active'); await sleep(300)
  assert(!await exists(join(own, 'loss5-effect'))); assert(!await exists(join(own, 'loss6-effect'))); assert(!await pair(loss, 'loss1')); assert.equal(records.length, beforeLoss)
  for (const id of held.slice(0, 3)) await release(id); await until(async () => !(await history(loss)).session.busy, 'trusted fatal settles every started sibling')
  assert.equal((await pair(loss, 'loss5')).response.error.type, 'TOOL_AUTH_POLICY_UNAVAILABLE'); assert.equal((await pair(loss, 'loss6')).response.error.type, 'tool_call_skipped'); assert((await pair(loss, 'loss-preset')).response.canceled); assert(!await exists(join(own, 'loss-file-effect')))
  assert.equal((await saved(loss)).queue.length, 1); assert.equal(records.length, beforeLoss); await sleep(150); assert.equal(records.length, beforeLoss)
  await writeFile(policy, 'version: 1\n'); await send(loss, 'repaired'); await idle(loss); assert((await history(loss)).messages.some(row => row.parts?.some(part => part.text === 'DONE-repaired')))
  const stoppedId = await create('stopped'), stopHeld = ['stop1', 'stop2', 'stop3', 'stop4']
  await send(stoppedId, 'stopped', [...stopHeld.map(id => call(id, shell(id))), call('stop5', 'touch stop5-effect')]); await started(stopHeld)
  assert.equal((await fixture.api('POST', route(stoppedId) + '/stop', {})).status, 200); await until(async () => !(await history(stoppedId)).session.busy, 'Stop complete pairing settles launched calls')
  for (const id of stopHeld) { const value = await pair(stoppedId, id); assert(value.response.output.includes('execId:')); assert(!await exists(join(marks, 'done-' + id))) }
  assert(!await exists(join(own, 'stop5-effect'))); assert((await pair(stoppedId, 'stop5')).response.canceled)
  for (const id of stopHeld) await release(id); await until(async () => (await Promise.all(stopHeld.map(id => exists(join(marks, 'done-' + id))))).every(Boolean), 'Stop leaves shells alive to finish once')
  const overridden = await create('overridden'), overrideHeld = ['override1', 'override2', 'override3', 'override4']
  await send(overridden, 'overridden', [...overrideHeld.map(id => call(id, shell(id))), call('override5', 'touch override5-effect')]); await started(overrideHeld)
  await send(overridden, 'queued-override'); assert.equal((await fixture.api('POST', route(overridden) + '/message', { text: '/dequeue' })).status, 200); await idle(overridden)
  assert((await history(overridden)).messages.some(row => row.parts?.some(part => part.text === 'DONE-queued-override'))); assert(!await exists(join(own, 'override5-effect')))
  for (const id of overrideHeld) { assert(!await exists(join(marks, 'done-' + id))); await release(id) }
  await until(async () => (await Promise.all(overrideHeld.map(id => exists(join(marks, 'done-' + id))))).every(Boolean), 'override never replays or kills launched siblings')
  const deleting = await create('deleting'), deleteHeld = ['delete1', 'delete2', 'delete3', 'delete4']
  await send(deleting, 'deleting', [...deleteHeld.map(id => call(id, shell(id))), call('delete5', 'touch delete5-effect')]); await started(deleteHeld)
  assert.equal((await fixture.api('DELETE', route(deleting), {})).status, 409); await until(async () => !(await history(deleting)).session.busy, 'delete Stop retry settles exact owner'); assert.equal((await fixture.api('DELETE', route(deleting), {})).status, 200)
  for (const id of deleteHeld) await release(id); await until(async () => (await Promise.all(deleteHeld.map(id => exists(join(marks, 'done-' + id))))).every(Boolean), 'retired shells not killed'); assert(!await exists(join(fixture.data, 'state/sessions', deleting + '.json'))); assert(!await exists(join(own, 'delete5-effect')))
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'x' })).status, 201)
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'invalid%2Fleaf' })).status, 400)
  const slash = await create('y', 'x')
  assert.equal((await fixture.api('DELETE', route(percent), {})).status, 200); assert(!await exists(join(fixture.data, 'state/sessions', percent + '.json'))); assert.equal((await fixture.api('GET', route(slash) + '/history')).status, 200); assert(await exists(join(fixture.data, 'state/sessions', slash + '.json')))
  assert.equal((await fixture.api('DELETE', route(slash), {})).status, 200)
  const shutting = await create('shutting'), shutdownHeld = ['shutdown1', 'shutdown2', 'shutdown3', 'shutdown4']
  await send(shutting, 'shutting', [...shutdownHeld.map(id => call(id, shell(id))), call('shutdown5', 'touch shutdown5-effect')]); await started(shutdownHeld)
  await fixture.stop(); stopped = true; const shutdownSaved = await saved(shutting); const shutdownResponses = shutdownSaved.history.flatMap(row => row.parts || []).map(part => part.functionResponse).filter(Boolean)
  assert.deepEqual(shutdownResponses.map(result => result.tool_use_id), [...shutdownHeld, 'shutdown5']); assert(shutdownResponses.at(-1).response.canceled); assert(!await exists(join(own, 'shutdown5-effect')))
  for (const id of shutdownHeld) { assert(!await exists(join(marks, 'done-' + id))); await release(id) }
  await until(async () => (await Promise.all(shutdownHeld.map(id => exists(join(marks, 'done-' + id))))).every(Boolean), 'shutdown settles invocations but preserves launched shell lifetime')
  for (const name of await readdir(marks)) if (name.startsWith('pid-')) shellPids.push(Number(await readFile(join(marks, name), 'utf8')))
  const beforeRestart = records.length; await start(); await idle(shutting); await until(async () => (await saved(shutting)).meta.acceptedExternalEventIds?.length === 4, 'restart accepts every original tracked completion once'); assert(records.length >= beforeRestart); assert(!await exists(join(fixture.data, 'state/sessions', deleting + '.json')))
  const after = await create('after-restart'); await send(after, 'after-restart', [call('restart-one', 'printf restart-once'), call('restart-two', 'printf restart-twice')]); await idle(after)
  for (const name of await readdir(marks)) if (name.startsWith('runs-')) assert.equal((await readFile(join(marks, name), 'utf8')).trim().split('\n').length, 1, 'shell never replayed: ' + name)
  assert.deepEqual(errors, []); await fixture.stop(); stopped = true
  console.log(JSON.stringify({ ok: true, root: fixture.root, hostPids, shellPids, requests: records.length, actualCap: 4, modelOrder: true, serialBarriers: true, unavailableStartedSettlement: true, originalApp: true }))
  }
} finally {
  for (const id of releases) await release(id).catch(() => {})
  if (!stopped) await fixture.stop().catch(() => {})
  console.log('Owned parallel hosts: ' + JSON.stringify({ root: fixture.root, hostPids, shellPids, stopped: true }))
  await writeFile(join(fixture.root, 'parallel-requests.json'), JSON.stringify({ records, errors }, null, 2)).catch(() => {})
  await fixture.cleanup(); peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve))
}
