// Actual Source receiver and managed/native CLI, owned native PTYs and capability IPC.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access, cp } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const sizesOnly = process.argv.includes('--sizes-only')
const http = createServer(), peer = new WebSocketServer({ server: http }), frames = [], clients = [], sockets = new Set(), connected = new Map(), generations = new Map()
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `http://127.0.0.1:${http.address().port}`
let serial = 0
peer.on('connection', (socket, request) => {
  const id = new URL(request.url, origin).searchParams.get('id')
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  socket.on('message', bytes => {
    const value = JSON.parse(bytes); frames.push({ socket, id, value })
    if (value.type === 'node_register') {
      connected.set(id, socket); generations.set(id, (generations.get(id) || 0) + 1)
      socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    }
  })
})
async function launch(name, source = false, override) {
  const cwd = join(root, name), home = join(cwd, 'home'); await mkdir(home, { recursive: true })
  const executable = override || (!source && process.env.FOXWARM_CLI_EXECUTABLE)
  const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', origin + '/pty', '--id', name, '--auth-token', 'synthetic-pty-token', '--no-local-trigger', '--credentials-file', join(cwd, 'credentials.json')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolatedApplicationEnv(join(cwd, 'data')), HOME: home, SHELL: '/bin/bash', FOXWARM_NODE_PTY_SHELL: 'bash', FOXWARM_AGENTS_DIR: join(cwd, 'agents') } })
  const handle = { child, cwd, id: name, output: '', source, terminals: new Set() }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-20000) })
  await until(() => connected.get(name), 'CLI register ' + name); handle.socket = connected.get(name); return handle
}
async function stop(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { handle.child.kill('SIGKILL'); reject(new Error(handle.output)) }, 8000) })]) }
  finally { clearTimeout(timer) }
}
async function request(handle, operation, args = {}) {
  const requestId = 'pty-' + ++serial, socket = handle.socket
  socket.send(JSON.stringify({ type: 'node_service_request', requestId, service: 'vscode-pty', operation, args }))
  return until(() => frames.find(row => row.socket === socket && row.value.requestId === requestId)?.value, operation + ':' + JSON.stringify(args), 25000)
}
const good = reply => { assert.equal(reply.type, 'node_service_response', JSON.stringify(reply)); return reply.result }
const command = (h, operation, args = {}) => h.socket.send(JSON.stringify({ type: 'node_service_command', service: 'vscode-pty', operation, args }))
const events = (h, id) => frames.filter(row => row.id === h.id && row.value.type === 'node_service_event' && row.value.event.terminalId === id).map(row => row.value.event)
const output = (h, id) => events(h, id).filter(row => row.type === 'output').map(row => row.data).join('')
const input = (h, id, data) => command(h, 'input', { terminalId: id, data })
const exists = path => access(path).then(() => true, () => false)
async function create(h, args = {}) { const term = good(await request(h, 'create', { cwd: h.cwd, ...args })).terminal; h.terminals.add(term.id); return term }
// Each value starts from an independent baseline, then reaches the real native
// create/resize/get path. Number is the Source receiver's normalization boundary.
async function sizeCorpus(h) {
  const cases = [91, 91.9, '91.9', ' 91 ', '+91', -1, null, true, [], [92], [[93]], 'bad', {}, 65627]
  const integers = [
    21n, (1n << 53n) - 1n, (1n << 53n) + 1n, (1n << 53n) + 3n,
    (1n << 64n) - 1n, 1n << 64n, (1n << 64n) + 2049n,
    (1n << 100n) + (1n << 47n) + 1n,
    // Largest finite double and both sides of the round-to-infinity midpoint.
    (1n << 1024n) - (1n << 971n),
    (1n << 1024n) - (1n << 970n) - 1n,
    (1n << 1024n) - (1n << 970n), 1n << 1024n,
  ]
  for (const [prefix, radix, invalidDigit] of [['0x', 16, 'g'], ['0b', 2, '2'], ['0o', 8, '8']]) {
    for (const value of integers) cases.push(prefix + value.toString(radix))
    cases.push(prefix, prefix + '+21', prefix + '-21', '+' + prefix + '21', '-' + prefix + '21', prefix + '21' + invalidDigit, prefix + ' 21', prefix + '21 ', prefix.toUpperCase() + (radix + 5).toString(radix))
  }
  // Original accepted-sign failures, plus ordinary decimal rounding/overflow.
  cases.push('0b+10101', '0o+25', '9007199254740995', '1e308', '1e309')
  const failures = []
  const normalize = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(20, Math.floor(Number(value))) : fallback
  const t = await create(h, { cols: 91, rows: 37 })
  try {
    for (const cols of cases) {
      good(await request(h, 'resize', { terminalId: t.id, cols: 91, rows: 37 }))
      assert.equal(good(await request(h, 'get', { terminalId: t.id })).terminal.cols, 91)
      good(await request(h, 'resize', { terminalId: t.id, cols, rows: 37 }))
      const actual = good(await request(h, 'get', { terminalId: t.id })).terminal.cols
      const expected = normalize(cols, 91)
      if (actual !== expected) failures.push({ operation: 'resize', input: cols, actual, expected })
      const created = await create(h, { cols, rows: 37 })
      const retrieved = good(await request(h, 'get', { terminalId: created.id })).terminal
      if (created.cols !== normalize(cols, 100) || retrieved.cols !== created.cols)
        failures.push({ operation: 'create/get', input: cols, actual: created.cols, expected: normalize(cols, 100) })
      good(await request(h, 'close', { terminalId: created.id })); h.terminals.delete(created.id)
    }
    // Record normalization must not replace the existing unsigned-short kernel conversion.
    good(await request(h, 'attach', { terminalId: t.id }))
    good(await request(h, 'resize', { terminalId: t.id, cols: '0x1005b', rows: 37 }))
    assert.equal(good(await request(h, 'get', { terminalId: t.id })).terminal.cols, 65627)
    input(h, t.id, "stty size; printf 'RADIX-KERNEL-DONE\\n'\n")
    await until(() => output(h, t.id).includes('37 91') && output(h, t.id).includes('RADIX-KERNEL-DONE\r\n'), 'radix kernel dimensions')
  } finally {
    good(await request(h, 'close', { terminalId: t.id })); h.terminals.delete(t.id)
  }
  console.log(JSON.stringify({ sizeCorpus: h.id, cases: cases.length, createResizeGet: true, freshBaseline: 91, kernelRecord: 65627, kernelCols: 91, failures }))
  assert.deepEqual(failures, [])
}
async function corpus(h) {
  const registration = frames.find(row => row.id === h.id && row.value.type === 'node_register').value
  assert.equal(registration.capabilities.services['vscode-pty'], 1)
  const errors = []
  for (const [operation, args] of [['unknown', {}], ['create', {}], ['create', { cwd: 12 }], ['create', { cwd: ' ' }], ['create', { cwd: join(h.cwd, 'missing') }], ['get', {}], ['attach', { terminalId: 'missing' }], ['input', { terminalId: 'missing', data: 'x' }]]) {
    const reply = await request(h, operation, args); assert.equal(reply.type, 'node_service_error'); assert.equal(reply.error.code, 'Unknown'); errors.push(reply.error.message.replaceAll(h.cwd, '<root>'))
  }
  const file = join(h.cwd, ' spaces 雪.txt'); await writeFile(file, 'first\nsecond\nthird\n')
  assert.equal((await request(h, 'create', { cwd: file })).type, 'node_service_error')
  assert.deepEqual(good(await request(h, 'get', { terminalId: 'absent' })), { terminal: null })
  good(await request(h, 'close', { terminalId: 'absent' }))
  const t = await create(h, { cols: 1, rows: 2 }); assert.match(t.id, /^term_\d+_[a-f0-9]{8}$/); assert.equal(t.nodeId, ''); assert.equal(t.cols, 20); assert.equal(t.rows, 5); assert.equal(t.shell, 'bash'); assert(t.pid > 0 && t.createdAt > 0)
  const id = t.id
  let attached = good(await request(h, 'attach', { terminalId: id })); assert.equal(attached.terminal.pid, t.pid)
  input(h, id, "printf 'INITIAL-PID=%s\\n' \"$$\"; stty size\n")
  await until(() => output(h, id).includes('INITIAL-PID=' + t.pid) && output(h, id).includes('5 20'), 'minimum dimensions and real process')
  // Back-to-back wire commands must execute in their received order, not Task.Run order.
  command(h, 'resize', { terminalId: id, cols: '91.9', rows: '37.9' }); input(h, id, 'stty size\n')
  await until(() => output(h, id).includes('37 91'), 'resize ordering')
  for (const [cols, rows, expected] of [[null, false, [20, 5]], [[], [12], [20, 12]], ['0b10101', '0o14', [21, 12]], [[[22]], 12, [22, 12]], ['bad', {}, [22, 12]], [65536, 100000, [65536, 100000]], [1e20, 30, [1e20, 30]]]) {
    good(await request(h, 'resize', { terminalId: id, cols, rows })); const record = good(await request(h, 'get', { terminalId: id })).terminal; assert.deepEqual([record.cols, record.rows], expected)
  }
  good(await request(h, 'resize', { terminalId: id, cols: 100, rows: 30 }))
  input(h, id, "printf '%s|%s\\n' \"$TERM\" \"$COLORTERM\"; cd home; pwd; printf 'CWD-SET\\n'\n")
  await until(() => output(h, id).includes('CWD-SET\r\n'), 'normal shell cwd')
  await until(async () => good(await request(h, 'get', { terminalId: id })).terminal.cwd === join(h.cwd, 'home'), 'tracked current cwd')
  assert(output(h, id).includes('xterm-256color|truecolor'))
  async function helper(args, marker, response = { ok: true, message: 'Real Code receiver' }) {
    const before = events(h, id).length
    input(h, id, `code ${args}; printf '${marker}=%s\\n' "$?"\n`)
    const control = await until(() => events(h, id).slice(before).find(row => row.type === 'code-request'), 'real helper ' + args)
    assert.equal(control.request.nodeId, undefined)
    command(h, 'code-result', { requestId: control.requestId, ...response })
    await until(() => output(h, id).includes(marker + '=' + (response.ok ? '0' : '1')), 'helper result ' + marker)
    return control
  }
  const opened = await helper("--goto '../ spaces 雪.txt:3:2'", 'OPENED'); assert.deepEqual(opened.request, { kind: 'openFile', path: file, startLine: 3, startColumn: 2 })
  assert.equal((await helper('--add .', 'ADDED')).request.kind, 'addFolder')
  await helper("'../ spaces 雪.txt'", 'REJECTED', { ok: false, error: 'No Code terminal is attached to handle this request.' })
  input(h, id, "code --add . --add .; printf 'DUPLICATE=%s\\n' \"$?\"; code --goto '../ spaces 雪.txt:0'; printf 'BAD-LINE=%s\\n' \"$?\"; code --version; code --help\n")
  await until(() => output(h, id).includes('DUPLICATE=1') && output(h, id).includes('BAD-LINE=1'), 'helper argument validation')
  const beforeTimeout = events(h, id).length
  input(h, id, "code '../ spaces 雪.txt'; printf 'TIMEOUT=%s\\n' \"$?\"\n")
  const timed = await until(() => events(h, id).slice(beforeTimeout).find(row => row.type === 'code-request'), 'pending helper timeout')
  await until(() => output(h, id).includes('TIMEOUT=1'), 'real twenty-second helper timeout', 24000)
  command(h, 'code-result', { requestId: timed.requestId, ok: true })
  // Detached output is retained once, then ready/backlog precedes every live frame.
  good(await request(h, 'detach', { terminalId: id })); const beforeDetached = events(h, id).length
  input(h, id, "printf 'DETACHED-ONLY\\n'; printf '%0205000d' 0; printf '\\nBACKLOG-END\\n'\n")
  await sleep(300)
  assert.equal(events(h, id).length, beforeDetached, 'detached output must not stream')
  assert(good(await request(h, 'attach', { terminalId: id })).backlog.includes('BACKLOG-END\r\n'))
  good(await request(h, 'detach', { terminalId: id })); await sleep(100)
  attached = good(await request(h, 'attach', { terminalId: id })); assert.equal(attached.backlog.length, 200000); assert(attached.backlog.includes('BACKLOG-END\r\n'))
  const attachFrame = frames.findLastIndex(row => row.id === h.id && row.value.type === 'node_service_response' && row.value.result?.backlog === attached.backlog)
  input(h, id, "printf 'LIVE-AFTER-READY\\n'\n"); await until(() => output(h, id).includes('LIVE-AFTER-READY\r\n'), 'live after ready')
  assert(frames.findIndex((row, index) => index > attachFrame && row.id === h.id && row.value.event?.data?.includes('LIVE-AFTER-READY\r\n')) > attachFrame)
  // Genuine socket replacement leaves the same PTY. Old helper results are never replayed.
  const beforeDisconnect = events(h, id).length
  input(h, id, "code '../ spaces 雪.txt'; printf 'DISCONNECT=%s\\n' \"$?\"\n")
  const outstanding = await until(() => events(h, id).slice(beforeDisconnect).find(row => row.type === 'code-request'), 'helper before disconnect')
  const generation = generations.get(h.id); h.socket.close()
  await until(() => generations.get(h.id) > generation, 'CLI reconnect', 12000); h.socket = connected.get(h.id)
  assert.equal(good(await request(h, 'get', { terminalId: id })).terminal.pid, t.pid)
  command(h, 'code-result', { requestId: outstanding.requestId, ok: true })
  // Source may finish its original pending request on the newly authenticated socket; new CLI settles disconnect immediately.
  const back = good(await request(h, 'attach', { terminalId: id })); assert.equal(back.terminal.pid, t.pid)
  input(h, id, "printf 'RECONNECTED-PID=%s\\n' \"$$\"\n"); await until(() => output(h, id).includes('RECONNECTED-PID=' + t.pid), 'same shell after reconnect')
  const natural = await create(h, { cols: 'bad', rows: 'bad' }); assert.equal(natural.cols, 100); assert.equal(natural.rows, 30)
  good(await request(h, 'attach', { terminalId: natural.id })); input(h, natural.id, 'exit 7\n')
  await until(() => events(h, natural.id).find(row => row.type === 'exit' && row.exitCode === 7), 'real natural exit'); assert.equal(good(await request(h, 'get', { terminalId: natural.id })).terminal, null)
  h.terminals.delete(natural.id)
  assert(good(await request(h, 'list')).terminals.some(row => row.id === id && row.pid === t.pid))
  good(await request(h, 'close', { terminalId: id })); await until(() => { try { process.kill(t.pid, 0); return false } catch { return true } }, 'explicit close killed actual PTY')
  h.terminals.delete(id); assert.equal(good(await request(h, 'get', { terminalId: id })).terminal, null)
  assert(!await exists(join(h.cwd, 'agents')), 'services must not manufacture Agent directories')
  // Natural exit and a user close may overlap on the real receiver/native waiter.
  for (let attempt = 0; attempt < 10; attempt++) {
    const racing = await create(h)
    input(h, racing.id, 'exit 0\n')
    good(await request(h, 'close', { terminalId: racing.id }))
    good(await request(h, 'close', { terminalId: racing.id }))
    assert.equal(good(await request(h, 'get', { terminalId: racing.id })).terminal, null)
    h.terminals.delete(racing.id)
  }
  const blocked = await create(h)
  good(await request(h, 'attach', { terminalId: blocked.id }))
  input(h, blocked.id, "stty raw -echo; printf 'BLOCKED-%s\\n' READY; sleep 30\n")
  await until(() => output(h, blocked.id).includes('BLOCKED-READY\n'), 'shell stopped reading its PTY')
  good(await request(h, 'input', { terminalId: blocked.id, data: 'x'.repeat(131072) }))
  good(await request(h, 'resize', { terminalId: blocked.id, cols: 92, rows: 38 }))
  good(await request(h, 'close', { terminalId: blocked.id }))
  h.terminals.delete(blocked.id)
  await until(() => { try { process.kill(blocked.pid, 0); return false } catch { return true } }, 'close interrupts blocked terminal input')
  const remaining = await create(h)
  // Independent exec has its own detached lifetime; terminal close/shutdown must not adopt it.
  const callId = 'independent-' + ++serial
  h.socket.send(JSON.stringify({ type: 'tool_call', callId, tool: 'exec', sessionId: 'fixture/owner', agentName: 'owner', nodeId: h.id, backgroundExecId: 'quiet-owned', completionCapability: 'synthetic-persistent-grant', args: { command: `sleep 3; printf 'independent-finished' > '${join(h.cwd, 'independent.txt')}'`, cwd: h.cwd, timeout: 1 } }))
  await until(() => frames.find(row => row.id === h.id && row.value.callId === callId), 'independent exec background')
  if (!h.source) {
    await stop(h); await until(() => { try { process.kill(remaining.pid, 0); return false } catch { return true } }, 'CLI shutdown closed owned PTY')
    h.terminals.delete(remaining.id)
  } else { good(await request(h, 'close', { terminalId: remaining.id })); h.terminals.delete(remaining.id); await stop(h) }
  await until(() => exists(join(h.cwd, 'independent.txt')), 'independent exec survived terminal shutdown')
  assert.equal(await readFile(join(h.cwd, 'independent.txt'), 'utf8'), 'independent-finished')
  console.log(JSON.stringify({ passed: h.id, errors: errors.length + 1, nativePty: true, helperIpc: true, boundedBacklog: 200000, actualTimeout: true, reconnectSamePid: true, independentExecSurvives: true, cliShutdownKillsPty: !h.source, beforeDetached }))
}
try {
  const source = await launch('source', true); await sizeCorpus(source)
  if (!sizesOnly) await corpus(source)
  else await stop(source)
  const candidate = await launch('candidate'); await sizeCorpus(candidate)
  if (!sizesOnly) await corpus(candidate)
  else await stop(candidate)
  if (!sizesOnly) {
    // Missing optional PTY cannot remove the other advertised services or file tools.
    const original = process.env.FOXWARM_CLI_EXECUTABLE || resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode')
    const optional = join(root, 'without-pty'); await mkdir(optional)
    const files = process.env.FOXWARM_CLI_EXECUTABLE ? [original] : [original, original + '.dll', join(dirname(original), 'Foxwarm.NodePrimitives.dll'), original + '.deps.json', original + '.runtimeconfig.json']
    for (const file of files) await cp(file, join(optional, basename(file)))
    const absent = await launch('absent', false, join(optional, basename(original)))
    const registration = frames.find(row => row.id === absent.id && row.value.type === 'node_register').value
    assert.equal(registration.capabilities.services['vscode-pty'], undefined); assert.equal(registration.capabilities.services['vscode-fs'], 1); assert.equal(registration.capabilities.services['vscode-git'], 2)
    assert.equal((await request(absent, 'create', { cwd: absent.cwd })).type, 'node_service_error')
    async function other(frame, key) { absent.socket.send(JSON.stringify(frame)); return until(() => frames.find(row => row.id === absent.id && row.value[key] === frame[key])?.value, 'retained service ' + frame.type) }
    const file = join(absent.cwd, 'still-working.txt')
    good(await other({ type: 'node_service_request', requestId: 'retained-fs', service: 'vscode-fs', operation: 'write-file', args: { path: file, create: true, contentBase64: 'c3RpbGwtd29ya2luZw==' } }, 'requestId'))
    const read = await other({ type: 'tool_call', callId: 'retained-file-tool', tool: 'read', sessionId: 'owned/main', agentName: 'main', args: { filePath: file } }, 'callId'); assert.equal(read.type, 'tool_call_response'); assert(JSON.stringify(read.result).includes('still-working'))
    const transfer = await other({ type: 'file_read_request', transferId: 'retained-transfer', filePath: file, agentName: 'main' }, 'transferId'); assert.equal(transfer.type, 'file_read_response')
    await stop(absent)
    console.log(JSON.stringify({ passed: 'missing-optional-pty', otherServicesRetained: true }))
  }
} finally {
  for (const h of clients) {
    for (const id of h.terminals) if (h.socket?.readyState === 1) await request(h, 'close', { terminalId: id }).catch(() => {})
    await stop(h).catch(() => {})
  }
  for (const socket of sockets) socket.terminate()
  await new Promise(done => peer.close(done)); await new Promise(done => http.close(done))
}
