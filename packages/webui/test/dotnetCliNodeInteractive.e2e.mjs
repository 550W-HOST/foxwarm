// Real PTY entry, Session RPCs and ordinary tool effects. Main admission is qualified separately.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { consoleClient } from './cliNodeConsoleFixture.mjs'
import { until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const root = await mkdtemp(join(tmpdir(), 'cli-ui-'))
const http = createServer(), peer = new WebSocketServer({ server: http }), frames = [], clients = [], sockets = new Set()
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const host = `http://127.0.0.1:${http.address().port}`
let sessions = Array.from({ length: 11 }, (_, index) => ({ id: 'main/session-' + index, displayName: 'Session ' + index, messageCount: 50 }))
let holdHistory, heldHistory, rejectSend = false, serial = 0
const exists = path => access(path).then(() => true, () => false)
const answer = (socket, request, result, error) => socket.send(JSON.stringify({ type: 'cli_response', requestId: request.requestId, ok: !error, result, error }))
const history = id => ({ messages: Array.from({ length: 30 }, (_, index) => ({ index: index + 20, role: 'user', text: 'HISTORY-' + id + '-' + index + ' \u001b[2J\u009b31m 雪😀' + (index === 29 ? 'long-' + 'x'.repeat(600) + '-AFTER-PREVIEW' : '') })), totalMessages: 50 })
peer.on('connection', (socket, request) => {
  const id = new URL(request.url, host).searchParams.get('id')
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes); frames.push({ id, socket, frame })
    if (frame.type === 'node_register') socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    if (frame.type === 'session_list_request') answer(socket, frame, { sessions })
    if (frame.type === 'session_history_request') {
      assert.equal(frame.count, 30)
      if (frame.sessionId === holdHistory) heldHistory = { socket, frame }
      else answer(socket, frame, history(frame.sessionId))
    }
    if (frame.type === 'session_send_message') answer(socket, frame, { accepted: true }, rejectSend ? 'Session is no longer bound to this Node' : undefined)
    if (frame.type === 'session_event') answer(socket, frame, { queued: true })
  })
})
async function launch(name, extra = [], source = false) {
  const cwd = join(root, name); await mkdir(join(cwd, 'agents/main'), { recursive: true })
  const ui = await consoleClient(cwd, ['--host', host, '--id', name, '--auth-token', 'synthetic-console-token', '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger', ...extra], { source })
  clients.push(ui); ui.name = name
  const registration = await until(() => frames.find(row => row.id === name && row.frame.type === 'node_register'), name + ' registration')
  ui.socket = registration.socket
  await ui.wait(handle => handle.output.includes('History: main/session-0'), name + ' history')
  return ui
}
const records = ui => frames.filter(row => row.id === ui.name).map(row => row.frame)
const send = (ui, frame) => ui.socket.send(JSON.stringify(frame))
async function tool(ui, name, args, extra = {}) {
  const callId = 'interactive-' + ++serial
  send(ui, { type: 'tool_call', callId, tool: name, args, sessionId: 'main/caller', agentName: 'main', sessionCwd: ui.cwd, ...extra })
  return { callId, preview: args.filePath ? basename(args.filePath) : args.command?.split(/\s+/).at(-1), result: () => until(() => records(ui).find(row => row.callId === callId), name + ' reply') }
}
async function pending(ui, call) { await ui.wait(handle => handle.screen().includes('Tool call pending') && handle.screen().includes(call.preview), 'visible approval') }
async function decide(ui, call, key, success) {
  await pending(ui, call); ui.write(key); const result = await call.result()
  assert.equal(result.type, success ? 'tool_call_response' : 'tool_call_error', JSON.stringify(result))
  return result
}
async function navigationAndInput(ui) {
  ui.write('qPaste 雪😀é'); await ui.wait(handle => handle.screen().includes('qPaste 雪😀é'), 'Unicode paste stays draft')
  ui.write('\x7f'); await ui.wait(handle => handle.screen().includes('qPaste 雪😀') && !handle.screen().includes('qPaste 雪😀é'), 'grapheme deletion')
  ui.write('末'); await ui.wait(handle => handle.screen().includes('qPaste 雪😀末'), 'Unicode draft')
  assert.equal(records(ui).filter(frame => frame.type === 'session_send_message').length, 0)
  ui.write('\r'); const sent = await until(() => records(ui).find(frame => frame.type === 'session_send_message'), 'actual send')
  assert.equal(sent.message, 'qPaste 雪😀末'); assert.equal(sent.sessionId, 'main/session-0')
  for (let index = 1; index <= 9; index++) { ui.write('\x1b[B'); await ui.wait(handle => handle.screen().includes('Send to main/session-' + index + ':'), 'visible selected ' + index) }
  assert(ui.screen().includes('> main/session-9')); assert(!ui.screen().includes('HISTORY-main/session-0'))
  await ui.wait(handle => handle.screen().includes('HISTORY-main/session-9-29'), 'selected history')
  assert(ui.screen().includes('\\u001b[2J')); assert(ui.screen().includes('\\u009b31m'))
  assert(!ui.screen().includes('HISTORY-main/session-9-17 ')); assert(ui.screen().includes('(30/50)'))
  ui.resize(700, 48); await ui.wait(handle => handle.screen().includes('HISTORY-main/session-9-29'), 'wide bounded history'); await sleep(50); assert(!ui.screen().includes('-AFTER-PREVIEW')); assert(ui.screen().includes('…')); ui.resize(120, 42)
  await sleep(3200); assert(ui.screen().includes('Send to main/session-9:'))
  sessions = [...sessions].reverse(); ui.write('\x12')
  await ui.wait(handle => handle.screen().includes('> main/session-9'), 'selection survives reorder')
  await sleep(100); assert(ui.screen().includes('Send to main/session-9:'))
  holdHistory = 'main/session-8'; ui.write('\x1b[B')
  await until(() => heldHistory, 'delayed history'); ui.write('\x1b[B')
  await ui.wait(handle => handle.screen().includes('Send to main/session-7:'), 'selection while RPC waits')
  answer(heldHistory.socket, heldHistory.frame, { messages: [{ index: 0, role: 'user', text: 'STALE-RESPONSE-MUST-NOT-RENDER' }], totalMessages: 1 }); holdHistory = null
  await ui.wait(handle => handle.screen().includes('HISTORY-main/session-7-29'), 'current history after stale response')
  assert(!ui.output.includes('STALE-RESPONSE-MUST-NOT-RENDER'))
  ui.write('captured target'); await ui.wait(handle => handle.screen().includes('captured target'), 'draft before target send'); ui.write('\r')
  await until(() => records(ui).filter(frame => frame.type === 'session_send_message').length === 2, 'captured send')
  ui.write('\x1b[B'); await ui.wait(handle => handle.screen().includes('Send to main/session-6:'), 'navigation after send')
  assert.equal(records(ui).filter(frame => frame.type === 'session_send_message')[1].sessionId, 'main/session-7')
  rejectSend = true; ui.write('denied once'); await ui.wait(handle => handle.screen().includes('denied once'), 'denied draft'); ui.write('\r')
  await ui.wait(handle => handle.screen().includes('Send failed: Session is no longer bound'), 'real send rejection')
  await sleep(100); assert.equal(records(ui).filter(frame => frame.type === 'session_send_message').length, 3)
  assert(!ui.screen().includes('denied once')); rejectSend = false
  sessions = sessions.filter(row => row.id !== 'main/session-6'); ui.write('\x12')
  await ui.wait(handle => !handle.screen().includes('Send to main/session-6:'), 'removed selection clamped')
  ui.resize(42, 10); await sleep(80); ui.resize(120, 42)
  const previousSessions = sessions; sessions = []; ui.write('\x12'); await ui.wait(handle => handle.screen().includes('No sessions bound') && !handle.screen().includes('HISTORY-'), 'empty list clears selected history'); sessions = previousSessions; ui.write('\x12'); await ui.wait(handle => handle.screen().includes('Send to main/'), 'sessions return after empty list')
}
async function decisions(ui) {
  const path = name => join(ui.cwd, name)
  ui.write('saved draft'); await ui.wait(handle => handle.screen().includes('saved draft'), 'draft before approval')
  const rejected = await tool(ui, 'write', { filePath: path('rejected'), content: 'never' })
  await pending(ui, rejected); ui.write('\nY'); await sleep(120)
  assert(!records(ui).some(frame => frame.callId === rejected.callId)); assert(ui.screen().includes('Tool call pending'))
  await decide(ui, rejected, 'n', false); assert(!await exists(path('rejected'))); assert(ui.screen().includes('saved draft'))
  for (let index = 0; index < 'saved draft'.length; index++) { ui.write('\x7f'); await sleep(25) }
  const original = 'actual Unicode ' + '雪😀'.repeat(400) + '\u001b[2J'
  const approved = await tool(ui, 'write', { filePath: path('approved'), content: original })
  await pending(ui, approved); assert(ui.screen().includes('…')); await decide(ui, approved, 'Y', true); assert.equal(await readFile(path('approved'), 'utf8'), original)
  const exec = await tool(ui, 'exec', { command: 'printf launched > approved-exec', timeout: 2 })
  await decide(ui, exec, '\r', true); assert.equal(await readFile(path('approved-exec'), 'utf8'), 'launched')
  const noexec = await tool(ui, 'exec', { command: 'touch rejected-exec' })
  assert.equal((await decide(ui, noexec, '\x1b', false)).execStarted, false); assert(!await exists(path('rejected-exec')))
  const held = await tool(ui, 'write', { filePath: path('held'), content: 'held' })
  await pending(ui, held)
  ui.resize(40, 8); await ui.wait(handle => handle.screen().includes('Y/Enter approve, N/Esc reject') && handle.screen().includes('Send to '), 'approval actions and draft remain visible in a short terminal'); ui.resize(120, 42); await pending(ui, held)
  const busy = await tool(ui, 'write', { filePath: path('busy'), content: 'never' })
  assert.match((await busy.result()).error.message, /another interactive tool call/); assert(!await exists(path('busy')))
  // Fixed services and transfers stay outside the manual slot.
  const requestId = 'service-bypass'
  send(ui, { type: 'node_service_request', requestId, service: 'vscode-fs', operation: 'stat', args: { path: path('approved') } })
  assert.equal((await until(() => records(ui).find(frame => frame.requestId === requestId), 'service bypass')).type, 'node_service_response')
  send(ui, { type: 'file_write_request', transferId: 'transfer-bypass', agentName: 'main', filePath: path('transfer'), dataBase64: Buffer.from('transfer').toString('base64') })
  assert.equal((await until(() => records(ui).find(frame => frame.transferId === 'transfer-bypass'), 'transfer bypass')).type, 'file_write_response')
  assert.equal(await readFile(path('transfer'), 'utf8'), 'transfer')
  ui.write('A'); await ui.wait(handle => handle.screen().includes('auto: all'), 'live future policy')
  const automatic = await tool(ui, 'write', { filePath: path('future-auto'), content: 'auto' }); assert.equal((await automatic.result()).type, 'tool_call_response')
  assert(!await exists(path('held'))); assert(ui.screen().includes('Tool call pending'))
  ui.write('a'); await ui.wait(handle => handle.screen().includes('auto: manual'), 'toggle policy back')
  await decide(ui, held, 'n', false)
  const stopped = await tool(ui, 'exec', { command: 'touch stopped-never' }); await pending(ui, stopped)
  send(ui, { type: 'tool_call_cancel', callId: 'not-this-call' }); await sleep(80); assert(ui.screen().includes('Tool call pending'))
  send(ui, { type: 'tool_call_cancel', callId: stopped.callId }); assert.equal((await stopped.result()).execStarted, false)
  await ui.wait(handle => !handle.screen().includes('Tool call pending'), 'cancelled slot clears')
  ui.write('y'); await sleep(80); assert(!await exists(path('stopped-never'))); ui.write('\x7f'); await sleep(60)
  const next = await tool(ui, 'write', { filePath: path('next'), content: 'next' }); await pending(ui, next)
  send(ui, { type: 'tool_call_cancel', callId: stopped.callId }); await decide(ui, next, 'Y', true)
  assert.equal(await readFile(path('next'), 'utf8'), 'next'); assert(!await exists(path('stopped-never')))
  const timed = await tool(ui, 'exec', { command: 'touch timed-never' }, { timeoutMs: 2200 }); const began = Date.now()
  const timeout = await timed.result(); assert.equal(timeout.execStarted, false); assert.match(timeout.error.message, /timed out waiting/); assert(Date.now() - began >= 900); assert(!await exists(path('timed-never')))
  const timedWrite = await tool(ui, 'write', { filePath: path('timed-write-never'), content: 'never' }, { timeoutMs: 100 }); assert.match((await timedWrite.result()).error.message, /timed out waiting/); assert(!await exists(path('timed-write-never')))
  const untimed = await tool(ui, 'write', { filePath: path('untimed'), content: 'never' }); await pending(ui, untimed); await sleep(1200)
  assert(!records(ui).some(frame => frame.callId === untimed.callId)); await decide(ui, untimed, 'n', false)
  const lost = await tool(ui, 'write', { filePath: path('lost-never'), content: 'never' }); await pending(ui, lost)
  ui.socket.close(1000, 'owned connection loss'); await ui.wait(handle => !handle.screen().includes('Tool call pending'), 'loss settles approval')
  const old = ui.socket; await until(() => frames.filter(row => row.id === ui.name && row.frame.type === 'node_register').length === 2, 'native reconnect')
  ui.socket = frames.filter(row => row.id === ui.name && row.frame.type === 'node_register').at(-1).socket; assert.notEqual(ui.socket, old)
  ui.write('Y'); await sleep(100); assert(!await exists(path('lost-never'))); assert(!records(ui).some(frame => frame.callId === lost.callId)); ui.write('\x7f'); await sleep(60)
  const shutdown = await tool(ui, 'write', { filePath: path('shutdown-never'), content: 'never' }); await pending(ui, shutdown)
  await ui.signal(); await ui.stopped(); assert(!await exists(path('shutdown-never')))
}
try {
  const ui = await launch('native-console')
  assert.equal(records(ui).find(frame => frame.type === 'node_register').capabilities.features.externalToolOwner, undefined)
  await navigationAndInput(ui); await decisions(ui)
  sessions = [{ id: 'main/session-0', messageCount: 0 }]
  const pattern = await launch('pattern-console', ['--auto-approve', '^(WRITE|read|apply_patch)$', '--timeout', '3'])
  const match = await tool(pattern, 'write', { filePath: join(pattern.cwd, 'pattern'), content: 'matched' }); assert.equal((await match.result()).type, 'tool_call_response')
  const fallback = await tool(pattern, 'exec', { command: 'touch fallback-never' }); assert.match((await fallback.result()).error.message, /timed out waiting/); assert(!await exists(join(pattern.cwd, 'fallback-never')))
  pattern.write('q'); await pattern.stopped()
  // Native ECMAScript mode is deliberately qualified, not a claim of all JavaScript syntax.
  const differential = []
  for (const nativePattern of ['^\\p{L}+$', '(?i)^write$']) {
    let javascript
    try { javascript = new RegExp(nativePattern, 'i').test('write') } catch { javascript = 'invalid' }
    const native = await launch('difference-' + differential.length, ['--auto-approve', nativePattern])
    const admitted = await tool(native, 'write', { filePath: join(native.cwd, 'matched'), content: nativePattern })
    assert.equal((await admitted.result()).type, 'tool_call_response'); assert.equal(await readFile(join(native.cwd, 'matched'), 'utf8'), nativePattern)
    differential.push({ pattern: nativePattern, nativeWrite: true, javascriptWrite: javascript })
    native.write('q'); await native.stopped()
  }
  assert.deepEqual(differential.map(row => row.javascriptWrite), [false, 'invalid'])
  console.log(JSON.stringify({ nativeRegexDifferences: differential }))
  const all = await launch('all-console', ['--auto-approve-all'])
  assert.equal(records(all).find(frame => frame.type === 'node_register').capabilities.features.externalToolOwner, undefined)
  const automatic = await tool(all, 'write', { filePath: join(all.cwd, 'all'), content: 'all' }); assert.equal((await automatic.result()).type, 'tool_call_response')
  const external = await tool(all, 'write', { filePath: join(all.cwd, 'external-never'), content: 'never' }, { sessionId: undefined, agentName: undefined, owner: { kind: 'external', externalId: 'fixture', contextId: '01234567-89ab-cdef-0123-456789abcdef' } })
  assert.match((await external.result()).error.message, /not available/); assert(!await exists(join(all.cwd, 'external-never')))
  all.write('\x03'); await all.stopped()
  const invalid = await consoleClient(join(root, 'invalid'), ['--host', host, '--id', 'invalid', '--auth-token', 'synthetic', '--auto-approve', '[', '--no-local-trigger']); clients.push(invalid); await invalid.stopped(1); assert(invalid.output.includes('Invalid --auto-approve'))
  for (const source of [false, true]) {
    const name = 'redirect-output-' + source, cwd = join(root, name), stdoutFile = join(cwd, 'console-output')
    const redirected = await consoleClient(cwd, ['--host', host, '--id', name, '--auth-token', 'synthetic', '--no-local-trigger'], { source, stdoutFile }); clients.push(redirected); redirected.name = name
    await until(() => frames.some(row => row.id === name && row.frame.type === 'node_register'), 'redirected registration')
    await redirected.wait(async () => (await readFile(stdoutFile, 'utf8').catch(() => '')).includes('Send to main/session-0'), 'console input with redirected output')
    redirected.write('qRedirect 雪😀'); await sleep(80); redirected.write('\r')
    await until(() => records(redirected).some(frame => frame.type === 'session_send_message'), 'redirected output actual send')
    assert.equal(records(redirected).find(frame => frame.type === 'session_send_message').message, 'qRedirect 雪😀')
    redirected.write('q'); await redirected.stopped()
  }
  const inputPipe = await consoleClient(join(root, 'redirected-input'), ['--host', host, '--id', 'redirected-input', '--auth-token', 'synthetic', '--no-local-trigger'], { stdinFile: '/dev/null' }); clients.push(inputPipe); await inputPipe.stopped(1); assert(inputPipe.output.includes('--interactive needs console input'))
  holdHistory = 'main/session-0'; heldHistory = null
  const rpcShutdown = await launch('pending-rpc-shutdown'); await until(() => heldHistory, 'pending history RPC during shutdown'); await rpcShutdown.signal(); await rpcShutdown.stopped(); holdHistory = null; heldHistory = null
  const startupFailure = await consoleClient(join(root, 'startup-failure'), ['--host', 'not-a-websocket-origin', '--id', 'startup-failure', '--auth-token', 'synthetic', '--no-local-trigger']); clients.push(startupFailure); await startupFailure.stopped(1)
  const source = await launch('source-input', [], true)
  source.write('qPaste 雪😀é'); await sleep(100); source.write('\r')
  await until(() => records(source).some(frame => frame.type === 'session_send_message'), 'actual Source paste send')
  assert.equal(records(source).find(frame => frame.type === 'session_send_message').message, 'qPaste 雪😀é')
  const sourcePending = await tool(source, 'write', { filePath: join(source.cwd, 'source-never'), content: 'never' }); await source.wait(handle => handle.output.includes('Tool call pending'), 'Source pending input comparison')
  source.write('\nY'); await sleep(120); assert(!records(source).some(frame => frame.callId === sourcePending.callId)); source.write('n'); await sourcePending.result(); assert(!await exists(join(source.cwd, 'source-never')))
  source.write('\x03'); await source.stopped()
  console.log(JSON.stringify({ actualNativeEntry: !!process.env.FOXWARM_CLI_EXECUTABLE, sourceInputComparison: true, sessionRpcAndCapturedSend: true, liveSelectionReorderWindowAndStaleResponse: true, actualManualPatternAllEffects: true, exactCancellationBusyServiceBypassAndReconnect: true, shellRestoration: true, toolCalls: serial }))
} catch (error) { console.error(clients.map(ui => ui.name + ': ' + ui.output).join('\n')); throw error }
finally { for (const ui of clients) await ui.dispose(); for (const socket of sockets) socket.terminate(); await new Promise(done => peer.close(done)); await new Promise(done => http.close(done)); await rm(root, { recursive: true, force: true }) }
