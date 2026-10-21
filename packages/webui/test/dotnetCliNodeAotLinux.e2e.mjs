// Focused Linux NativeAOT exec/file/lifetime qualification; no managed or Source substitution.
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readlink, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const executable = process.env.FOXWARM_CLI_EXECUTABLE
assert(executable, 'Set FOXWARM_CLI_EXECUTABLE to the native executable')
assert(process.env.FOXWARM_TEST_TLS_CERT && process.env.FOXWARM_TEST_TLS_KEY, 'Supply an owned trusted localhost TLS certificate and key')
const clients = [], sockets = new Set(), frames = []
const http = createServer({ cert: await readFile(process.env.FOXWARM_TEST_TLS_CERT), key: await readFile(process.env.FOXWARM_TEST_TLS_KEY) }), peer = new WebSocketServer({ server: http })
let current, generation = 0, sequence = 0, acknowledge = false
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `https://127.0.0.1:${http.address().port}`
const cwd = join(root, 'cli'), agent = join(cwd, 'agents/main'), project = join(cwd, 'project')
const registry = join(agent, '.temp/exec/running-exec.json')
await mkdir(join(project, 'next'), { recursive: true })
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 25)) }
  throw new Error('Timed out: ' + label + '\nPeer TLS events: ' + JSON.stringify(evidence.peerTls) + '\n' + clients.map(client => client.output).join('\n'))
}
const evidence = {}
const staticExpected = process.env.FOXWARM_TEST_EXPECT_STATIC === '1'
function observeTls(server, label) {
  const events = []
  evidence.peerTls ??= {}
  evidence.peerTls[label] = events
  server.on('secureConnection', socket => {
    events.push({ event: 'secureConnection', port: socket.remotePort })
    socket.once('close', hadError => events.push({ event: 'tlsClose', port: socket.remotePort, hadError }))
  })
  server.on('tlsClientError', error => events.push({ event: 'tlsClientError', code: error.code }))
  server.on('upgrade', () => events.push({ event: 'upgrade' }))
  return events
}
const tlsEvents = observeTls(http, 'trusted-and-untrusted')
const rejectionSettled = events => events.some(row => row.event === 'tlsClientError' || row.event === 'tlsClose')
const exists = path => readFile(path).then(() => true, () => false)
peer.on('connection', socket => {
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  socket.on('message', bytes => {
    const value = JSON.parse(bytes); frames.push({ socket, value })
    if (value.type === 'node_register') {
      current = socket; generation++
      socket.send(JSON.stringify({ type: 'registered', nodeId: 'native-smoke', nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    }
    if (value.type === 'session_event') {
      if (value.execId && acknowledge) socket.send(JSON.stringify({ type: 'session_event_accepted', requestId: value.requestId }))
      if (!value.execId) socket.send(JSON.stringify({ type: 'cli_response', requestId: value.requestId, ok: true, result: { queued: true } }))
    }
  })
})
function startClient(target, overrides = {}, trigger = true) {
  const env = { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents'), SHELL: '/bin/bash', FOXWARM_NODE_PTY_SHELL: 'bash', EXECTEST_INHERITED: 'native-inherited', fw_agentdir: 'wrong-parent', fw_tmp: 'wrong-parent', NO_PROXY: '127.0.0.1,127.0.0.2,localhost', no_proxy: '127.0.0.1,127.0.0.2,localhost' }
  Object.assign(env, overrides)
  delete env.DOTNET_ROOT; delete env.DOTNET_HOST_PATH
  const child = spawn(executable, ['--host', target, '--id', 'native-smoke', '--auth-token', 'synthetic-native', '--credentials-file', join(cwd, 'credentials.json'), ...(trigger ? ['--local-trigger-port', '0'] : ['--no-local-trigger'])], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const client = { child, output: '' }; clients.push(client)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { client.output += bytes })
  return client
}
async function launch() {
  const before = generation
  const client = startClient(origin)
  await until(() => generation > before, 'native registration')
  client.socket = current
  assert.equal(await readlink(`/proc/${client.child.pid}/exe`), executable)
  await inspectMaps(client, 'registration-' + generation)
  return client
}
async function inspectMaps(client, label) {
  const maps = await readFile(`/proc/${client.child.pid}/maps`, 'utf8')
  assert(!maps.includes('libcoreclr'), 'must be actual NativeAOT, not CLR')
  evidence.loadedLibraries = [...new Set(maps.split('\n').map(line => line.match(/\/[^ ]+$/)?.[0]).filter(Boolean))]
  evidence.librarySnapshots ??= {}
  evidence.librarySnapshots[label] = evidence.loadedLibraries
  if (staticExpected) {
    assert(!evidence.loadedLibraries.some(path => /\.so(?:[.\/-]|$)|ld-musl/.test(path)), 'static CLI must not load shared libraries: ' + JSON.stringify(evidence.loadedLibraries))
  } else {
    assert(evidence.loadedLibraries.some(path => /libssl\.so/.test(path)), 'actual TLS must load OpenSSL')
    assert(evidence.loadedLibraries.some(path => /libicu/.test(path)), 'non-invariant globalization must load ICU')
  }
}
async function stop(client) {
  if (client.child.exitCode !== null || client.child.signalCode !== null) return
  const exited = once(client.child, 'exit'); client.child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { client.child.kill('SIGKILL'); reject(new Error('Native shutdown did not drain')) }, 6000) })]) }
  finally { clearTimeout(timer) }
}
async function rejectedTlsControls() {
  const emptyTrust = join(root, 'empty-trust'), emptyDirectory = join(root, 'empty-certs')
  await writeFile(emptyTrust, ''); await mkdir(emptyDirectory)
  const beforeEvents = tlsEvents.length, beforeGeneration = generation
  const untrusted = startClient(origin, { SSL_CERT_FILE: emptyTrust, SSL_CERT_DIR: emptyDirectory }, false)
  await until(() => untrusted.output.includes('connection_error'), 'untrusted client failure')
  await until(() => rejectionSettled(tlsEvents.slice(beforeEvents)), 'untrusted peer TLS close/error')
  assert(!tlsEvents.slice(beforeEvents).some(row => row.event === 'upgrade'), 'untrusted certificate must fail before WebSocket upgrade')
  assert.equal(generation, beforeGeneration, 'untrusted peer must not register')
  await stop(untrusted)
  const wrongHost = createServer({ cert: await readFile(process.env.FOXWARM_TEST_TLS_CERT), key: await readFile(process.env.FOXWARM_TEST_TLS_KEY) })
  const wrongHostEvents = observeTls(wrongHost, 'mismatched-host')
  wrongHost.on('upgrade', (_, socket) => socket.destroy())
  wrongHost.listen(0, '127.0.0.2'); await once(wrongHost, 'listening')
  try {
    const mismatch = startClient(`https://127.0.0.2:${wrongHost.address().port}`, {}, false)
    await until(() => mismatch.output.includes('connection_error'), 'hostname mismatch client failure')
    await until(() => rejectionSettled(wrongHostEvents), 'hostname mismatch peer TLS close/error')
    assert(!wrongHostEvents.some(row => row.event === 'upgrade'), 'hostname mismatch must fail before WebSocket upgrade')
    await stop(mismatch)
  } finally { await new Promise(done => wrongHost.close(done)) }
  evidence.rejectedTls = { untrusted: tlsEvents.slice(beforeEvents), hostnameMismatch: wrongHostEvents, trustedRegistrationBeforeControls: beforeGeneration > 0, noAuthenticatedRegistration: generation === beforeGeneration }
}
async function tool(client, name, args, extra = {}) {
  const callId = 'smoke-' + ++sequence
  client.socket.send(JSON.stringify({ type: 'tool_call', callId, tool: name, sessionId: 'main/owned', agentName: 'main', args, ...extra }))
  const reply = await until(() => frames.find(row => row.socket === client.socket && row.value.callId === callId && ['tool_call_response', 'tool_call_error'].includes(row.value.type))?.value, name + ' reply')
  assert.equal(reply.type, 'tool_call_response', JSON.stringify(reply)); return reply.result
}
async function service(client, service, operation, args = {}) {
  const requestId = 'service-' + ++sequence
  client.socket.send(JSON.stringify({ type: 'node_service_request', requestId, service, operation, args }))
  const reply = await until(() => frames.find(row => row.socket === client.socket && row.value.requestId === requestId)?.value, service + ':' + operation)
  assert.equal(reply.type, 'node_service_response', JSON.stringify(reply)); return reply.result
}
async function optionalServices(client) {
  const registration = frames.find(row => row.socket === client.socket && row.value.type === 'node_register').value
  const ptyExpected = process.env.FOXWARM_TEST_EXPECT_PTY !== '0'
  assert.equal(registration.capabilities.services['vscode-pty'], ptyExpected ? 1 : undefined)
  evidence.ptyBackend = ptyExpected ? 'loaded' : 'absent: other services remain usable'
  if (process.env.FOXWARM_TEST_EXPECT_GIT !== '0') {
    execFileSync('git', ['init', project])
    await writeFile(join(project, 'untracked 雪'), 'native git')
    const status = await service(client, 'vscode-git', 'status', { workspace: project })
    assert(status.changes.some(row => row.path === 'untracked 雪'))
    evidence.git = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
  } else {
    evidence.git = 'not provisioned in dependency-absence run; separate real Git proof required'
  }
  if (ptyExpected) {
    const terminal = (await service(client, 'vscode-pty', 'create', { cwd: project, cols: 91, rows: 37 })).terminal
    await service(client, 'vscode-pty', 'attach', { terminalId: terminal.id })
    client.socket.send(JSON.stringify({ type: 'node_service_command', service: 'vscode-pty', operation: 'input', args: { terminalId: terminal.id, data: "stty size; printf 'NATIVE-PTY-é🙂\\n'; code --add .; printf 'CODE-RESULT=%s\\n' \"$?\"\n" } }))
    const request = await until(() => frames.find(row => row.socket === client.socket && row.value.type === 'node_service_event' && row.value.event.type === 'code-request')?.value.event, 'same-executable Code helper')
    assert.equal(request.request.kind, 'addFolder')
    client.socket.send(JSON.stringify({ type: 'node_service_command', service: 'vscode-pty', operation: 'code-result', args: { requestId: request.requestId, ok: true } }))
    const output = () => frames.filter(row => row.socket === client.socket && row.value.type === 'node_service_event' && row.value.event.type === 'output').map(row => row.value.event.data).join('')
    await until(() => output().includes('CODE-RESULT=0\r\n'), 'PTY helper completion')
    assert(output().includes('37 91')); assert(output().includes('NATIVE-PTY-é🙂'))
    await service(client, 'vscode-pty', 'close', { terminalId: terminal.id })
    evidence.ptyShellDimensionsUnicodeAndCodeHelper = true
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    const tab = await tool(client, 'browse_open', { url: 'data:text/html,<title>Native browser</title><button>Click</button><button>Item</button><button>Item</button>' })
    assert.equal(tab.title, 'Native browser')
    const interact = (action, params) => tool(client, 'browse_interact', { tabId: tab.tabId, action, params })
    await interact('wait', { selector: 'aria/Click' })
    await interact('wait', { selector: '::-p-aria(Item):nth-of-type(2)' })
    const evaluated = await interact('evaluate', { code: '({unicode:"é🙂",number:1e-7})' })
    assert.equal(evaluated.output, 'Evaluated: {"unicode":"é🙂","number":1e-7}')
    await tool(client, 'browse_close', { tabId: tab.tabId })
    evidence.browser = { executable: process.env.PUPPETEER_EXECUTABLE_PATH, version: execFileSync(process.env.PUPPETEER_EXECUTABLE_PATH, ['--version'], { encoding: 'utf8' }).trim(), selectorsAndEvaluate: true }
  } else {
    evidence.browser = 'not provisioned; missing-browser failure must not affect core tools'
    const callId = 'browser-missing-' + ++sequence
    client.socket.send(JSON.stringify({ type: 'tool_call', callId, tool: 'browse_open', sessionId: 'main/owned', agentName: 'main', args: { url: 'about:blank' } }))
    const reply = await until(() => frames.find(row => row.value.callId === callId)?.value, 'missing browser diagnostic')
    assert.equal(reply.type, 'tool_call_error')
    evidence.missingBrowserError = reply.error
  }
}
try {
  const magic = await readFile(executable); assert.equal(magic.subarray(0, 4).toString('hex'), '7f454c46')
  let client = await launch()
  await rejectedTlsControls()
  const firstPid = client.child.pid
  await optionalServices(client)
  const metadata = await until(async () => { try { return JSON.parse(await readFile(join(cwd, 'node_local_trigger.json'), 'utf8')) } catch {} }, 'local trigger metadata')
  const helper = spawn('/bin/sh', [metadata.scriptFile, 'main/owned', 'native TLS trigger é🙂'], { env: { ...process.env, PATH: '/no-node-python-dotnet' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let helperOutput = '', helperError = ''
  helper.stdout.on('data', bytes => { helperOutput += bytes }); helper.stderr.on('data', bytes => { helperError += bytes })
  assert.equal((await once(helper, 'exit'))[0], 0, helperError)
  assert.deepEqual(JSON.parse(helperOutput), { success: true })
  assert(frames.some(row => row.value.message === 'native TLS trigger é🙂'))
  evidence.localTriggerAndSameExecutableHelper = true
  const cultureDirectory = join(agent, 'culture-order')
  await mkdir(cultureDirectory, { recursive: true })
  for (const name of ['z', 'ä', 'a']) await writeFile(join(cultureDirectory, name), name)
  const cultureRead = await tool(client, 'read', { filePath: cultureDirectory })
  for (const name of ['a', 'ä', 'z']) assert(cultureRead.output.includes('`' + name + '`'))
  assert(cultureRead.output.indexOf('`a`') < cultureRead.output.indexOf('`ä`'))
  assert(cultureRead.output.indexOf('`ä`') < cultureRead.output.indexOf('`z`'), 'real en-US directory collation, not ordinal Unicode order')
  evidence.globalization = { caller: 'file read directory en-US comparer', order: ['a', 'ä', 'z'] }
  const written = await tool(client, 'write', { filePath: 'ordinary.txt', content: 'native file\né🙂', createDirs: true })
  assert(!written.error, JSON.stringify(written))
  const read = await tool(client, 'read', { filePath: 'ordinary.txt' }, { programmatic: true })
  assert.equal(read.content, 'native file\né🙂')
  const foreground = await tool(client, 'exec', { command: 'printf "%s|%s|%s\\n" "$EXECTEST_INHERITED" "$fw_agentdir" "$fw_tmp"; printf "  é🙂\\n"; printf x >> foreground-effect; cd next; exit 7', timeout: 2 }, { sessionCwd: project, programmatic: true, backgroundExecId: 'native-foreground', completionCapability: 'synthetic-foreground-grant' })
  assert.equal(foreground.status, 'completed'); assert.equal(foreground.exitCode, 7)
  assert.equal(foreground.content, `native-inherited|${agent}|${agent}/tmp\n  é🙂\n`)
  assert.equal(await readFile(join(project, 'foreground-effect'), 'utf8'), 'x')
  assert.equal((await readFile(foreground.logPath + '.cwd.txt', 'utf8')).trim(), join(project, 'next'))
  assert.equal(JSON.parse(await readFile(foreground.logPath + '.exit.json', 'utf8')).exitCode, 7)
  const background = await tool(client, 'exec', { command: 'printf x >> background-effect; printf "started native\\n"; while [ ! -f release ]; do sleep .05; done; printf "finished native\\n"', timeout: 1 }, { sessionCwd: project, programmatic: true, backgroundExecId: 'native-background', completionCapability: 'synthetic-original-grant' })
  assert.equal(background.status, 'running'); assert.equal(background.execId, 'native-background')
  const original = JSON.parse(await readFile(registry, 'utf8')).execs.find(entry => entry.id === 'native-background'); assert(original)
  assert.equal(original.completionCapability, 'synthetic-original-grant')
  const date = join(agent, '.temp/exec', (await readdir(join(agent, '.temp/exec'))).find(name => /^\d{4}-\d\d-\d\d$/.test(name)))
  const script = await readFile(join(date, 'native-background.command.sh'), 'utf8')
  assert(script.includes(`'${executable}' --exec-paths`)); assert(script.includes(`'${executable}' --exec-status`))
  assert(!script.includes('dotnet ') && !script.includes('node '))
  const logRead = await tool(client, 'read', { filePath: original.logPath })
  assert(logRead.output.startsWith('started native\n'))
  await inspectMaps(client, 'after-services-and-exec')
  await stop(client)
  assert(await exists(original.logPath), 'native process lifetime retains original artifacts')
  await writeFile(join(project, 'release'), 'finish')
  await until(() => exists(original.statusPath), 'native status helper finishes after CLI shutdown')
  assert.equal(JSON.parse(await readFile(original.statusPath, 'utf8')).exitCode, 0)
  assert.equal((await readFile(original.cwdPath, 'utf8')).trim(), project)
  assert.equal(await readFile(join(project, 'background-effect'), 'utf8'), 'x')
  acknowledge = true
  client = await launch()
  await until(async () => JSON.parse(await readFile(registry, 'utf8')).execs.length === 0, 'recovery acknowledged')
  const event = frames.find(row => row.socket === client.socket && row.value.type === 'session_event' && row.value.execId === original.id)?.value
  assert(event); assert.equal(event.sessionId, original.sessionId); assert.equal(event.completionCapability, original.completionCapability)
  assert.equal(await readFile(original.logPath, 'utf8'), 'started native\nfinished native\n')
  assert.equal(await readFile(join(project, 'background-effect'), 'utf8'), 'x')
  console.log(JSON.stringify({ ...evidence, actualExecutable: executable, elf: true, trustedTlsRegistration: true, distro: await readFile('/etc/os-release', 'utf8'), kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(), linkage: staticExpected ? 'static-musl: ELF and library-open trace checked separately' : execFileSync('ldd', ['--version'], { encoding: 'utf8' }).split('\n')[0], noCoreClrLoaded: true, firstPid, secondPid: client.child.pid, foreground: { status: foreground.status, exitCode: foreground.exitCode, content: foreground.content }, ordinaryFileRead: read.content, backgroundOriginal: original, backgroundCompletion: event, wrapperNativePathsAndStatusHelpers: true, helperAfterParentExit: true, effectsExactlyOnce: true, ackRemovedRecoveredTracking: true }, null, 2))
  await stop(client)
} finally {
  await writeFile(join(project, 'release'), 'finish')
  for (const client of clients) await stop(client)
  for (const socket of sockets) socket.terminate()
  await new Promise(done => peer.close(done)); await new Promise(done => http.close(done))
  await rm(root, { recursive: true, force: true })
}
