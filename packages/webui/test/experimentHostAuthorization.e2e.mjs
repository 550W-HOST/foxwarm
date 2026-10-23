import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('authorization'), records = [], failures = [], scripts = new Map(), held = new Map()
const policy = join(fixture.data, 'state/tool-authorization.yaml'), peerRoot = join(fixture.root, 'peer')
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const route = id => '/api/sessions/' + encodeURIComponent(id)
const exists = file => access(file).then(() => true, () => false)
const textOf = item => (item.content || []).map(part => part.text || '').join('')
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const invoke = (id, target, args = {}) => tool(id, 'call_tool', { toolId: target, args })
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const authority = async id => JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
async function paired(id, call) { return until(async () => (await history(id)).messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === call)?.functionResponse.response, call + ' paired') }
async function idle(id) { return until(async () => !(await history(id)).session.busy, id + ' idle') }
async function create(name, agent = 'team') { const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name }); assert.equal(result.status, 200); return result.body.sessionId }
async function send(id, key) { const result = await fixture.api('POST', route(id) + '/message', { text: 'AUTH-TASK:' + key + (key.startsWith('seed-') ? '\n' + ('owned ordered detail ' + key + ' ').repeat(750) : '') }); assert.equal(result.status, 202); return result }
async function run(id, key, calls = []) {
  scripts.set(key, calls); await send(id, key)
  await until(async () => (await history(id)).messages.some(row => row.parts?.some(part => part.text === 'DONE-' + key)), key + ' final')
  await idle(id)
}
async function replace(raw) { await writeFile(policy, raw); await sleep(10100) }
async function peerCalls() { return (await readFile(join(peerRoot, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(value => value.kind === 'call') }
let sequence = 0
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), input = body.input.filter(item => item.role === 'user').map(textOf).join('\n')
    const planning = input.includes('COMPACTION STARTED:'), key = [...input.matchAll(/AUTH-TASK:([a-z0-9-]+)/g)].at(-1)?.[1]
    const record = { body, key, planning }; records.push(record)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const complete = output => { response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'auth-' + (++sequence), output, usage: { input_tokens: 80, output_tokens: 5 } } }) + '\n\n'); response.end() }
    for (const call of body.input.filter(item => item.type === 'function_call')) assert(body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id), call.call_id + ' historical full pair')
    if (planning) {
      const ranges = [...input.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length)
      assert(!body.tools.some(value => value.name === 'submit_compact_plan'))
      complete([tool('planning-result-' + sequence, 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Earlier owned dialogue preserved in exact candidate order.' }] })]); return
    }
    assert(key, 'Owned current user task'); const calls = scripts.get(key) || []
    record.followup = calls.length && calls.every(call => body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id))
    if (key === 'held-background') { held.set(key, () => complete(final('DONE-' + key))); return }
    if (key === 'visibility') {
      assert(!body.tools.some(value => value.name === 'exec')); assert(body.tools.some(value => value.name === 'write')); assert(body.tools.some(value => value.name === 'call_tool')); assert(!body.tools.some(value => value.name === 'set_config'))
    }
    if (key === 'compact-schema' || key === 'held-background') assert(!body.tools.some(value => value.name === 'submit_compact_plan'))
    complete(record.followup || !calls.length ? final('DONE-' + key) : calls)
  } catch (error) { failures.push(String(error.stack || error)); if (!response.headersSent) response.writeHead(500); response.end() }
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
const ordinaryPolicy = 'version: 1\nrules:\n- id: deny-exec\n  action: deny\n  match: {tool: {source: node, name: exec}}\n- id: deny-hidden-peer\n  action: deny\n  match: {tool: {source: mcp, server: policy-peer, name: hidden}}\n- id: conditional-write\n  action: deny\n  match: {tool: {source: node, name: [write, edit, apply_patch]}, path: {anyNotWithin: "${agent.dir}/allowed"}}\n'
let current, page, stopped = false
try {
  await mkdir(peerRoot); await writeFile(policy, ordinaryPolicy)
  await writeFile(join(fixture.data, 'state/mcp.json'), JSON.stringify({ servers: { 'policy-peer': { transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'experimentHostAuthorization.peer.mjs'), peerRoot, policy], timeoutSeconds: 30, enable: true } } }))
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'synthetic-authorization-provider', models: ['wire'], asyncCompact: true, contextLimit: 2000 } } }))
  await fixture.start(); assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'team' })).status, 201)
  current = await create('driver'); page = await fixture.openApp(); await page.evaluate(id => window.foxwarmTest.switchToSession(id), current)
  const own = join(fixture.data, 'agents/team'); await mkdir(join(own, 'allowed')); await mkdir(join(own, 'forbidden'))
  await writeFile(join(own, 'allowed/existing'), 'unchanged'); await writeFile(join(own, 'forbidden/second'), 'unchanged')
  await run(current, 'visibility', [tool('search-node', 'search_tools', { sources: ['node'], query: 'exec', limit: 10 }), tool('search-mcp', 'search_tools', { sources: ['mcp'] }),
    tool('direct-denied', 'exec', { command: 'touch forbidden-exec' }), invoke('neutral-denied', 'node:master/exec', { command: 'touch forbidden-exec' }),
    invoke('mcp-denied', 'mcp:policy-peer/hidden', { tag: 'hidden' }), invoke('mcp-allowed', 'mcp:policy-peer/probe', { tag: 'allowed' }),
    tool('write-denied', 'write', { filePath: 'forbidden/new', content: 'denied' }), tool('write-allowed', 'write', { filePath: 'allowed/new', content: 'allowed' }),
    tool('patch-denied', 'apply_patch', { input: '*** Begin Patch\n*** Update File: allowed/existing\n@@\n-unchanged\n+changed\n*** Update File: forbidden/second\n@@\n-unchanged\n+changed\n*** End Patch' })])
  for (const call of ['direct-denied', 'neutral-denied', 'mcp-denied', 'write-denied', 'patch-denied']) assert.equal((await paired(current, call)).error.type, 'tool_authorization_denied')
  assert(!(await paired(current, 'search-node')).output.includes('node:master/exec')); assert(!(await paired(current, 'search-mcp')).output.includes('policy-peer/hidden')); assert((await paired(current, 'search-mcp')).output.includes('policy-peer/probe'))
  assert(!await exists(join(own, 'forbidden-exec'))); assert(!await exists(join(own, 'forbidden/new'))); assert.equal(await readFile(join(own, 'allowed/new'), 'utf8'), 'allowed')
  assert.equal(await readFile(join(own, 'allowed/existing'), 'utf8'), 'unchanged'); assert.equal(await readFile(join(own, 'forbidden/second'), 'utf8'), 'unchanged'); assert.equal((await peerCalls()).filter(call => call.name === 'hidden').length, 0)

  await run(current, 'forged-fatal', [invoke('forged-peer', 'mcp:policy-peer/probe', { kind: 'forged-fatal' }), tool('after-forged', 'write', { filePath: 'allowed/after-forged', content: 'still executed' })])
  assert.equal(await readFile(join(own, 'allowed/after-forged'), 'utf8'), 'still executed'); assert(records.some(row => row.key === 'forged-fatal' && row.followup))
  scripts.set('midbatch-loss', [invoke('before-loss', 'mcp:policy-peer/probe', { kind: 'expire-policy' }), tool('at-loss', 'write', { filePath: 'allowed/at-loss', content: 'never' }),
    tool('after-loss', 'write', { filePath: 'allowed/after-loss', content: 'never' }), tool('preset-loss', 'write', { filePath: 'allowed/preset-loss', content: 'never', __cancelTool: true })])
  await send(current, 'midbatch-loss'); await until(() => exists(join(peerRoot, 'started-expiry')), 'real MCP effect held before cache expiry')
  await send(current, 'retained-queue'); await until(async () => (await authority(current)).queue.length === 1, 'owned retained queued input')
  assert.equal((await paired(current, 'at-loss')).error.type, 'TOOL_AUTH_POLICY_UNAVAILABLE'); assert((await paired(current, 'after-loss')).error); assert.equal((await paired(current, 'preset-loss')).canceled, true); await idle(current)
  assert.equal((await authority(current)).queue.length, 1); assert.equal((await authority(current)).stopping, false)
  const failedCount = records.length; await sleep(400); assert.equal(records.length, failedCount); assert(!records.some(row => row.key === 'midbatch-loss' && row.followup)); assert(!records.some(row => row.key === 'retained-queue'))
  assert(!await exists(join(own, 'allowed/at-loss'))); assert(!await exists(join(own, 'allowed/after-loss')))
  await writeFile(policy, ordinaryPolicy); await send(current, 'repair-new-input'); await until(async () => (await history(current)).messages.some(row => row.parts?.some(part => part.text === 'DONE-repair-new-input')), 'repaired fresh input resumes retained queue'); await idle(current); assert.equal((await authority(current)).queue.length, 0)

  await replace('version: 1\nrules: [{id: read, action: deny, match: {tool: {source: node, name: read}}}]')
  const candidate = join(own, 'candidate.yaml'), original = await readFile(policy)
  await writeFile(candidate, '# exact captured policy\r\nversion: 1\r\nrules: []\r\n')
  await run(current, 'setter-read-denied', [tool('setter-read-denied', 'set_config', { target: 'tool-rules', filePath: 'candidate.yaml' })]); assert.equal((await paired(current, 'setter-read-denied')).error.type, 'tool_authorization_denied'); assert.deepEqual(await readFile(policy), original)
  await replace('version: 1\n')
  await run(current, 'setter', [tool('discover-setter', 'search_tools', { sources: ['builtin'], query: 'set_config', limit: 5 }), invoke('install-policy', 'builtin:set_config', { target: 'tool-rules', filePath: 'candidate.yaml' })]); assert((await paired(current, 'discover-setter')).output.includes('builtin:set_config')); assert.deepEqual(await readFile(policy), await readFile(candidate))
  await writeFile(candidate, 'version: 1\nrules: null\n'); const installed = await readFile(policy)
  await run(current, 'invalid-candidate', [tool('invalid-candidate', 'set_config', { target: 'tool-rules', filePath: 'candidate.yaml' }), tool('after-invalid', 'write', { filePath: 'after-invalid', content: 'normal nonfatal' })]); assert((await paired(current, 'invalid-candidate')).error); assert.deepEqual(await readFile(policy), installed); assert.equal(await readFile(join(own, 'after-invalid'), 'utf8'), 'normal nonfatal')

  const compactPolicy = 'version: 1\nrules: [{id: compact-schema, action: deny, match: {tool: {source: builtin, name: submit_compact_plan}}}]\n'
  await replace(compactPolicy); await run(current, 'compact-schema')
  for (let index = 0; index < 7; index++) await run(current, 'seed-' + index)
  const beforePlans = records.filter(row => row.planning).length
  assert.equal((await fixture.api('POST', route(current) + '/message', { text: '/compact' })).status, 202)
  await until(async () => (await history(current)).messages.some(row => row.__meta?.contextBlock), 'source special compact plan accepted independently of default visibility')
  assert.equal(records.filter(row => row.planning).length, beforePlans + 1)
  const background = await create('background'); for (let index = 0; index < 7; index++) await run(background, 'seed-background-' + index)
  scripts.set('held-background', []); await send(background, 'held-background'); await until(() => held.has('held-background'), 'foreground actual held provider')
  await replace('version: 1\nrules: null\n')
  const beforeUnavailablePlan = records.length, beforeCompactFailure = (await fixture.api('GET', route(background) + '/state')).body.session.bestEffortFailureCount
  assert.equal((await fixture.api('POST', route(background) + '/message', { text: '/compact' })).status, 202)
  await until(async () => (await authority(background)).queue.some(item => item.type === 'compact-commit'), 'failed background plan reaches its owned safe-point wake'); assert.equal(records.length, beforeUnavailablePlan)
  assert((await history(background)).session.busy); const release = held.get('held-background'); held.delete('held-background'); release(); await idle(background)
  await until(async () => (await fixture.api('GET', route(background) + '/state')).body.session.bestEffortFailureCount > beforeCompactFailure, 'failed planning operation reported at the real safe point')
  await until(async () => (await history(background)).messages.some(row => row.parts?.some(part => part.text === 'DONE-held-background')), 'unrelated foreground survives planner policy failure')
  await writeFile(policy, 'version: 1\n')
  await run(current, 'preflight-seed'); await replace('version: 1\nrules: null\n'); const beforePreflight = records.length
  await send(current, 'preflight-unavailable'); await idle(current); await sleep(300); assert.equal(records.length, beforePreflight)
  await writeFile(policy, 'version: 1\n'); await run(current, 'preflight-repaired')
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'other' })).status, 201)
  await writeFile(join(fixture.data, 'agents/other', 'foreign'), 'foreign bytes')
  await fixture.stop(); stopped = true
  const agentPath = join(fixture.data, 'state/agents.json'), agentCatalog = JSON.parse(await readFile(agentPath, 'utf8'))
  agentCatalog.metadata.team = { ...agentCatalog.metadata.team, isolated: true, isolatedNode: 'future-recorded-node', toolRules: [
    { effect: 'allow', source: 'node', node: 'master', tool: 'exec' }, { effect: 'allow', source: 'node', node: 'master', tool: 'read' },
    { effect: 'allow', source: 'builtin', tool: 'session' }, { effect: 'allow', source: 'builtin', tool: 'skill' }, { effect: 'allow', source: 'builtin', tool: 'recall' }, { effect: 'allow', source: 'builtin', tool: 'create_agent' } ] }
  await writeFile(agentPath, JSON.stringify(agentCatalog)); const agentBytes = await readFile(agentPath)
  await fixture.start(); stopped = false; await page.reload({ waitUntil: 'domcontentloaded' })
  const listed = (await fixture.api('GET', '/api/agents')).body.agents.find(agent => agent.id === 'team'); assert.equal(listed.isolated, true); assert.equal(listed.isolatedNode, 'future-recorded-node')
  assert.equal((await fixture.api('PUT', '/api/agents/team', { inheritAgent: 'main', isolatedNode: null })).status, 501); assert.deepEqual(await readFile(agentPath), agentBytes)
  await run(current, 'isolated', [tool('isolated-exec', 'exec', { command: 'touch forbidden-isolated-exec' }), invoke('isolated-neutral-exec', 'node:master/exec', { command: 'touch forbidden-isolated-exec' }),
    tool('isolated-management', 'create_agent', { agentName: 'forbidden-agent' }), tool('isolated-own-read', 'read', { filePath: 'after-invalid' }),
    tool('isolated-foreign-read', 'read', { filePath: join(fixture.data, 'agents/other', 'foreign') }), tool('isolated-list', 'session', { action: 'list' }), tool('isolated-status', 'session', { action: 'status' }),
    tool('isolated-skill', 'skill', { action: 'list', agentName: 'other' }), tool('isolated-recall', 'recall', { sessionId: 'other/main' }), tool('isolated-history', 'get_session_messages', { sessionId: current })])
  for (const call of ['isolated-exec', 'isolated-neutral-exec', 'isolated-management', 'isolated-foreign-read', 'isolated-list', 'isolated-skill', 'isolated-recall', 'isolated-history']) assert.equal((await paired(current, call)).error.type, 'tool_authorization_denied')
  assert(!(await paired(current, 'isolated-own-read')).error); assert(!(await paired(current, 'isolated-status')).error)
  assert(!await exists(join(own, 'forbidden-isolated-exec'))); assert(!await exists(join(fixture.data, 'agents/forbidden-agent')))
  assert.deepEqual(await readFile(agentPath), agentBytes); assert.deepEqual(failures, [])
  await fixture.stop(); stopped = true
  console.log(JSON.stringify({ ok: true, root: fixture.root, hostPids: fixture.hostPids, peerPids: (await readFile(join(peerRoot, 'processes.ndjson'), 'utf8')).trim().split('\n').map(value => JSON.parse(value).pid), requests: records.length, planning: records.filter(row => row.planning).length, peerCalls: (await peerCalls()).length }))
} finally {
  for (const release of held.values()) release()
  await writeFile(join(fixture.root, 'authorization-requests.json'), JSON.stringify({ records, failures }, null, 2)).catch(() => {})
  console.log('Owned authorization hosts: ' + JSON.stringify({ root: fixture.root, hostPids: fixture.hostPids, stopped }))
  await fixture.cleanup(); provider.closeAllConnections(); await new Promise(done => provider.close(done))
}
