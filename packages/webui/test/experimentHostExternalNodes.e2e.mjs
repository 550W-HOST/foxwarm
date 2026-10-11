// Stage-one external Node qualification against the real host and unchanged official clients.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import puppeteer from 'puppeteer-core'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const env = {}
const fixture = await createHostFixture('external-nodes', { env })
const hostUrl = fixture.origin + '/node-proof/'
env.FOXWARM_PUBLIC_BASE_URL = hostUrl
const scripts = new Map(), rounds = new Map(), errors = [], requests = [], processes = [], sockets = []
let browser
const exists = path => access(path).then(() => true, () => false)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NODE-DONE-' + key }] }]
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const peer = createServer(async (request, response) => {
  if (request.url === '/owned-page') { response.end('<html><body><h1>Owned external Node tab</h1><input id="field"></body></html>'); return }
  if (request.method !== 'POST') { response.writeHead(404); response.end(); return }
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    for (const tool of body.tools || []) { assert.equal(tool.type, 'function'); assert.equal(typeof tool.name, 'string'); assert.equal(tool.parameters?.type, 'object') }
    assert(!(body.tools || []).some(tool => tool.name === 'set_agent_isolated'), 'binding setter remains default-hidden')
    requests.push(body)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/NODE:([\w-]+)/g)].at(-1)?.[1] || 'background'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const step = scripts.get(key)?.[round]
    const output = step ? typeof step === 'function' ? await step(body) : step : final(key)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 35, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
async function turn(id, key, calls) {
  scripts.set(key, calls.length ? [calls] : []); rounds.set(key, 0)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'NODE:' + key })).status, 202)
  return until(async () => {
    if (errors.length) throw new Error(errors.join('\n'))
    const state = await saved(id), current = (await fixture.api('GET', route(id) + '/history')).body.session
    return !current.busy && !current.runtimeState.queueLength && state.history.some(row => row.parts?.some(part => part.text === 'NODE-DONE-' + key)) ? state : null
  }, 'real model/tool turn ' + key)
}
async function create(name, agent = 'main') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name })
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId
}
const nodes = async () => (await fixture.api('GET', '/api/nodes')).body.nodes
const online = id => until(async () => (await nodes()).find(node => node.id === id && node.online && node.executable), 'Node online ' + id)
function client(directory, args) {
  const child = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', hostUrl.replace(/\/$/, ''), '--no-local-trigger', ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: join(directory, 'agents') } })
  const handle = { child, output: '' }; processes.push(handle)
  child.stdout.on('data', data => { handle.output += data }); child.stderr.on('data', data => { handle.output += data })
  return handle
}
async function stopClient(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) { const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM'); await exited }
}
async function socket(credentials = null, pairing = false) {
  const query = pairing ? '?token=' + pairing : credentials ? '?id=' + credentials.nodeId + '&auth=' + credentials.authToken : '?token=' + fixture.token
  const ws = new WebSocket(hostUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/node_ws' + query)
  sockets.push(ws); const messages = []
  ws.on('message', data => messages.push(JSON.parse(data)))
  await once(ws, 'open')
  return { ws, messages, send: value => ws.send(JSON.stringify(value)), take: type => until(() => { const index = messages.findIndex(message => message.type === type); return index < 0 ? null : messages.splice(index, 1)[0] }, 'peer message ' + type) }
}
const offer = (protocol, tools = [{ name: 'probe', description: 'Synthetic protocol probe.', parameters: { type: 'object', properties: {} } }]) => ({ type: 'node_register', nodeType: 'test-peer', capabilities: { tools, features: { remoteExecBackgroundRegistration: true, externalExecOwner: true } }, ...(protocol === undefined ? {} : { nodeProtocol: protocol }) })
try {
  await fixture.start()
  assert.equal((await fetch(fixture.origin + '/node-proof/api/nodes')).status, 401)
  const commands = await fixture.api('POST', '/api/nodes/onboarding/commands', {})
  assert.equal(commands.status, 200)
  assert(commands.body.commands.bareMetal.includes(hostUrl.replace(/\/$/, '') + '/node/run.sh'))
  for (const path of ['run.sh', 'run.ps1', 'docker-compose.yaml', 'run-interactive.sh']) {
    const asset = await fetch(hostUrl + 'node/' + path); assert.equal(asset.status, 200)
    const body = await asset.text(); assert(body.length > 200); assert(!body.includes('__FOXWARM_DEFAULT_BASE_URL__'))
  }
  const archive = await fetch(hostUrl + 'node/source.tar.gz'); assert.equal(archive.status, 200); assert((await archive.arrayBuffer()).byteLength > 5000)
  const rejectedAdmin = await socket(); const rejected = once(rejectedAdmin.ws, 'close'); await rejected; assert.equal(rejectedAdmin.ws.readyState, WebSocket.CLOSED)
  const pairingToken = (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()
  const remote = join(fixture.root, 'official-cli'); await mkdir(join(remote, 'agents/main'), { recursive: true })
  const credentialPath = join(remote, 'state/credentials.json')
  let cli = client(remote, ['--id', 'official-cli', '--token', pairingToken, '--credentials-file', credentialPath])
  const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(value => value.requestedName === 'official-cli'), 'official pending request')
  assert(pending.connected)
  const publicPending = JSON.stringify((await fixture.api('GET', '/api/nodes/onboarding/pending')).body)
  assert(!publicPending.includes('tokenHash')); assert(!publicPending.includes(pairingToken))
  assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
  await online('official-cli')
  const credential = JSON.parse(await readFile(credentialPath, 'utf8'))
  assert.equal(credential.nodeId, 'official-cli'); assert(credential.authToken)
  const actor = await create('actor')
  let state = await turn(actor, 'select-write', [call('select', 'node', { action: 'select', nodeId: 'official-cli' }), call('write', 'write', { filePath: 'remote.txt', content: 'remote-one' })])
  assert.equal(pair(state, 'select').nodeId, 'official-cli'); assert.equal(state.currentNode, 'official-cli'); assert.equal(state.cwd, undefined)
  assert.equal(await readFile(join(remote, 'agents/main/remote.txt'), 'utf8'), 'remote-one')
  assert(!await exists(join(fixture.work, 'remote.txt')))
  state = await turn(actor, 'edit-patch-read', [call('edit', 'edit', { filePath: 'remote.txt', oldText: 'one', newText: 'two' }), call('patch', 'apply_patch', { input: '*** Begin Patch\n*** Update File: remote.txt\n@@\n-remote-two\n+remote-three\n*** End Patch' }), call('read', 'read', { filePath: 'remote.txt' })])
  assert(JSON.stringify(pair(state, 'read')).includes('remote-three'))
  assert.equal(await readFile(join(remote, 'agents/main/remote.txt'), 'utf8'), 'remote-three')
  state = await turn(actor, 'native', [call('native', 'run_script', { code: "call_tool('node:official-cli/write', {'filePath':'native.txt','content':'native-node'})\nreturn call_tool('read', {'filePath':'native.txt'})" })])
  assert.equal(pair(state, 'native').status, 'completed', JSON.stringify(pair(state, 'native')))
  assert.equal(pair(state, 'native').result.content, 'native-node')
  state = await turn(actor, 'main-memory', [call('memory', 'write_memory', { filePath: 'node-note.md', content: 'Main-owned note' }), call('local', 'call_tool', { toolId: 'node:master/write', args: { filePath: 'main-only.txt', content: 'Main-only' } }), call('source', 'run_script', { filePath: 'not-main.py' })])
  assert(!pair(state, 'local').error, JSON.stringify(pair(state, 'local')))
  assert.equal(await readFile(join(fixture.work, 'main-only.txt'), 'utf8'), 'Main-only')
  assert.equal(await readFile(join(fixture.work, 'memory/node-note.md'), 'utf8'), 'Main-owned note')
  assert(!await exists(join(remote, 'agents/main/main-only.txt')))
  assert.match(JSON.stringify(pair(state, 'source')), /Remote ToolScript source/)
  state = await turn(actor, 'search', [call('search', 'search_tools', { sources: ['node'], limit: 20 }), call('exec', 'call_tool', { toolId: 'node:official-cli/exec', args: { command: 'touch forbidden-exec' } })])
  assert.match(JSON.stringify(pair(state, 'search')), /node:official-cli\/read/)
  assert(!JSON.stringify(pair(state, 'search')).includes('node:official-cli/exec'))
  assert.match(JSON.stringify(pair(state, 'exec')), /completion authority/)
  assert(!await exists(join(remote, 'agents/main/forbidden-exec')))
  // A wrapped failed selection fences all later calls, including another selection.
  state = await turn(actor, 'failed-select', [call('failed', 'call_tool', { toolId: 'builtin:node', argsJson: JSON.stringify({ action: 'select', nodeId: 'missing' }) }), call('later-select', 'node', { action: 'select', nodeId: 'master' }), call('never', 'write', { filePath: 'never-started', content: 'no' })])
  assert(pair(state, 'failed').error)
  assert.equal(pair(state, 'later-select').error.type, 'tool_call_skipped'); assert.equal(pair(state, 'never').error.type, 'tool_call_skipped')
  assert.equal(state.currentNode, 'official-cli'); assert(!await exists(join(remote, 'agents/main/never-started')))
  state = await turn(actor, 'direct-failed-select', [call('direct-failed', 'node', { action: 'select', nodeId: 'missing' }), call('direct-never', 'write', { filePath: 'direct-never', content: 'no' })])
  assert(pair(state, 'direct-failed').error); assert.equal(pair(state, 'direct-never').error.type, 'tool_call_skipped')
  state = await turn(actor, 'canceled-select', [call('canceled-select', 'node', { action: 'select', nodeId: 'master', __cancelTool: true }), call('canceled-never', 'node', { action: 'select', nodeId: 'master' })])
  assert(pair(state, 'canceled-select').canceled); assert.equal(pair(state, 'canceled-never').error.type, 'tool_call_skipped'); assert.equal(state.currentNode, 'official-cli')
  const fork = await fixture.api('POST', route(actor) + '/fork', { suffix: 'remote-placement' }); assert.equal(fork.status, 200)
  assert.equal((await saved(fork.body.newSessionId)).currentNode, 'official-cli')
  const directRoot = join(fixture.root, 'direct-official'); await mkdir(join(directRoot, 'agents/main'), { recursive: true })
  const directCredential = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'direct-official' })).body
  const directClient = client(directRoot, ['--id', directCredential.nodeId, '--auth-token', directCredential.authToken, '--credentials-file', join(directRoot, 'credentials.json')]); await online('direct-official'); await stopClient(directClient)
  // Concrete targetNode authorization is shared by model and native ToolScript dispatch.
  await writeFile(join(fixture.work, 'deny-node.yaml'), 'version: 1\nrules:\n  - id: deny-remote-write\n    action: deny\n    match:\n      tool: {source: node, name: write}\n      targetNode: official-cli\n')
  state = await turn(actor, 'install-policy', [call('policy', 'set_config', { target: 'tool-rules', filePath: 'deny-node.yaml' })]); assert(!pair(state, 'policy').error, JSON.stringify(pair(state, 'policy')))
  state = await turn(actor, 'denied', [call('denied', 'write', { filePath: 'denied', content: 'no' }), call('native-denied', 'run_script', { code: "return call_tool('node:official-cli/write', {'filePath':'native-denied','content':'no'})" })])
  assert.equal(pair(state, 'denied').error.type, 'tool_authorization_denied'); assert.equal(pair(state, 'native-denied').status, 'failed')
  assert(!await exists(join(remote, 'agents/main/denied'))); assert(!await exists(join(remote, 'agents/main/native-denied')))
  await writeFile(join(fixture.work, 'restore-policy.yaml'), 'version: 1\n')
  state = await turn(actor, 'restore-policy', [call('restore-policy', 'set_config', { target: 'tool-rules', filePath: 'restore-policy.yaml' })]); assert(!pair(state, 'restore-policy').error)
  // Bound Agents are placed on the Node; explicit Main effects are denied, not locally executed.
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'bound' })).status, 201)
  state = await turn(actor, 'model-binding', [call('bind-agent', 'call_tool', { toolId: 'builtin:set_agent_isolated', args: { agentName: 'bound', nodeId: 'official-cli', toolRules: [{ effect: 'deny', source: 'node', node: 'official-cli', tool: 'edit' }] } })])
  assert(pair(state, 'bind-agent').success, JSON.stringify(pair(state, 'bind-agent')))
  assert.equal((await saved('bound/main')).currentNode, 'official-cli')
  state = await turn('bound/main', 'legacy-rule', [call('legacy-denied', 'edit', { filePath: 'deny-before-effect', oldText: 'x', newText: 'y' })]); assert.match(JSON.stringify(pair(state, 'legacy-denied')), /denied|forbidden/i)
  state = await turn(actor, 'rules-only', [call('rules-only', 'call_tool', { toolId: 'builtin:set_agent_isolated', args: { agentName: 'bound', toolRules: [] } })])
  assert(pair(state, 'rules-only').success); assert.equal((await saved('bound/main')).currentNode, 'official-cli')
  state = await turn(actor, 'model-unbinding', [call('unbind-agent', 'call_tool', { toolId: 'builtin:set_agent_isolated', args: { agentName: 'bound', nodeId: '' } })])
  assert(pair(state, 'unbind-agent').success); assert.equal((await saved('bound/main')).currentNode, 'master')
  state = await turn(actor, 'model-rebinding', [call('rebind-agent', 'call_tool', { toolId: 'builtin:set_agent_isolated', args: { agentName: 'bound', nodeId: 'official-cli' } })]); assert(pair(state, 'rebind-agent').success)
  const createdBound = await fixture.api('POST', '/api/agents', { agentId: 'born-bound', isolatedNode: 'official-cli' }); assert.equal(createdBound.status, 201); assert.equal((await saved('born-bound/main')).currentNode, 'official-cli')
  const bound = await create('owned', 'bound'); await mkdir(join(remote, 'agents/bound'), { recursive: true })
  state = await turn(bound, 'bound', [call('bound-write', 'write', { filePath: 'bound-only', content: 'bound' }), call('main-denied', 'call_tool', { toolId: 'node:master/write', args: { filePath: 'bound-escape', content: 'no' } }), call('pair-denied', 'node_pair_list', {})])
  assert.equal(state.currentNode, 'official-cli'); assert(!pair(state, 'bound-write').error)
  assert.equal(pair(state, 'main-denied').error.type, 'tool_authorization_denied'); assert.equal(pair(state, 'pair-denied').error.type, 'tool_authorization_denied')
  assert.equal(await readFile(join(remote, 'agents/bound/bound-only'), 'utf8'), 'bound')
  assert(!await exists(join(fixture.work, 'agents/bound/bound-escape')))
  // Official CLI restart uses persisted direct credentials. Main restart preserves both trust and selection.
  await stopClient(cli); await until(async () => !(await nodes()).find(node => node.id === 'official-cli').online, 'official disconnected')
  state = await turn(actor, 'offline', [call('offline', 'read', { filePath: 'remote.txt' }), call('status', 'session', { action: 'status' })])
  assert(pair(state, 'offline').error); assert(!pair(state, 'status').error)
  await fixture.stop(); await fixture.start()
  assert.equal((await saved(actor)).currentNode, 'official-cli')
  cli = client(remote, ['--credentials-file', credentialPath]); await online('official-cli')
  state = await turn(actor, 'restart-read', [call('restart-read', 'read', { filePath: 'remote.txt' })]); assert(JSON.stringify(pair(state, 'restart-read')).includes('remote-three'))
  assert(!fixture.output.includes(credential.authToken)); assert(!fixture.output.includes(pairingToken))
  const revoked = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'revoked-before-register' })).body
  const staleHandshake = await socket(revoked)
  staleHandshake.send(offer({ min: 1.5, max: 3 })); assert.match((await staleHandshake.take('error')).error, /nodeProtocol/)
  assert.equal((await fixture.api('DELETE', '/api/nodes/revoked-before-register')).status, 200)
  const fresh = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'revoked-before-register' })).body
  staleHandshake.send(offer({ min: 1, max: 3 })); assert.match((await staleHandshake.take('error')).error, /credentials were replaced/)
  assert(!(await nodes()).find(node => node.id === fresh.nodeId).online)
  // Protocol 1 legacy and 2 peers retain arbitrary JSON values. A Node without get_default_cwd stays unknown.
  const probeCredentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'probe-peer' })).body
  let probe = await socket(probeCredentials)
  probe.send(offer(undefined)); assert.equal((await probe.take('registered')).nodeProtocol.negotiated, 1)
  const begin = async (key, calls) => {
    scripts.set(key, [calls]); rounds.set(key, 0)
    assert.equal((await fixture.api('POST', route(actor) + '/message', { text: 'NODE:' + key })).status, 202)
  }
  const finish = key => until(async () => { const state = await saved(actor); return state.history.some(row => row.parts?.some(part => part.text === 'NODE-DONE-' + key)) && !(await fixture.api('GET', route(actor) + '/history')).body.session.busy ? state : null }, key)
  state = await turn(actor, 'unknown-default', [call('select-probe', 'node', { action: 'select', nodeId: 'probe-peer' })]); assert.equal(pair(state, 'select-probe').defaultCwd, 'unknown')
  const defaultPeer = await socket(probeCredentials); defaultPeer.send(offer({ min: 1, max: 3 }, [{ name: 'probe' }, { name: 'get_default_cwd' }])); await defaultPeer.take('registered'); probe = defaultPeer
  await begin('unavailable-default', [call('select-unavailable-default', 'node', { action: 'select', nodeId: 'probe-peer' })])
  const unavailableDefault = await probe.take('tool_call'); assert.equal(unavailableDefault.tool, 'get_default_cwd')
  probe.send({ type: 'tool_call_error', callId: unavailableDefault.callId, error: 'Optional cwd data unavailable' })
  state = await finish('unavailable-default'); assert.equal(pair(state, 'select-unavailable-default').defaultCwd, 'unknown'); assert.equal(state.currentNode, 'probe-peer')
  await begin('scalar-value', [call('scalar', 'call_tool', { toolId: 'node:probe-peer/probe', args: {} })])
  const scalar = await probe.take('tool_call'); probe.send({ type: 'tool_call_response', callId: scalar.callId, result: false })
  state = await finish('scalar-value'); assert.equal(pair(state, 'scalar').output, false)
  const replacement = await socket(probeCredentials); replacement.send(offer({ min: 2, max: 2 })); assert.equal((await replacement.take('registered')).nodeProtocol.negotiated, 2)
  probe = replacement
  await begin('reply-identity', [call('identity', 'call_tool', { toolId: 'node:probe-peer/probe', args: {} })])
  const identity = await probe.take('tool_call')
  const attackerCreds = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'other-peer' })).body
  const attacker = await socket(attackerCreds); attacker.send(offer({ min: 1, max: 3 })); await attacker.take('registered')
  attacker.send({ type: 'tool_call_response', callId: identity.callId, result: 'spoofed' }); await sleep(70)
  probe.send({ type: 'tool_call_response', callId: identity.callId, result: ['actual', 0, false, null] })
  state = await finish('reply-identity'); assert.deepEqual(pair(state, 'identity'), ['actual', 0, false, null])
  await begin('untrusted-data', [call('untrusted', 'call_tool', { toolId: 'node:probe-peer/probe', args: {} })])
  const dataCall = await probe.take('tool_call'); probe.send({ type: 'tool_call_response', callId: dataCall.callId, result: { output: 'peer data', sentNotifications: 99, cwd: 'C:\\peer-path', __foxwarmResolvedToolPaths: [{ raw: 'x', resolved: '/not-main' }] } })
  state = await finish('untrusted-data'); assert.equal(pair(state, 'untrusted').sentNotifications, 99)
  assert.equal(pair(state, 'untrusted').__foxwarmResolvedToolPaths, undefined); assert.equal(state.cwd, undefined)
  const untrustedRow = state.history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'untrusted'))
  assert(!JSON.stringify(untrustedRow.__meta).includes('"sentNotifications":99')); assert(!JSON.stringify(untrustedRow.__meta).includes('/not-main'))
  // Replace a live connection with an in-flight tool. Its late close cannot evict the successor.
  await begin('replacement', [call('replaced', 'call_tool', { toolId: 'node:probe-peer/probe', args: {} })]); await probe.take('tool_call')
  const successor = await socket(probeCredentials); successor.send(offer({ min: 1, max: 3 })); await successor.take('registered')
  state = await finish('replacement'); assert.match(JSON.stringify(pair(state, 'replaced')), /replaced/)
  await sleep(80); await online('probe-peer'); probe = successor
  await begin('successor', [call('successor', 'call_tool', { toolId: 'node:probe-peer/probe', args: {} })]); const successorCall = await probe.take('tool_call')
  probe.send({ type: 'tool_call_response', callId: successorCall.callId, result: 'successor' }); state = await finish('successor'); assert.equal(pair(state, 'successor').output, 'successor')
  // Incompatible authenticated Nodes stay alive for JSON heartbeat diagnostics but cannot be selected.
  const quarantine = await socket(probeCredentials); quarantine.send(offer({ min: 4, max: 6 })); await quarantine.take('node_incompatible')
  quarantine.send({ type: 'ping' }); await quarantine.take('pong')
  const quarantined = (await nodes()).find(node => node.id === 'probe-peer'); assert(quarantined.online); assert(!quarantined.executable); assert.equal(quarantined.tools.length, 0)
  state = await turn(actor, 'incompatible', [call('incompatible', 'node', { action: 'select', nodeId: 'probe-peer' }), call('skip', 'node', { action: 'select', nodeId: 'master' })])
  assert(pair(state, 'incompatible').error); assert.equal(pair(state, 'skip').error.type, 'tool_call_skipped')
  quarantine.send({ type: 'node_register', ...offer({ min: 1.5, max: 3 }) }); await quarantine.take('error')
  // An approved, disconnected pairing is claimed by the real official client, not a stub.
  const offlineRequest = await socket(null, pairingToken)
  offlineRequest.send({ ...offer({ min: 1, max: 3 }), type: 'pair_request', requestedName: 'offline-claim', nodeType: 'cli-node' })
  const offlinePending = await offlineRequest.take('pair_pending'); offlineRequest.ws.close(); await once(offlineRequest.ws, 'close')
  assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: offlinePending.pendingId })).status, 200)
  const claimRoot = join(fixture.root, 'claim-cli'); await mkdir(join(claimRoot, 'agents/main'), { recursive: true })
  const claimedCli = client(claimRoot, ['--id', 'offline-claim', '--token', pairingToken, '--credentials-file', join(claimRoot, 'credentials.json')]); await online('offline-claim'); await stopClient(claimedCli)
  const rejectRequest = await socket(null, pairingToken); rejectRequest.send({ ...offer(undefined), type: 'pair_request', requestedName: 'reject-owned' })
  const rejectPending = await rejectRequest.take('pair_pending'); assert.equal((await fixture.api('POST', '/api/nodes/onboarding/reject', { pendingId: rejectPending.pendingId })).status, 200); await rejectRequest.take('pair_rejected')
  // Browser extension uses the unchanged MV3 service worker, real Chrome tabs and its 25-second JSON heartbeat.
  const extension = resolve('packages/browser-node')
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, userDataDir: join(fixture.root, 'extension-browser'), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions-except=' + extension, '--load-extension=' + extension] })
  const target = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'), { timeout: 15000 })
  const popup = await browser.newPage()
  const extensionId = new URL(target.url()).host
  await popup.goto('chrome-extension://' + extensionId + '/popup/popup.html')
  await popup.evaluate(async ({ host, token }) => {
    await chrome.runtime.sendMessage({ type: 'set_default_permission', level: 'auto' })
    const result = await chrome.runtime.sendMessage({ type: 'connect', host, pairingToken: token, nodeName: 'owned-browser' })
    if (result.error) throw new Error(result.error)
  }, { host: hostUrl, token: pairingToken })
  const browserPending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(value => value.requestedName === 'owned-browser'), 'real extension pairing')
  assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: browserPending.id })).status, 200); await online('owned-browser')
  const tab = await browser.newPage(); await tab.goto(`http://127.0.0.1:${peer.address().port}/owned-page`)
  state = await turn(actor, 'browser-list', [call('browser-select', 'node', { action: 'select', nodeId: 'owned-browser' }), call('browser-list', 'browser_list_tabs', {})])
  const ownedTab = pair(state, 'browser-list').tabs.find(tab => tab.url.endsWith('/owned-page')); assert(ownedTab)
  state = await turn(actor, 'browser-text', [call('browser-text', 'browser_get_tab_content', { tabId: ownedTab.tabId, format: 'text' })]); assert.match(pair(state, 'browser-text').text, /Owned external Node tab/)
  state = await turn(actor, 'browser-image', [call('browser-image', 'browser_screenshot', { tabId: ownedTab.tabId })])
  const screenshotRow = state.history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'browser-image'))
  const image = screenshotRow.parts.find(part => part.inlineDataRef)?.inlineDataRef
  assert(image?.blobId, JSON.stringify(screenshotRow.parts.map(part => ({ keys: Object.keys(part), inlineData: part.inlineData ? Object.keys(part.inlineData) : null }))))
  assert.equal(image.mimeType, 'image/png')
  const blob = await fetch(fixture.origin + '/api/blobs/' + image.blobId, { headers: { authorization: 'Bearer ' + fixture.token } }); assert.equal(blob.status, 200); assert.equal(blob.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).subarray(0, 8)], [137,80,78,71,13,10,26,10])
  await sleep(27000); assert.equal((await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'get_state' }))).state, 'registered'); await online('owned-browser')
  await browser.close(); browser = null
  // Rename/removal are persisted trust changes, not environment destruction.
  await stopClient(cli)
  assert.equal((await fixture.api('POST', '/api/nodes/official-cli/rename', { nodeId: 'renamed-cli' })).status, 200)
  const wrong = await socket(credential); const wrongClose = once(wrong.ws, 'close'); await wrongClose
  cli = client(remote, ['--id', 'renamed-cli', '--auth-token', credential.authToken, '--credentials-file', join(remote, 'renamed.json')]); await online('renamed-cli')
  assert.equal((await fixture.api('DELETE', '/api/nodes/renamed-cli')).status, 200)
  await until(async () => !(await nodes()).some(node => node.id === 'renamed-cli'), 'removed credentials absent')
  assert(await exists(join(remote, 'agents/main/remote.txt')))
  const history = await fixture.api('GET', route(bound) + '/history'); assert.equal(history.status, 200)
  assert.equal((await fixture.api('DELETE', route(bound))).status, 200)
  assert.equal((await fixture.api('POST', '/api/nodes/onboarding/create-shell', { nodeId: 'not-a-shell' })).status, 501)
  await fixture.stop(); assert.equal(errors.length, 0)
  console.log(JSON.stringify({ result: 'passed', hostProcesses: fixture.hostPids.length, realModelRequests: requests.length, officialCli: 'pair, reconnect, credentials, files, restart, offline claim', browserExtension: 'MV3 pairing, tabs, text, screenshot image pipeline, JSON heartbeat', androidHardware: 'unavailable; not qualified', phase: 'ordinary tools only' }))
} catch (error) {
  console.error(fixture.output)
  for (const handle of processes) console.error(handle.output.replaceAll((await readFile(join(fixture.data, 'state/node_token'), 'utf8').catch(() => '')).trim(), '[pairing-token]'))
  throw error
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const ws of sockets) ws.terminate()
  for (const handle of processes) await stopClient(handle).catch(() => {})
  await fixture.cleanup(); await new Promise(done => peer.close(done))
}
