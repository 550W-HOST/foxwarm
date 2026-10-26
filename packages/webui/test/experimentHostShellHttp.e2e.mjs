// Existing POSIX sh/curl client against owned .NET hosts and real HTTP routes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access, readdir, stat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import Ajv from 'ajv'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const env = {  }
const fixture = await createHostFixture('shell-http', { env })
const prefix = '/shell-proof'
await writeFile(join(fixture.data, 'state/config.yaml'), (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'url: ' + fixture.origin + prefix + '\n')
const plans = new Map(), rounds = new Map(), errors = [], requests = [], clients = [], sockets = []
const tasks = [], reports = []
let droppedTask, invalidPolls = 3, lostResponse = false, blockedPollNode
const ajv = new Ajv({ strict: false })
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const exists = path => access(path).then(() => true, () => false)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SHELL-DONE-' + key }] }]
const model = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text); requests.push(body)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/SHELL:([\w-]+)/g)].at(-1)?.[1] || 'background'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const plan = plans.get(key)?.[round]
    const output = plan ? typeof plan === 'function' ? await plan(body) : plan : final(key)
    for (const item of output.filter(item => item.type === 'function_call')) {
      const definition = body.tools.find(tool => tool.name === item.name)
      assert(definition, 'Requested native function must be advertised: ' + item.name)
      const validate = ajv.compile(definition.parameters)
      assert(validate(JSON.parse(item.arguments)), JSON.stringify(validate.errors))
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 35, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
// Faults affect HTTP responses only, never commands or caller authority.
const proxy = createServer(async (request, response) => {
  try {
    if (request.url.endsWith('/poll') && request.headers['x-foxwarm-node'] === blockedPollNode) { response.writeHead(503); response.end(); return }
    if (request.url.endsWith('/poll') && invalidPolls > 0) {
      const variant = invalidPolls--
      if (variant !== 2) response.setHeader('X-Foxwarm-Shell', 'foxwarm-shell-1')
      response.setHeader('content-type', variant === 3 ? 'text/html' : 'application/x-foxwarm-shell; charset=utf-8')
      response.setHeader('X-Foxwarm-Task', 'a'.repeat(32)); response.setHeader('X-Foxwarm-Exec', 'invalid-task'); response.setHeader('X-Foxwarm-Timeout', '1')
      response.statusCode = variant === 1 ? 500 : 200
      response.end(`printf forbidden > '${join(fixture.root, 'invalid-response-effect')}'`); return
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const headers = { ...request.headers }; delete headers.host; delete headers['content-length']
    const result = await fetch(fixture.origin + request.url, { method: request.method, headers, ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
    const bytes = Buffer.from(await result.arrayBuffer())
    if (request.url.endsWith('/poll') && result.status === 200) tasks.push({ task: result.headers.get('x-foxwarm-task'), exec: result.headers.get('x-foxwarm-exec'), script: bytes.toString(), timeout: result.headers.get('x-foxwarm-timeout') })
    if (request.url.endsWith('/report')) {
      reports.push({ task: request.headers['x-foxwarm-task'], kind: request.headers['x-foxwarm-result'], status: result.status })
      if (request.headers['x-foxwarm-task'] === droppedTask && request.headers['x-foxwarm-result'] === 'finished' && result.status === 204 && !lostResponse) { lostResponse = true; response.destroy(); return }
    }
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(bytes)
  } catch { if (!response.headersSent) response.writeHead(503); response.end() }
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
const host = `http://127.0.0.1:${proxy.address().port}${prefix}`
async function create(name) { const value = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: name }); assert.equal(value.status, 200); return value.body.sessionId }
async function begin(id, key, steps) { plans.set(key, steps); rounds.set(key, 0); assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'SHELL:' + key })).status, 202) }
async function finish(id, key, timeout = 25000) {
  return until(async () => {
    if (errors.length) throw new Error(errors.join('\n'))
    const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'SHELL-DONE-' + key)) ? state : null
  }, 'native Shell turn ' + key, timeout)
}
async function turn(id, key, calls) { await begin(id, key, [calls]); return finish(id, key) }
const nodes = async () => (await fixture.api('GET', '/api/nodes')).body.nodes
const online = id => until(async () => (await nodes()).find(node => node.id === id && node.online && node.executable), 'Shell online ' + id)
async function select(id, node = 'shell-client') { const state = await turn(id, 'select-' + id.replaceAll('/', '-') + '-' + node, [call('select-' + node, 'node', { action: 'select', nodeId: node })]); assert.equal(state.currentNode, node); return pair(state, 'select-' + node) }
async function background(id, key, command, extra = []) {
  await begin(id, key, [[call('exec-' + key, 'exec', { command, timeout: 1 })], async () => {
    const result = pair(await saved(id), 'exec-' + key); assert(result.execId, JSON.stringify(result))
    return [...extra, call('wait-' + key, 'wait', { waitExecIds: [result.execId], wakeIfNoActivityAfterSeconds: null })]
  }])
  await until(async () => (await saved(id)).meta?.wait?.waitExecIds?.length === 1, 'exact background wait ' + key)
  return pair(await saved(id), 'exec-' + key).execId
}
const startup = join(fixture.root, "node's-start"), clientTmp = join(fixture.root, 'client-tmp')
const busybox = await exists('/usr/bin/busybox')
let credential
function client(id, token, script) {
  const child = spawn(busybox ? '/usr/bin/busybox' : '/bin/sh', [...(busybox ? ['ash'] : []), script, '--host=' + host, '--node-id=' + id], { cwd: startup, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_AUTH_TOKEN: token, TMPDIR: clientTmp, ...(busybox ? { PATH: join(fixture.root, 'busybox-bin') } : {}) } })
  const handle = { child, output: '' }; clients.push(handle)
  child.stdout.on('data', bytes => { handle.output += bytes }); child.stderr.on('data', bytes => { handle.output += bytes })
  return handle
}
const directHeaders = value => ({ 'X-Foxwarm-Node': value.nodeId, Authorization: 'Bearer ' + value.authToken, 'content-type': 'application/octet-stream' })
try {
  await mkdir(join(startup, 'relative'), { recursive: true }); await mkdir(clientTmp)
  if (busybox) { const bin = join(fixture.root, 'busybox-bin'); await mkdir(bin); for (const app of ['sh', 'mktemp', 'mkfifo', 'dd', 'wc', 'head', 'tail', 'cat', 'mv', 'rm', 'mkdir', 'chmod', 'sleep', 'date', 'sed', 'tr']) await symlink('/usr/bin/busybox', join(bin, app)); await symlink('/usr/bin/curl', join(bin, 'curl')) }
  await fixture.start()
  assert.equal((await fetch(fixture.origin + prefix + '/api/nodes')).status, 401)
  const created = await fixture.api('POST', '/api/nodes/onboarding/create-shell', { nodeId: 'shell-client' }); assert.equal(created.status, 200)
  const token = /NODE_AUTH_TOKEN='([a-f0-9]{64})'/.exec(created.body.command)[1]
  credential = { nodeId: 'shell-client', authToken: token }
  assert(created.body.command.includes(fixture.origin + prefix + '/node/run-shell.sh')); assert(created.body.command.includes('--host='))
  const bootstrap = await fetch(fixture.origin + prefix + '/node/run-shell.sh'); assert.equal(bootstrap.status, 200); assert.match(bootstrap.headers.get('content-type'), /shellscript/)
  // Downloaded defaults use the request origin; the authenticated command keeps its configured prefix.
  const script = await bootstrap.text(); assert.equal(script, (await readFile('templates/node/run-shell.sh', 'utf8')).replace('__FOXWARM_DEFAULT_BASE_URL__', fixture.origin))
  const downloaded = join(fixture.root, 'run-shell.sh'); await writeFile(downloaded, script)
  // A real superseded WebSocket close must not remove the HTTP successor.
  const ws = new WebSocket(fixture.origin.replace('http', 'ws') + prefix + '/node_ws?id=shell-client&auth=' + token); sockets.push(ws); await once(ws, 'open')
  const registered = once(ws, 'message'); ws.send(JSON.stringify({ type: 'node_register', nodeType: 'qualification-ws', nodeProtocol: { min: 1, max: 3 }, capabilities: { tools: [{ name: 'exec' }] } })); assert.equal(JSON.parse(String((await registered)[0])).type, 'registered')
  const closed = once(ws, 'close'); const shell = client('shell-client', token, downloaded); await closed
  const node = await online('shell-client'); assert.deepEqual(node.tools.map(tool => tool.name), ['exec']); assert.deepEqual(node.services, {})
  const actor = await create('shell-actor'); assert.equal((await select(actor)).defaultCwd, startup)
  let state = await turn(actor, 'short', [call('short', 'exec', { command: 'pwd; printf hello; exit 7' })]); assert.equal(pair(state, 'short').exitCode, 7); assert(pair(state, 'short').output.includes(startup)); assert.equal(pair(state, 'short').content, undefined)
  state = await turn(actor, 'relative', [call('relative', 'exec', { command: 'pwd', cwd: 'relative' })]); assert(pair(state, 'relative').output.includes(join(startup, 'relative')))
  await fixture.api('POST', route(actor) + '/cwd', { cwd: join(startup, 'relative') })
  state = await turn(actor, 'captured-cwd', [call('captured', 'exec', { command: 'pwd; printf captured > captured-effect' })]); assert(pair(state, 'captured').output.includes(join(startup, 'relative'))); assert.equal(await readFile(join(startup, 'relative/captured-effect'), 'utf8'), 'captured')
  const nativeCalls = [
    { name: 'short', tool: 'exec', args: { command: `printf '{"ok":true}'; printf once > native-effect; exit 7` } },
    { name: 'large', tool: 'node:shell-client/exec', args: { command: "dd if=/dev/zero bs=16384 count=1 2>/dev/null | tr '\\000' x" } },
    { name: 'binary', tool: 'exec', args: { command: "printf '\\000\\377'" } },
  ]
  const validateShell = ajv.compile(node.tools[0].parameters)
  for (const entry of nativeCalls) assert(validateShell(entry.args), JSON.stringify(validateShell.errors))
  const nativeCode = nativeCalls.map(entry => `${entry.name} = call_tool(${JSON.stringify(entry.tool)}, ${JSON.stringify(entry.args)})`).join('\n') + "\nreturn {'short': short, 'large': large, 'binary': binary}"
  state = await turn(actor, 'native-data', [call('native-data', 'run_script', { code: nativeCode })])
  const native = pair(state, 'native-data'); assert.equal(native.status, 'completed', JSON.stringify(native)); assert.equal(native.result.short.content, '{"ok":true}'); assert.equal(native.result.short.exitCode, 7); assert.equal(native.result.large.truncated, true); assert.equal(native.result.large.content, undefined); assert.equal(native.result.binary.truncated, true); assert.equal(native.result.binary.content, undefined)
  assert.equal(await readFile(join(startup, 'relative/native-effect'), 'utf8'), 'once'); assert(!await exists(join(fixture.work, 'native-effect')))
  await select(actor)
  state = await turn(actor, 'samples', [call('empty', 'exec', { command: ':' }), call('overlap', 'exec', { command: "dd if=/dev/zero bs=6000 count=1 2>/dev/null | tr '\\000' z" }), call('no-newline', 'exec', { command: 'printf no-newline' }), call('binary', 'exec', { command: "printf '\\000\\377'" }), call('fraction', 'exec', { command: 'sleep 1; printf rounded', timeout: 1.1 })])
  assert.equal(pair(state, 'empty').totalBytes, 0); assert.equal(pair(state, 'overlap').output.split('\n')[0].length, 6000); assert.equal(pair(state, 'no-newline').totalBytes, 10); assert.match(pair(state, 'binary').output, /hexadecimal.*\n00ff/); assert.equal(pair(state, 'fraction').exitCode, 0); assert.equal(tasks.find(task => task.script.includes('printf rounded')).timeout, '2')
  let largest = 0, sawHead = false
  await begin(actor, 'continuous', [[call('continuous', 'exec', { command: "dd if=/dev/zero bs=65536 count=64 2>/dev/null | tr '\\000' x", timeout: 30 })]])
  while (!pair(await saved(actor), 'continuous')) {
    for (const stateName of await readdir(clientTmp)) for (const taskName of await readdir(join(clientTmp, stateName)).catch(() => [])) if (taskName.startsWith('task-')) for (const name of ['chunk', 'head', 'tail', 'combined', 'next-tail', 'output']) {
      const info = await stat(join(clientTmp, stateName, taskName, name)).catch(() => null); if (!info) continue
      largest = Math.max(largest, info.size); assert(info.size <= 8192, name + ' is bounded during production'); if (name === 'head' && info.size === 4096) sawHead = true
    }
    await sleep(20)
  }
  state = await finish(actor, 'continuous'); assert.equal(pair(state, 'continuous').totalBytes, 4194304); assert.equal(pair(state, 'continuous').exitCode, 0); assert(pair(state, 'continuous').truncated); assert(sawHead)
  assert(!await exists(join(fixture.root, 'invalid-response-effect'))); assert.equal(invalidPolls, 0)
  // The actual 90-second online boundary is not shortened. An idle registration expires
  // while four independent 95-second jobs and two concurrent 35-second calls remain live.
  const idle = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'idle-shell' })).body
  assert.equal((await fetch(fixture.origin + prefix + '/node/shell/register', { method: 'POST', headers: directHeaders(idle), body: startup })).status, 204)
  // A second official BusyBox client expires while an already delivered job keeps running.
  const expiryCreated = await fixture.api('POST', '/api/nodes/onboarding/create-shell', { nodeId: 'expiry-client' }); assert.equal(expiryCreated.status, 200)
  const expiryToken = /NODE_AUTH_TOKEN='([a-f0-9]{64})'/.exec(expiryCreated.body.command)[1]
  const expiryClient = client('expiry-client', expiryToken, downloaded); await online('expiry-client')
  const expiryOwner = await create('expiry-owner'); await select(expiryOwner, 'expiry-client')
  const expiryExec = await background(expiryOwner, 'expiry-active', 'printf once >> expiry-effect; sleep 110; printf done')
  blockedPollNode = 'expiry-client'; const expiryStart = Date.now()
  const longStart = Date.now()
  state = await turn(actor, 'long-backgrounds', Array.from({ length: 4 }, (_, index) => call('long-' + index, 'exec', { command: `printf once >> background-${index}; sleep 95; printf background-${index}`, timeout: 1 })))
  const ids = Array.from({ length: 4 }, (_, index) => pair(state, 'long-' + index).execId); assert(ids.every(Boolean))
  const foregroundStart = Date.now(); await begin(actor, 'adjacent-foreground', [[call('first', 'exec', { command: 'printf started > foreground-first; sleep 35; printf first', timeout: 60 }), call('second', 'exec', { command: 'printf started > foreground-second; sleep 35; printf second', timeout: 60 })]])
  await until(async () => await exists(join(startup, 'foreground-first')) && await exists(join(startup, 'foreground-second')), 'both foreground effects started', 5000)
  state = await finish(actor, 'adjacent-foreground', 55000); assert(Date.now() - foregroundStart < 55000); assert.equal(pair(state, 'first').exitCode, 0); assert.equal(pair(state, 'second').exitCode, 0)
  await until(async () => { const list = await nodes(); assert(list.find(node => node.id === 'shell-client').online); const state = await saved(actor); return ids.every(id => state.meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + id)) }, 'four completions over actual 90s boundary', 75000)
  assert(Date.now() - longStart >= 90000); assert.equal((await nodes()).find(node => node.id === 'idle-shell').online, false)
  for (let index = 0; index < 4; index++) { assert.equal(await readFile(join(startup, 'background-' + index), 'utf8'), 'once'); assert.equal((await saved(actor)).meta.acceptedExternalEventIds.filter(receipt => receipt === 'remote-exec-completion:' + ids[index]).length, 1) }
  assert(Date.now() - expiryStart >= 90000); assert.equal((await nodes()).find(node => node.id === 'expiry-client').online, false)
  blockedPollNode = undefined; await online('expiry-client'); assert.equal(expiryClient.child.exitCode, null)
  const expiryState = await finish(expiryOwner, 'expiry-active', 25000)
  assert.equal(await readFile(join(startup, 'expiry-effect'), 'utf8'), 'once')
  assert.equal(expiryState.meta.acceptedExternalEventIds.filter(receipt => receipt === 'remote-exec-completion:' + expiryExec).length, 1)
  assert(reports.some(report => report.task === tasks.find(task => task.exec === expiryExec).task && report.kind === 'finished' && report.status === 204))
  const owner = await create('original-owner'); await select(owner)
  const exact = await background(owner, 'strict-save-loss', 'printf once >> completion-effect; sleep 4; printf completed', [call('switch', 'node', { action: 'select', nodeId: 'master' })])
  droppedTask = tasks.find(task => task.exec === exact).task
  state = await turn(actor, 'move-original', [call('move-original', 'call_tool', { toolId: 'builtin:move_session', args: { sessionId: owner, newSessionId: 'moved-owner' } })]); assert(!pair(state, 'move-original').error, JSON.stringify(pair(state, 'move-original')))
  state = await finish('moved-owner', 'strict-save-loss', 25000)
  await until(() => reports.filter(report => report.task === droppedTask && report.kind === 'finished').length >= 2, 'lost response then successful retry')
  assert(lostResponse); assert.equal(state.currentNode, 'master'); assert.equal(state.meta.wait, undefined); assert.equal(state.meta.acceptedExternalEventIds.filter(receipt => receipt === 'remote-exec-completion:' + exact).length, 1); assert.equal(await readFile(join(startup, 'completion-effect'), 'utf8'), 'once')
  // HTTP replacement leaves delivered tasks authorized under their original dispatch connection.
  const replaced = await create('replaced-owner'); await select(replaced)
  const replacementExec = await background(replaced, 'replacement', 'printf once >> replacement-effect; sleep 4; printf done')
  const registration = await fetch(fixture.origin + prefix + '/node/shell/register', { method: 'POST', headers: directHeaders(credential), body: startup }); assert.equal(registration.status, 204)
  await until(() => shell.child.exitCode !== null, 'superseded client stops polling'); assert(shell.output.includes('connection replaced'))
  await finish(replaced, 'replacement'); assert.equal(await readFile(join(startup, 'replacement-effect'), 'utf8'), 'once'); assert(reports.some(report => report.task === tasks.find(task => task.exec === replacementExec).task && report.status === 204))
  // Unknown process-local Main context is never recovered or replayed on restart.
  const recovering = client('shell-client', token, downloaded); await online('shell-client')
  const unknown = await create('restart-unknown'); await select(unknown)
  const unknownExec = await background(unknown, 'unknown', 'printf start >> unknown-effect; sleep 5; printf done >> unknown-effect')
  const unknownTask = tasks.find(task => task.exec === unknownExec).task
  await fixture.stop(); await fixture.start()
  await until(() => reports.some(report => report.task === unknownTask && report.kind === 'finished' && report.status === 410), 'unknown restart report rejected', 15000)
  assert.equal(await readFile(join(startup, 'unknown-effect'), 'utf8'), 'startdone'); assert(!(await saved(unknown)).meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + unknownExec))
  await online('shell-client'); assert.equal(recovering.child.exitCode, null)
  state = await turn(actor, 'after-restart', [call('after-restart', 'exec', { command: 'printf once >> recovered-effect; printf recovered' })]); assert.equal(pair(state, 'after-restart').exitCode, 0); assert.equal(await readFile(join(startup, 'recovered-effect'), 'utf8'), 'once')
  assert.equal((await fixture.api('DELETE', '/api/nodes/shell-client')).status, 200)
  for (const endpoint of ['register', 'poll', 'report']) assert.equal((await fetch(fixture.origin + prefix + '/node/shell/' + endpoint, { method: endpoint === 'poll' ? 'GET' : 'POST', headers: directHeaders(credential), ...(endpoint === 'poll' ? {} : { body: startup }) })).status, 401)
  assert.equal((await fetch(fixture.origin + prefix + '/node/shell/register', { method: 'POST', headers: { ...directHeaders(credential), Authorization: 'Bearer ' + fixture.token }, body: startup })).status, 401)
  assert(!fixture.output.includes(token)); assert(clients.every(client => !client.output.includes(token) && !client.output.includes(expiryToken)))
  assert(requests.some(request => Object.keys(request.tools.find(tool => tool.name === 'exec')?.parameters.properties || {}).filter(key => !key.startsWith('__')).join(',') === 'command,cwd,timeout'))
  console.log(JSON.stringify({ result: 'passed', busybox, deliveredTasks: tasks.length, reportRequests: reports.length, largestSampleFile: largest, longBoundaryMilliseconds: Date.now() - longStart, ownedHostStarts: fixture.hostPids.length, nativeMonty: true, schemaCheckedModelRequests: requests.length }))
  await fixture.stop()
} finally {
  for (const ws of sockets) ws.terminate()
  // Fixture-owned commands have settled; collect remaining poll wrappers and their children.
  for (const handle of clients) { try { process.kill(-handle.child.pid, 'SIGKILL') } catch {} }
  proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); await new Promise(done => model.close(done)); await fixture.cleanup()
}
