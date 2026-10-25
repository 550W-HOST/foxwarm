// Real file consumers through two unchanged official CLI clients and the original WebUI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('node-files', { env: {} })
const plans = new Map(), rounds = new Map(), requests = [], wire = [], failures = [], clients = [], sockets = new Set(), connections = new Map()
const held = new Map(), holdWrites = new Set(), credentialsByNode = new Map()
const exists = path => access(path).then(() => true, () => false)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const done = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FILES-DONE-' + key }] }]
function labels(body) {
  const ids = []
  const walk = value => {
    if (typeof value === 'string') for (const match of value.matchAll(/\[IMAGE: id=("(?:\\.|[^"\\])*")/g)) ids.push(JSON.parse(match[1]))
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item)
  }
  walk(body); return ids
}
const peer = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/NODEFILES:([\w-]+)/g)].at(-1)?.[1]
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const names = new Set((body.tools || []).filter(tool => tool.type === 'function').map(tool => tool.name))
    const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || done(key)
    for (const tool of output.filter(part => part.type === 'function_call')) assert(names.has(tool.name), 'provider requires advertised function ' + tool.name)
    requests.push({ key, round, body, ids: labels(body), emitted: output.filter(part => part.type === 'function_call').map(part => part.name) })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 50, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
const proxyServer = createServer(), proxy = new WebSocketServer({ server: proxyServer, maxPayload: 75 * 1024 * 1024 })
proxyServer.listen(0, '127.0.0.1'); await once(proxyServer, 'listening')
const nodeHost = `http://127.0.0.1:${proxyServer.address().port}`
proxy.on('connection', (downstream, request) => {
  const node = new URL(request.url, nodeHost).searchParams.get('id'), upstream = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url, { maxPayload: 75 * 1024 * 1024 })
  connections.set(node, { downstream, upstream }); sockets.add(downstream); sockets.add(upstream)
  const pending = []
  upstream.on('open', () => { for (const bytes of pending) upstream.send(bytes) })
  downstream.on('message', bytes => {
    const value = JSON.parse(bytes), entry = { node, direction: 'reply', type: value.type, callId: value.callId, transferId: value.transferId, size: value.file?.sizeBytes || value.result?.sizeBytes }
    if (typeof value.result?.content === 'string') entry.completeText = { content: value.result.content, truncated: value.result.truncated, sizeBytes: value.result.sizeBytes, selectedBytes: value.result.selectedBytes }
    wire.push(entry)
    const request = wire.find(entry => entry.direction === 'request' && entry.transferId === value.transferId)
    if (value.type === 'file_write_response' && holdWrites.has(request?.sessionId)) { held.set(request.sessionId, { upstream, bytes }); return }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString()); else pending.push(bytes.toString())
  })
  upstream.on('message', bytes => {
    const value = JSON.parse(bytes)
    wire.push({ node, direction: 'request', type: value.type, callId: value.callId, programmatic: value.programmatic, transferId: value.transferId, filePath: value.filePath, sessionId: value.sessionId, agentName: value.agentName, restrict: value.restrictToAgentDir, size: value.dataBase64?.length, tool: value.tool, args: value.args, sessionCwd: value.sessionCwd })
    if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes.toString())
  })
  for (const [source, target] of [[downstream, upstream], [upstream, downstream]]) {
    source.on('close', () => { sockets.delete(source); if (target.readyState === WebSocket.OPEN) target.close() })
    source.on('error', () => {})
  }
})
const homes = Object.fromEntries(['one', 'two'].map(node => [node, { runtime: join(fixture.root, node + '-default'), agents: join(fixture.root, node + '-agent-store'), project: join(fixture.root, node + '-project') }]))
const nodes = async () => (await fixture.api('GET', '/api/nodes')).body.nodes
async function online(node) { return until(async () => (await nodes()).find(value => value.id === node && value.online && value.executable), 'official CLI ' + node, 30000) }
async function create(name, agent = 'main') { const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.sessionId }
async function begin(id, key, steps) { plans.set(key, steps); rounds.set(key, 0); assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'NODEFILES:' + key })).status, 202) }
async function finish(id, key, timeout = 60000) {
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const value = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
    return !view.busy && value.history.some(row => row.parts?.some(part => part.text === 'FILES-DONE-' + key)) ? value : null
  }, key, timeout)
}
async function turn(id, key, steps) { await begin(id, key, steps); return finish(id, key) }
function good(state, id) { const value = pair(state, id); assert(value && !value.error, JSON.stringify(value)); return value }
const copy = (id, sourceNode, sourcePath, targetNode, targetPath, overwrite) => call(id, 'copy_between_nodes', { sourceNode, sourcePath, targetNode, targetPath, ...(overwrite === undefined ? {} : { overwrite }) })
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 140, g: 20, b: 80, alpha: 1 } } }).png().toBuffer()
const headers = { authorization: 'Bearer ' + fixture.token }
async function upload(bytes, name = 'input.txt', mime = 'text/plain') { const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), name); const response = await fetch(fixture.origin + '/api/upload', { method: 'POST', headers, body: form }); assert.equal(response.status, 200); return response.json() }
try {
  await fixture.start()
  for (const [node, paths] of Object.entries(homes)) {
    for (const path of [paths.runtime, paths.project, join(paths.agents, 'main'), join(paths.agents, 'bound')]) await mkdir(path, { recursive: true })
    const credentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: node })).body
    credentialsByNode.set(node, credentials)
    const clientArgs = node === 'two'
      ? ['-e', `const {NodeClient} = require(${JSON.stringify(resolve('packages/cli-node/dist/client.js'))}); const client = new NodeClient(${JSON.stringify({ host: nodeHost, nodeId: node, authToken: credentials.authToken, credentialsFile: join(paths.runtime, 'credentials.json'), localTrigger: false }).slice(0, -1)}, toolCallInterceptor: async (tool, args) => tool !== 'read' || !args.filePath.endsWith('reject.py')}); client.connect(); process.on('SIGTERM', async () => { await client.disconnect(); process.exit(0) });`]
      : [resolve('packages/cli-node/dist/client.js'), '--host', nodeHost, '--id', node, '--auth-token', credentials.authToken, '--credentials-file', join(paths.runtime, 'credentials.json'), '--no-local-trigger']
    const child = spawn(process.execPath, clientArgs, { cwd: paths.runtime, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: paths.agents } })
    const handle = { child, output: '' }; clients.push(handle)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-20000) })
    await online(node)
  }
  const actor = await create('files-owner'), target = await create('delivery-target')
  assert.equal((await fixture.api('POST', route(target) + '/message', { text: '/session unparent' })).status, 200)
  let state = await turn(actor, 'select', [[call('select', 'node', { action: 'select', nodeId: 'one' })]])
  good(state, 'select'); assert.equal((await fixture.api('POST', route(actor) + '/cwd', { cwd: homes.one.project })).status, 200)
  const binary = Buffer.from(Array.from({ length: 1024 * 1024 + 7 }, (_, i) => i % 256)), unicode = '中文 café 🦊\n', remoteOne = join(homes.one.agents, 'main'), remoteTwo = join(homes.two.agents, 'main')
  await writeFile(join(fixture.work, '二进制.bin'), binary); await writeFile(join(remoteOne, '中文.txt'), unicode); await writeFile(join(homes.one.project, 'cwd-only.txt'), 'real selected cwd')
  state = await turn(actor, 'copies', [[copy('to-one', 'master', '二进制.bin', 'one', 'nested/binary.bin'), copy('between', 'one', 'nested/binary.bin', 'two', 'copied.bin'), copy('to-main', 'two', 'copied.bin', 'master', 'back.bin'), copy('unicode', 'one', '中文.txt', 'two', 'café.txt'), copy('same', 'one', '中文.txt', 'one', 'same.txt'), call('ordinary-cwd', 'read', { filePath: 'cwd-only.txt' })]])
  for (const id of ['to-one', 'between', 'to-main', 'unicode', 'same', 'ordinary-cwd']) good(state, id)
  assert(good(state, 'ordinary-cwd').output.includes('real selected cwd'))
  for (const path of [join(remoteOne, 'nested/binary.bin'), join(remoteTwo, 'copied.bin'), join(fixture.work, 'back.bin')]) assert.deepEqual(await readFile(path), binary)
  assert.equal(await readFile(join(remoteTwo, 'café.txt'), 'utf8'), unicode); assert(!await exists(join(homes.one.project, 'nested/binary.bin')))
  state = await turn(actor, 'overwrite', [[copy('no-overwrite', 'one', '中文.txt', 'two', 'copied.bin'), copy('overwrite', 'one', '中文.txt', 'two', 'copied.bin', true)]])
  assert(pair(state, 'no-overwrite').error); good(state, 'overwrite'); assert.equal(await readFile(join(remoteTwo, 'copied.bin'), 'utf8'), unicode)
  // A 50 MiB response is larger than the old 64 MiB transport frame after base64 encoding.
  const boundary = Buffer.alloc(50 * 1024 * 1024, 0x93); await writeFile(join(remoteOne, 'boundary.bin'), boundary)
  state = await turn(actor, 'boundary', [[copy('boundary', 'one', 'boundary.bin', 'master', 'boundary.bin'), copy('boundary-write', 'master', 'boundary.bin', 'two', 'boundary.bin')]])
  good(state, 'boundary'); good(state, 'boundary-write'); assert.deepEqual(await readFile(join(fixture.work, 'boundary.bin')), boundary); assert.deepEqual(await readFile(join(remoteTwo, 'boundary.bin')), boundary)
  const aboveCodeLimit = Buffer.alloc(boundary.length + 1, 0x71)
  await writeFile(join(fixture.work, 'above-code-limit.bin'), aboveCodeLimit)
  const writesBefore = wire.filter(entry => entry.type === 'file_write_request').length
  state = await turn(actor, 'above-code-limit', [[copy('above-code-limit', 'master', 'above-code-limit.bin', 'two', 'above-code-limit.bin')]])
  good(state, 'above-code-limit'); assert.equal(wire.filter(entry => entry.type === 'file_write_request').length, writesBefore + 1); assert.deepEqual(await readFile(join(remoteTwo, 'above-code-limit.bin')), aboveCodeLimit)
  // Whole source after hundreds of comment lines, from Session cwd, runs in Main Monty with normal nested routing.
  const source = '# source beyond ordinary preview\n' + '# bounded full source 中文\n'.repeat(40000) + 'r = call_tool("builtin:copy_between_nodes", {"sourceNode": "one", "sourcePath": "中文.txt", "targetNode": "two", "targetPath": "monty-copy.txt"})\nreturn {"last_line_executed": True, "copy": r}\n' + '# trailing bounded comments\n'.repeat(40000)
  await writeFile(join(homes.one.project, 'whole.py'), source)
  state = await turn(actor, 'source', [[call('preview', 'read', { filePath: 'whole.py' }), call('source', 'run_script', { filePath: 'whole.py' })]])
  assert(!good(state, 'preview').output.includes('last_line_executed')); assert(JSON.stringify(good(state, 'source')).includes('last_line_executed')); assert.equal(await readFile(join(remoteTwo, 'monty-copy.txt'), 'utf8'), unicode)
  // File-source selection does not move Monty or nested tool dispatch. Another Node receives no unrelated owner cwd.
  await writeFile(join(fixture.work, 'main-source.py'), 'return call_tool("read", {"filePath":"cwd-only.txt"})["content"]')
  await writeFile(join(remoteTwo, 'other-source.py'), 'return call_tool("read", {"filePath":"cwd-only.txt"})["content"]')
  state = await turn(actor, 'independent-source', [[call('main-source', 'run_script', { node: 'master', filePath: '  ' + join(fixture.work, 'main-source.py') + '  ' }), call('other-source', 'call_tool', { toolId: 'builtin:start_toolscript_run', args: { node: 'two', filePath: ' other-source.py ' } }), call('inline-source-invalid', 'run_script', { node: 'master', code: 'return 1' })]])
  assert.equal(good(state, 'main-source').result, 'real selected cwd'); assert.equal(good(state, 'other-source').result, 'real selected cwd'); assert(pair(state, 'inline-source-invalid').error)
  assert.equal(wire.findLast(entry => entry.node === 'two' && entry.tool === 'read' && entry.args?.filePath === 'other-source.py').sessionCwd, undefined)
  const otherRun = JSON.parse(await readFile(join(fixture.data, 'state/toolscript-runs', good(state, 'other-source').runId + '.json'), 'utf8')); assert.equal(otherRun.sourceNode, 'two')
  await writeFile(join(remoteTwo, 'reject.py'), 'return "must not execute"')
  const rejectedTransfers = wire.filter(entry => entry.node === 'two' && entry.type === 'file_read_request').length
  state = await turn(actor, 'approval-rejected', [[call('approval-rejected', 'run_script', { node: 'two', filePath: 'reject.py' })]])
  assert(pair(state, 'approval-rejected').error); assert.equal(wire.filter(entry => entry.node === 'two' && entry.type === 'file_read_request').length, rejectedTransfers)
  for (const name of ['run_script', 'read']) {
    await writeFile(join(fixture.work, 'source-policy.yaml'), `version: 1
rules:
- id: source-denied
  action: deny
  match:
    tool: {source: ${name === 'read' ? 'node' : 'builtin'}, name: ${name}}
    targetNode: two
`)
    state = await turn(actor, 'source-policy-' + name, [[call('install-source-policy-' + name, 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'source-policy.yaml') } })]]); good(state, 'install-source-policy-' + name)
    const readsBefore = wire.filter(entry => entry.node === 'two' && entry.tool === 'read').length
    state = await turn(actor, 'source-denied-' + name, [[call('source-denied-' + name, 'run_script', { node: 'two', filePath: 'other-source.py' })]])
    assert(pair(state, 'source-denied-' + name).error); assert.equal(wire.filter(entry => entry.node === 'two' && entry.tool === 'read').length, readsBefore)
  }
  await writeFile(join(fixture.work, 'source-policy.yaml'), 'version: 1\nrules: []\n')
  state = await turn(actor, 'source-policy-clear', [[call('source-policy-clear', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'source-policy.yaml') } })]]); good(state, 'source-policy-clear')
  await writeFile(join(homes.one.project, 'invalid.py'), Buffer.from([0xff, 0xfe]))
  state = await turn(actor, 'invalid-source', [[call('invalid-source', 'run_script', { filePath: 'invalid.py' })]])
  assert(pair(state, 'invalid-source').error || pair(state, 'invalid-source').status === 'failed')
  const waitingSource = 'print("before")\nanswer = ask_agent("Continue remote source?")\nr = call_tool("read", {"filePath": "café.txt"})\nreturn {"answer": answer, "remote": r["content"]}\n'
  await writeFile(join(homes.one.project, 'waiting.py'), waitingSource)
  state = await turn(actor, 'source-wait', [[call('source-wait', 'run_script', { filePath: 'waiting.py', mode: 'background' })]])
  const paused = good(state, 'source-wait'); assert.equal(paused.status, 'waiting'); assert.equal(paused.stdout, 'before\n')
  const sourceReads = wire.filter(entry => entry.type === 'file_read_request' && entry.filePath === join(homes.one.project, 'waiting.py')).length
  assert.equal(sourceReads, 0, 'Complete approved programmatic content does not require a second transfer.')
  const sourceRequest = wire.findLast(entry => entry.node === 'one' && entry.tool === 'read' && entry.args?.filePath === 'waiting.py')
  assert.equal(sourceRequest.programmatic, true)
  const sourceReply = wire.find(entry => entry.node === 'one' && entry.direction === 'reply' && entry.callId === sourceRequest.callId)
  assert.deepEqual(sourceReply.completeText, { content: waitingSource, truncated: false, sizeBytes: Buffer.byteLength(waitingSource), selectedBytes: Buffer.byteLength(waitingSource) })
  const sourceApprovals = wire.filter(entry => entry.node === 'one' && entry.tool === 'read' && entry.args?.filePath === 'waiting.py').length
  await writeFile(join(homes.one.project, 'waiting.py'), 'call_tool("node:one/write", {"filePath": "must-not-reload", "content": "forbidden"})\nreturn "changed"')
  state = await turn(actor, 'source-continue', [[call('source-select-two', 'node', { action: 'select', nodeId: 'two' }), call('source-continue', 'continue_script', { runId: paused.runId, continuationId: paused.continuationId, input: 'accepted' })]])
  const resumed = good(state, 'source-continue'); assert.equal(resumed.status, 'completed'); assert.deepEqual(resumed.result, { answer: 'accepted', remote: unicode })
  assert.equal(wire.filter(entry => entry.type === 'file_read_request' && entry.filePath === join(homes.one.project, 'waiting.py')).length, sourceReads); assert.equal(wire.filter(entry => entry.node === 'one' && entry.tool === 'read' && entry.args?.filePath === 'waiting.py').length, sourceApprovals); assert(!await exists(join(remoteOne, 'must-not-reload')))
  state = await turn(actor, 'source-return-one', [[call('source-return-one', 'node', { action: 'select', nodeId: 'one' })]])
  good(state, 'source-return-one'); assert.equal((await fixture.api('POST', route(actor) + '/cwd', { cwd: homes.one.project })).status, 200)
  // Concrete source and destination permission decisions; neither denial dispatches a transfer.
  for (const [operation, node] of [['sourceNode', 'one'], ['targetNode', 'two']]) {
    const policy = `version: 1\nrules:\n- id: endpoint\n  action: deny\n  match:\n    tool: {source: builtin, name: copy_between_nodes}\n    args: {${operation}: ${node}}\n`
    await writeFile(join(fixture.work, 'policy.yaml'), policy)
    state = await turn(actor, 'policy-' + operation, [[call('policy-' + operation, 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
    good(state, 'policy-' + operation)
    const before = wire.filter(entry => entry.type?.startsWith('file_') && entry.direction === 'request').length
    state = await turn(actor, 'denied-' + operation, [[copy('denied-' + operation, 'one', '中文.txt', 'two', 'denied.txt')]])
    assert(pair(state, 'denied-' + operation).error); assert.equal(wire.filter(entry => entry.type?.startsWith('file_') && entry.direction === 'request').length, before)
  }
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules: []\n')
  state = await turn(actor, 'clear-policy', [[call('clear-policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
  good(state, 'clear-policy')
  const outsideCopy = join(fixture.root, 'outside-copy.txt'); await writeFile(outsideCopy, 'permitted non-isolated outside bytes')
  state = await turn(actor, 'outside-copy', [[copy('outside-copy', 'master', outsideCopy, 'one', 'outside-copy.txt')]])
  good(state, 'outside-copy'); assert.equal(await readFile(join(remoteOne, 'outside-copy.txt'), 'utf8'), 'permitted non-isolated outside bytes')
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules:\n- id: endpoint-path\n  action: deny\n  match:\n    tool: {source: builtin, name: copy_between_nodes}\n    path: {arg: targetPath, anyNotWithin: "${agent.dir}"}\n')
  state = await turn(actor, 'path-policy', [[call('path-policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
  good(state, 'path-policy')
  const beforePathDeny = wire.filter(entry => entry.direction === 'request' && entry.type?.startsWith('file_')).length
  state = await turn(actor, 'path-denied', [[copy('path-denied', 'one', '中文.txt', 'two', 'path-denied.txt')]])
  assert(pair(state, 'path-denied').error); assert.equal(wire.filter(entry => entry.direction === 'request' && entry.type?.startsWith('file_')).length, beforePathDeny)
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules: []\n')
  state = await turn(actor, 'path-clear', [[call('path-clear', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
  good(state, 'path-clear')
  // Ordinary remote image normalization, Main crop/blob ownership, explicit other-Node export and source delivery.
  await writeFile(join(remoteOne, 'source.png'), png)
  state = await turn(actor, 'images', [
    [call('remote-image', 'read', { filePath: join(remoteOne, 'source.png') })],
    body => { const ids = labels(body); assert(ids.includes('remote-image#1')); return [call('crop', 'image_crop', { id: 'remote-image#1', x: 0, y: 0, width: 2, height: 1 })] },
    body => { assert(labels(body).includes('crop#1')); return [call('export', 'image_write_to_file', { id: 'crop#1', filePath: 'export/crop.png', node: 'two' }), call('send', 'send_file', { filePath: 'export/crop.png', node: 'two', sessionId: target })] },
  ])
  good(state, 'remote-image'); good(state, 'crop'); good(state, 'export'); const delivered = good(state, 'send')
  const cropped = await readFile(join(remoteTwo, 'export/crop.png')); assert.deepEqual(await readFile(delivered.fullPath), cropped)
  assert.deepEqual({ ...delivered.fileDelivery, deliveryId: 'unique' }, { version: 1, deliveryId: 'unique', targetKind: 'session', targetId: target, fileName: 'crop.png', mimeType: 'image/png', sizeBytes: cropped.length, downloadPath: delivered.fullPath, downloadNodeId: 'master', sourceNodeId: 'two' })
  state = await turn(actor, 'nested-delivery', [[call('nested-delivery', 'run_script', { code: `return {'receipt': call_tool('builtin:send_file', {'filePath':'export/crop.png', 'node':'two', 'sessionId':'${target}'})}` })]])
  const nestedDelivery = good(state, 'nested-delivery').result.receipt
  assert.equal(nestedDelivery.fileDelivery.sourceNodeId, 'two'); assert.equal(nestedDelivery.fileDelivery.targetId, target)
  assert.equal(nestedDelivery.fileDelivery.downloadPath, nestedDelivery.fullPath)
  assert.equal(nestedDelivery.fileDelivery.fileName, 'crop.png'); assert.equal(nestedDelivery.fileDelivery.sizeBytes, cropped.length)
  assert.notEqual(nestedDelivery.fileDelivery.deliveryId, delivered.fileDelivery.deliveryId)
  assert.deepEqual(await readFile(nestedDelivery.fullPath), cropped)
  assert(!await exists(join(homes.one.project, 'export/crop.png'))); assert(!await exists(join(fixture.work, 'export/crop.png')))
  assert.equal((await saved(target)).history.length, 0, 'sender bytes do not become destination history')
  let response = await fetch(fixture.origin + '/download?' + new URLSearchParams({ path: delivered.fullPath }), { headers }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), cropped)
  assert.equal((await fetch(fixture.origin + '/download?' + new URLSearchParams({ path: delivered.fullPath }))).status, 401)
  state = await turn(actor, 'image-failure', [[call('image-no-overwrite', 'image_write_to_file', { id: 'crop#1', filePath: 'export/crop.png', node: 'two' }), call('delivery-failure', 'send_file', { filePath: 'export/crop.png', node: 'two', channelTargetId: 'absent:conversation' })]])
  assert(pair(state, 'image-no-overwrite').error); assert(pair(state, 'delivery-failure').error); assert.deepEqual(await readFile(join(remoteTwo, 'export/crop.png')), cropped)
  state = await turn(actor, 'default-image', [[call('default-export', 'image_write_to_file', { id: 'crop#1', filePath: 'default/crop.png' }), call('default-send', 'send_file', { filePath: 'default/crop.png' }), call('master-export', 'image_write_to_file', { id: 'crop#1', filePath: join(fixture.work, 'explicit-master.png'), node: 'master' })]])
  good(state, 'default-export'); good(state, 'default-send'); good(state, 'master-export')
  assert.deepEqual(await readFile(join(remoteOne, 'default/crop.png')), cropped); assert.deepEqual(await readFile(join(fixture.work, 'explicit-master.png')), cropped)
  assert(!await exists(join(homes.one.project, 'default/crop.png')))
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules:\n- id: ordinary-remote-files\n  action: deny\n  match:\n    tool: {source: node, name: [read, write]}\n    targetNode: [one, two]\n')
  state = await turn(actor, 'node-file-deny-policy', [[call('node-file-deny-policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
  good(state, 'node-file-deny-policy')
  const deniedSourceReadsBefore = wire.filter(entry => entry.type === 'file_read_request' && entry.filePath === join(homes.one.project, 'waiting.py')).length
  state = await turn(actor, 'builtin-grants', [[copy('builtin-copy', 'one', '中文.txt', 'two', 'builtin-copy.txt'), call('builtin-export', 'image_write_to_file', { id: 'crop#1', filePath: 'builtin/crop.png', node: 'two' }), call('builtin-send', 'send_file', { filePath: 'builtin/crop.png', node: 'two', sessionId: target }), call('denied-ordinary-read', 'call_tool', { toolId: 'node:one/read', args: { filePath: '中文.txt' } }), call('denied-source-read', 'run_script', { filePath: 'waiting.py' })]])
  for (const id of ['builtin-copy', 'builtin-export', 'builtin-send']) good(state, id)
  assert(pair(state, 'denied-ordinary-read').error); assert(pair(state, 'denied-source-read').error || pair(state, 'denied-source-read').status === 'failed')
  assert.equal(wire.filter(entry => entry.type === 'file_read_request' && entry.filePath === join(homes.one.project, 'waiting.py')).length, deniedSourceReadsBefore, 'run_script retains the real node:read source grant before transfer')
  assert.equal(await readFile(join(remoteTwo, 'builtin-copy.txt'), 'utf8'), unicode); assert.deepEqual(await readFile(join(remoteTwo, 'builtin/crop.png')), cropped)
  // Actual original picker upload into a bound Agent: Administrator ingress does not impersonate a tool caller.
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'bound' })).status, 201)
  assert.equal((await fixture.api('PUT', '/api/agents/bound', { isolatedNode: 'one' })).status, 200)
  const bound = await create('attachment-owner', 'bound')
  const page = await fixture.openApp(); await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForSelector('button[title="Download crop.png"]')
  const downloads = join(fixture.root, 'downloads'); await mkdir(downloads)
  const devtools = await page.createCDPSession(); await devtools.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.click('button[title="Download crop.png"]')
  await until(async () => (await readdir(downloads)).includes('crop.png'), 'original remote delivery tool-row download')
  assert.deepEqual(await readFile(join(downloads, 'crop.png')), cropped)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), bound); await page.waitForSelector('#file-upload')
  plans.set('picker', [body => {
    const descriptors = JSON.stringify(body).match(/node=\\"one\\" path=\\"([^"\\]+)\\"/g) || []
    assert(descriptors.length >= 2, 'provider gets actual remote file and image descriptors')
    assert(labels(body).length > 0, 'canonical Main image reaches provider')
    return done('picker')
  }])
  await page.type('[role="textbox"][aria-label="Message"]', 'NODEFILES:picker ')
  await page.$eval('#file-upload', (input, image) => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['上传 Unicode 🦊'], '输入.txt', { type: 'text/plain' })); transfer.items.add(new File([Uint8Array.from(atob(image), char => char.charCodeAt(0))], 'photo.png', { type: 'image/png' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
  }, png.toString('base64'))
  await page.waitForSelector('.foxwarm-composer-attachment-chip'); await page.click('button[aria-label="Send message"]'); state = await finish(bound, 'picker')
  const descriptors = state.history.flatMap(row => row.parts || []).filter(part => part.text?.includes('<foxwarm-')).map(part => part.text)
  assert(descriptors.every(text => text.includes('node="one"') && text.includes(join(homes.one.agents, 'bound'))))
  const uploadedPaths = descriptors.map(text => /path="([^"]+)"/.exec(text)[1])
  assert.equal(await readFile(uploadedPaths[0], 'utf8'), '上传 Unicode 🦊'); assert.deepEqual(await readFile(uploadedPaths[1]), png)
  assert(!await exists(join(fixture.data, 'agents/bound/.temp/channel-files/webui')))
  const ref = state.history.flatMap(row => row.parts || []).find(part => part.inlineDataRef)?.inlineDataRef; assert(ref?.blobId)
  response = await fetch(fixture.origin + '/api/blobs/' + ref.blobId, { headers }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  assert.equal((await fetch(fixture.origin + '/api/blobs/' + ref.blobId)).status, 401)
  await page.waitForSelector('.foxwarm-image-item img'); assert.equal(await page.$eval('.foxwarm-image-item img', image => image.naturalWidth), 3)
  state = await turn(bound, 'isolated-copy', [[copy('isolated-copy', 'one', uploadedPaths[0], 'master', 'copied.txt'), call('isolated-send', 'send_file', { filePath: uploadedPaths[0] }), copy('isolated-outside', 'master', outsideCopy, 'one', 'must-not-copy-outside'), copy('isolated-other-node', 'two', 'café.txt', 'master', 'must-not-copy-other-node'), call('isolated-target', 'send_file', { filePath: uploadedPaths[0], sessionId: actor })]])
  good(state, 'isolated-copy'); good(state, 'isolated-send')
  assert.equal(await readFile(join(fixture.data, 'agents/bound/copied.txt'), 'utf8'), '上传 Unicode 🦊')
  for (const id of ['isolated-outside', 'isolated-other-node', 'isolated-target']) assert(pair(state, id).error)
  assert(!await exists(join(homes.one.agents, 'bound/must-not-copy-outside'))); assert(!await exists(join(fixture.data, 'agents/bound/must-not-copy-other-node')))
  // Partial ingress keeps already-written remote bytes and reports the real destination without a turn commit.
  const first = await upload('partial remote', 'partial.txt'), outside = join(fixture.root, 'outside.txt'); await writeFile(outside, 'outside')
  const partial = await fixture.api('POST', route(bound) + '/message', { text: 'NODEFILES:partial', uploadedFiles: [first, { path: outside, filename: 'bad.txt' }] })
  assert.equal(partial.status, 400); assert.equal(partial.body.savedFiles.length, 1); assert.equal(partial.body.savedFiles[0].node, 'one'); assert.equal(await readFile(partial.body.savedFiles[0].path, 'utf8'), 'partial remote'); assert(!JSON.stringify((await saved(bound)).history).includes('NODEFILES:partial'))
  // A non-isolated Session selected remote retains the established Main attachment ingress.
  const normal = await upload('ordinary Main ingress')
  assert.equal((await fixture.api('POST', route(actor) + '/message', { text: 'NODEFILES:normal-ingress', uploadedFiles: [normal] })).status, 202); state = await finish(actor, 'normal-ingress')
  const normalIngress = state.history.flatMap(row => row.parts || []).map(part => part.text || part.system || '').find(text => text.includes('NODEFILES:normal-ingress') && text.includes('<foxwarm-file '))
  const normalPath = /<foxwarm-file [^>]*node="master"[^>]*path="([^"]+)"/.exec(normalIngress)?.[1]
  assert(normalPath?.startsWith(join(fixture.work, '.temp/channel-files/webui/')), normalIngress)
  assert.equal(await readFile(normalPath, 'utf8'), 'ordinary Main ingress')
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules: []\n')
  state = await turn(actor, 'node-file-clear', [[call('node-file-clear', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]])
  good(state, 'node-file-clear')
  const isolatedSource = join(fixture.data, 'agents/bound/source.py')
  await writeFile(isolatedSource, 'return "own Main source"'); await writeFile(join(homes.one.agents, 'bound/source.py'), 'return "own bound source"')
  state = await turn(bound, 'isolated-sources', [[call('isolated-main-source', 'run_script', { node: 'master', filePath: isolatedSource }), call('isolated-bound-source', 'run_script', { filePath: 'source.py' }), call('isolated-other-source', 'run_script', { node: 'two', filePath: 'other-source.py' }), call('isolated-outside-source', 'run_script', { node: 'master', filePath: join(fixture.work, 'main-source.py') })]])
  assert.equal(good(state, 'isolated-main-source').result, 'own Main source'); assert.equal(good(state, 'isolated-bound-source').result, 'own bound source')
  assert(pair(state, 'isolated-other-source').error); assert(pair(state, 'isolated-outside-source').error)
  // Stop/disconnect after a real CLI write but before its reply: preserve bytes, never replay or continue effects.
  for (const kind of ['cancel', 'disconnect']) {
    const id = await create(kind); await turn(id, 'select-' + kind, [[call('select-' + kind, 'node', { action: 'select', nodeId: 'one' })]])
    holdWrites.add(id)
    await begin(id, kind, [[call(kind, 'run_script', { code: `r = call_tool("builtin:copy_between_nodes", {"sourceNode": "two", "sourcePath": "café.txt", "targetNode": "one", "targetPath": "${kind}.txt"})\ncall_tool("node:one/write", {"filePath": "must-not-follow-${kind}", "content": "forbidden"})\nreturn r` })]])
    await until(() => held.has(id), 'real write effect awaiting reply ' + kind)
    assert.equal(await readFile(join(remoteOne, kind + '.txt'), 'utf8'), unicode)
    if (kind === 'cancel') assert.equal((await fixture.api('POST', route(id) + '/stop', {})).status, 200)
    else connections.get('one').upstream.terminate()
    await until(async () => !(await fixture.api('GET', route(id) + '/history')).body.session.busy, 'settled uncertain write ' + kind)
    holdWrites.delete(id)
    if (kind === 'cancel') { const heldReply = held.get(id); if (heldReply.upstream.readyState === WebSocket.OPEN) heldReply.upstream.send(heldReply.bytes.toString()) }
    else await online('one')
    assert.equal(wire.filter(entry => entry.direction === 'request' && entry.type === 'file_write_request' && entry.sessionId === id).length, 1)
    assert(!await exists(join(remoteOne, 'must-not-follow-' + kind))); assert(!await exists(join(fixture.work, kind + '.txt')))
  }
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'following' })).status, 201)
  state = await turn('following/main', 'following-main-select', [[call('following-main-select', 'node', { action: 'select', nodeId: 'one' })]]); good(state, 'following-main-select')
  for (const name of ['named', undefined]) {
    const response = await fixture.api('POST', '/api/sessions', { agentId: 'following', ...(name ? { sessionId: name } : {}) }); assert.equal(response.status, 200)
    const created = await saved(response.body.sessionId); assert.equal(created.currentNode, 'one'); assert.equal(created.cwd, undefined)
  }
  // Shared description edits go through TaskService, ordinary discovery and native Monty rather than a second policy path.
  state = await turn(actor, 'shared-task-create', [[call('shared-task-create', 'task', { action: 'create', title: 'shared scope' })]])
  const taskId = (await fixture.api('GET', '/api/tasks')).body.tasks.find(task => task.title === 'shared scope').id
  state = await turn(target, 'shared-task-update', [[call('shared-task-update', 'run_script', { code: `return call_tool('builtin:task', {'action':'update', 'taskId':'${taskId}', 'description':'shared replacement', 'note':'cross-session progress'})` })]])
  good(state, 'shared-task-update'); assert.equal((await fixture.api('GET', '/api/tasks/' + taskId)).body.task.description, 'shared replacement')
  state = await turn(target, 'shared-task-status-denied', [[call('shared-task-status-denied', 'task', { action: 'update', taskId, description: 'not accepted', status: 'active' })]])
  assert(pair(state, 'shared-task-status-denied').error)
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules:\n- id: task-and-remove\n  action: deny\n  match:\n    tool: {source: builtin, name: [task, node_remove]}\n')
  state = await turn(actor, 'deny-capabilities', [[call('deny-capabilities', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]]); good(state, 'deny-capabilities')
  state = await turn(target, 'denied-shared-description', [[call('denied-shared-description', 'call_tool', { toolId: 'builtin:task', args: { action: 'update', taskId, description: 'denied' } }), call('denied-active-remove', 'call_tool', { toolId: 'builtin:node_remove', args: { nodeId: 'two' } })]])
  assert(pair(state, 'denied-shared-description').error); assert(pair(state, 'denied-active-remove').error)
  assert.equal((await fixture.api('GET', '/api/tasks/' + taskId)).body.task.description, 'shared replacement'); await online('two')
  await writeFile(join(fixture.work, 'policy.yaml'), 'version: 1\nrules: []\n')
  state = await turn(actor, 'clear-capability-denial', [[call('clear-capability-denial', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: join(fixture.work, 'policy.yaml') } })]]); good(state, 'clear-capability-denial')
  const offline = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'remove-offline' })).body
  state = await turn(actor, 'remove-offline', [[call('discover-remove', 'search_tools', { query: 'node_remove', sources: ['builtin'], limit: 1 }), call('remove-offline', 'run_script', { code: 'return call_tool("builtin:node_remove", {"nodeId":"remove-offline"})' })]])
  assert(good(state, 'discover-remove').output.includes('builtin:node_remove')); assert.deepEqual(good(state, 'remove-offline').result, { nodeId: 'remove-offline', disconnected: false })
  assert(requests.every(request => !(request.body.tools || []).some(tool => tool.name === 'node_remove')))
  state = await turn(actor, 'remove-active', [[call('remove-active', 'call_tool', { toolId: 'builtin:node_remove', args: { nodeId: 'two' } })]])
  assert.deepEqual(good(state, 'remove-active'), { nodeId: 'two', disconnected: true }); assert.equal(clients[1].child.exitCode, null); assert.equal(clients[1].child.signalCode, null)
  assert(!(await nodes()).some(node => node.id === 'two')); assert.equal(await readFile(join(remoteTwo, 'other-source.py'), 'utf8'), 'return call_tool("read", {"filePath":"cwd-only.txt"})["content"]')
  const revoked = new WebSocket(fixture.origin.replace(/^http/, 'ws') + '/node_ws?id=two&auth=' + encodeURIComponent(credentialsByNode.get('two').authToken)); const [revokedCode] = await once(revoked, 'close'); assert.equal(revokedCode, 1008)
  const boundArchive = new Map(fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id = ? ORDER BY seq', [bound]).map(([seq, json]) => [seq, JSON.parse(json)]))
  for (const row of (await saved(bound)).history) assert.deepEqual(boundArchive.get(row.__meta.seq), row)
  const archive = fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id = ? ORDER BY seq', [actor]), archived = new Map(archive.map(([seq, json]) => [seq, JSON.parse(json)]))
  state = await saved(actor)
  for (const row of state.history) assert.deepEqual(archived.get(row.__meta.seq), row)
  const allCalls = state.history.flatMap(row => row.parts || []).filter(part => part.functionCall), allResponses = state.history.flatMap(row => row.parts || []).filter(part => part.functionResponse)
  for (const part of allCalls) assert.equal(allResponses.filter(reply => reply.functionResponse.tool_use_id === part.functionCall.id).length, 1)
  assert.equal(failures.length, 0)
  console.log(JSON.stringify({ hostStarts: fixture.hostPids.length, officialClients: clients.length, modelRequests: requests.length, canonicalActorPairs: allResponses.length, transferRequests: wire.filter(entry => entry.direction === 'request' && entry.type?.startsWith('file_')).length, fiftyMiBBoundary: true, remoteWholeSource: true, originalPicker: true, archiveRows: archive.length, failures: failures.length }))
  await fixture.stop()
} catch (error) { console.error(fixture.output, clients.map(client => client.output).join('\n')); throw error }
finally {
  for (const client of clients) if (client.child.exitCode === null && client.child.signalCode === null) { const exited = once(client.child, 'exit'); client.child.kill('SIGTERM'); await exited }
  for (const socket of sockets) socket.terminate(); proxy.close(); await new Promise(done => proxyServer.close(done))
  peer.closeAllConnections(); await new Promise(done => peer.close(done)); await fixture.cleanup()
}
