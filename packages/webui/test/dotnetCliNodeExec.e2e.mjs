// Actual Source jobs and CLI restarts use owned credentials, Agent roots and a loopback protocol peer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const clients = [], sockets = new Set(), frames = []
const exists = path => access(path).then(() => true, () => false)
const http = createServer(), peer = new WebSocketServer({ server: http })
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `http://127.0.0.1:${http.address().port}`
const mode = new Map(), connected = new Map(), generations = new Map()
let serial = 0
peer.on('connection', (socket, request) => {
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket) })
  const id = new URL(request.url, origin).searchParams.get('id')
  socket.on('message', bytes => {
    const value = JSON.parse(bytes); frames.push({ id, socket, value })
    if (value.type === 'node_register') {
      connected.set(id, socket); generations.set(id, (generations.get(id) || 0) + 1)
      socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: mode.get(id) === 'incompatible' ? 99 : 3, master: { min: 1, max: 3 } } }))
    }
    if (value.type === 'session_event') {
      if (mode.get(id) === 'drop') return
      socket.send(JSON.stringify(mode.get(id) === 'reject' ? { type: 'error', requestId: value.requestId, error: 'owned admission rejected' } : { type: 'session_event_accepted', requestId: value.requestId }))
    }
  })
})
async function launch(name, source = false, environment = {}) {
  const cwd = join(root, name); await mkdir(cwd, { recursive: true })
  const id = name, before = generations.get(id) || 0
  const executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
  const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', origin, '--id', id, '--auth-token', 'synthetic-' + name, '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger'], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: 'agents', FOXWARM_NO_CONSOLE_LOG: '0', EXECTEST_INHERITED: 'inherited', fw_agentdir: 'wrong-parent', fw_tmp: 'wrong-parent', FW_AGENTDIR: 'posix-uppercase-kept', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = { child, cwd, id, output: '' }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output += bytes })
  await until(() => (generations.get(id) || 0) > before, 'CLI registration ' + name)
  handle.socket = connected.get(id)
  return handle
}
async function stop(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { handle.child.kill('SIGKILL'); reject(new Error('CLI did not drain: ' + handle.output)) }, 6000) })]) }
  finally { clearTimeout(timer) }
}
async function command(handle, command, args = {}, metadata = {}, cancel = false) {
  const callId = 'owned-' + ++serial
  const request = { type: 'tool_call', callId, tool: 'exec', sessionId: 'main/owned', agentName: 'main', backgroundExecId: 'quiet-' + String(serial).split('').map(c => String.fromCharCode(97 + Number(c))).join(''), completionCapability: 'synthetic-capability-' + serial, args: { command, timeout: 2, ...args }, ...metadata }
  handle.socket.send(JSON.stringify(request))
  if (cancel) handle.socket.send(JSON.stringify({ type: 'tool_call_cancel', callId }))
  const reply = await until(() => frames.find(row => row.socket === handle.socket && row.value.callId === callId && ['tool_call_response', 'tool_call_error'].includes(row.value.type))?.value, 'exec reply ' + callId, 65000)
  return { request, reply }
}
const registry = handle => join(handle.cwd, 'agents/main/.temp/exec/running-exec.json')
const tracked = async handle => JSON.parse(await readFile(registry(handle), 'utf8'))
const events = handle => frames.filter(row => row.id === handle.id && row.value.type === 'session_event').map(row => row.value)
const good = result => { assert.equal(result.reply.type, 'tool_call_response', JSON.stringify(result.reply)); return result.reply.result }
const normalized = output => output.replaceAll(/Duration: [^\n]+/g, 'Duration: <measured>').replaceAll(/Command output saved to: [^\n]+/g, 'Command output saved to: <log>')

try {
  const source = await launch('source', true), cli = await launch('cli')
  const caps = frames.find(row => row.id === cli.id && row.value.type === 'node_register').value.capabilities
  assert(caps.features.execWaitCancellation && caps.features.remoteExecBackgroundRegistration)
  assert.equal(caps.features.externalToolOwner, 1)
  // These are the first execs for genuinely absent Agent roots, before the corpus prepares tmp.
  for (const handle of [source, cli]) {
    for (const [agent, args, metadata, suffix] of [
      ['main', { cwd: '$fw_tmp' }, {}, '/tmp'],
      ['fresh-root', { cwd: '$fw_agentdir' }, {}, ''],
      ['fresh-session', {}, { sessionCwd: '$fw_tmp' }, '/tmp'],
    ]) {
      const agentDirectory = join(handle.cwd, 'agents', agent), cwd = agentDirectory + suffix
      assert(!await exists(agentDirectory), 'Agent root must not exist before first exec')
      const first = await command(handle, 'pwd; printf "once\\n" >> first-effect', args, { agentName: agent, programmatic: true, ...metadata })
      console.log(JSON.stringify({ firstAgentExec: handle.id, agent, agentExistedBefore: false, reply: first.reply }))
      const result = good(first)
      assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0)
      assert.equal(result.content, cwd + '\n')
      assert.equal(result.execId, first.request.backgroundExecId)
      assert.equal(await readFile(join(cwd, 'first-effect'), 'utf8'), 'once\n')
      assert(result.logPath.startsWith(join(agentDirectory, '.temp/exec') + '/'))
      assert.equal(await readFile(result.logPath, 'utf8'), cwd + '\n')
      assert.equal((await readFile(result.logPath + '.cwd.txt', 'utf8')).trim(), cwd)
      assert.equal(JSON.parse(await readFile(result.logPath + '.exit.json', 'utf8')).exitCode, 0)
    }
    const agent = 'fresh-missing', agentDirectory = join(handle.cwd, 'agents', agent)
    const missing = join(handle.cwd, 'arbitrary-missing')
    assert(!await exists(agentDirectory)); assert(!await exists(missing))
    const rejected = await command(handle, 'printf forbidden >> must-not-run', { cwd: missing }, { agentName: agent })
    console.log(JSON.stringify({ missingCwdControl: handle.id, reply: rejected.reply }))
    assert.equal(rejected.reply.type, 'tool_call_error'); assert.equal(rejected.reply.execStarted, false)
    assert.match(rejected.reply.error.message, /path does not exist/); assert.match(rejected.reply.error.message, /Source: explicit/)
    assert(await exists(join(agentDirectory, 'tmp')), 'Source prepares Agent tmp even when arbitrary cwd is invalid')
    assert(!await exists(missing)); assert(!await exists(join(handle.cwd, 'must-not-run')))
  }
  const corpus = [
    'printf ""', 'printf "  \\n\\t "', 'printf "a\\r\\nb\\rc\\n"', 'printf "\\377\\376x\\n"', 'printf "x\\n"; exit 7',
    "printf '%0600d' 0", "for i in {1..5000}; do printf 'line-%s\\n' \"$i\"; done",
    "printf '%s' '漢字é🙂é'; printf '\\n'",
    "head -c 1048576 /dev/zero | tr '\\0' a", "head -c 1048577 /dev/zero | tr '\\0' a", "head -c 1048577 /dev/zero",
    "printf '\\377'; head -c 1048576 /dev/zero | tr '\\0' a",
  ]
  for (const text of corpus) {
    const expected = good(await command(source, text, {}, { programmatic: true }))
    const actual = good(await command(cli, text, {}, { programmatic: true }))
    for (const key of ['content', 'truncated', 'status', 'exitCode', 'sizeBytes']) assert.deepEqual(actual[key], expected[key], text + ': ' + key)
    assert.equal(normalized(actual.output), normalized(expected.output), text)
  }
  const inherited = good(await command(cli, 'printf "%s|%s|%s|%s" "$EXECTEST_INHERITED" "$fw_agentdir" "$fw_tmp" "$FW_AGENTDIR"', {}, { programmatic: true }))
  assert.equal(inherited.content, `inherited|${cli.cwd}/agents/main|${cli.cwd}/agents/main/tmp|posix-uppercase-kept`)
  const project = join(cli.cwd, 'project'), child = join(project, 'child'); await mkdir(child, { recursive: true })
  assert.equal(good(await command(cli, 'pwd', { cwd: 'child' }, { sessionCwd: project, programmatic: true })).content, child + '\n')
  assert.equal(good(await command(cli, 'pwd', {}, { programmatic: true })).content, cli.cwd + '\n')
  assert.equal(good(await command(cli, 'pwd', { cwd: '$fw_tmp' }, { programmatic: true })).content, cli.cwd + '/agents/main/tmp\n')
  const invalid = await command(cli, 'printf must-not-run > invalid-effect', { cwd: '/owned-missing-directory' })
  assert.equal(invalid.reply.execStarted, false); assert.match(invalid.reply.error.message, /Source: explicit/)
  for (const timeout of [0, '1', false]) assert.equal((await command(cli, 'true', { timeout })).reply.execStarted, false)
  const cancelled = await command(cli, 'printf forbidden > prelaunch-cancel', {}, {}, true)
  // Cancellation is a prelaunch fence or an exact started wait, never command replay.
  if (cancelled.reply.type === 'tool_call_error') { assert.equal(cancelled.reply.execStarted, false); assert(!await exists(join(cli.cwd, 'prelaunch-cancel'))) }
  else { assert.match(good(cancelled).output, /not killed|Exit code/); assert.equal(await readFile(join(cli.cwd, 'prelaunch-cancel'), 'utf8'), 'forbidden') }
  const foreground = good(await command(cli, 'printf capped', { timeout: 65 })); assert.match(foreground.output, /WARNING: Requested timeout 65s/)
  const legacy = 'exec_owned_legacy_1234'
  good(await command(cli, 'printf legacy', {}, { backgroundExecId: legacy }))
  const collision = await command(cli, 'printf forbidden > collision-effect', {}, { backgroundExecId: legacy })
  assert.equal(collision.reply.execStarted, false); assert.equal(collision.reply.error.code, 'PERSISTENT_EXEC_ID_COLLISION'); assert(!await exists(join(cli.cwd, 'collision-effect')))
  // A late cancellation cannot cancel another outstanding call or any independent command.
  const pending = command(cli, 'printf start > stop-count; sleep 3; printf done >> stop-count', { timeout: 30 })
  await until(() => exists(join(cli.cwd, 'stop-count')), 'new command actually launched')
  const stopCall = frames.filter(row => row.socket === cli.socket && row.value.type === 'tool_call_response').at(-1)?.value.callId
  if (stopCall) cli.socket.send(JSON.stringify({ type: 'tool_call_cancel', callId: stopCall }))
  const activeCall = 'owned-' + serial
  cli.socket.send(JSON.stringify({ type: 'tool_call_cancel', callId: activeCall }))
  const stopped = await pending; assert.match(good(stopped).output, /not killed/)
  const backgroundNotice = frames.findIndex(row => row.socket === cli.socket && row.value.type === 'remote_exec_background' && row.value.execId === stopped.request.backgroundExecId)
  const ordinaryReply = frames.findIndex(row => row.socket === cli.socket && row.value.callId === activeCall)
  assert(backgroundNotice >= 0 && backgroundNotice < ordinaryReply)
  await until(async () => (await readFile(join(cli.cwd, 'stop-count'), 'utf8')) === 'startdone', 'Stop leaves command alive')
  await until(() => events(cli).some(event => event.execId === stopped.request.backgroundExecId), 'new completion event')
  await until(async () => !(await tracked(cli)).execs.some(entry => entry.id === stopped.request.backgroundExecId), 'ACK removes new tracking')
  mode.set('cli', 'drop')
  const lostAck = await command(cli, 'printf once > lost-ack; sleep 1.2', { timeout: 1 })
  good(lostAck)
  await until(() => events(cli).some(event => event.execId === lostAck.request.backgroundExecId), 'completion sent with intentionally missing ACK')
  assert((await tracked(cli)).execs.some(entry => entry.id === lostAck.request.backgroundExecId))
  mode.set('cli', 'accept')
  await until(() => events(cli).filter(event => event.execId === lostAck.request.backgroundExecId).length >= 2, 'missing ACK times out and retries', 25000)
  await until(async () => !(await tracked(cli)).execs.some(entry => entry.id === lostAck.request.backgroundExecId), 'retry ACK removes tracking')
  assert.equal(await readFile(join(cli.cwd, 'lost-ack'), 'utf8'), 'once')
  await stop(source); await stop(cli)

  // Create both kinds of recovery records with the actual unchanged TS client, not hand-authored fixtures.
  mode.set('takeover', 'drop')
  let old = await launch('takeover', true)
  const finished = await command(old, 'printf once >> finished-count; sleep 1.2', { timeout: 1 })
  good(finished); await until(() => events(old).some(event => event.execId === finished.request.backgroundExecId), 'Source finished but unACKed')
  const running = { request: { backgroundExecId: 'exec_source_foreground_1234', completionCapability: 'synthetic-source-foreground' } }
  old.socket.send(JSON.stringify({ type: 'tool_call', callId: 'source-foreground', tool: 'exec', sessionId: 'main/owned', agentName: 'main', ...running.request, args: { command: 'printf start >> running-count; sleep 7; printf done >> running-count', timeout: 30 } }))
  await until(async () => (await tracked(old)).execs.length === 2, 'actual Source foreground registry publication')
  const originals = (await tracked(old)).execs
  assert.equal(originals.length, 2)
  await stop(old)
  mode.set('takeover', 'incompatible')
  const quarantined = await launch('takeover')
  await until(() => quarantined.child.exitCode !== null, 'incompatible client stops before recovery')
  assert.deepEqual((await tracked(quarantined)).execs, originals)
  assert.equal(frames.filter(row => row.socket === quarantined.socket && row.value.type === 'session_event').length, 0)
  mode.set('takeover', 'reject')
  const replacement = await launch('takeover')
  await until(() => events(replacement).filter(event => event.execId === finished.request.backgroundExecId).length >= 2, 'C# recovered event rejected and retained')
  const recovered = (await tracked(replacement)).execs
  for (const original of originals) {
    const entry = recovered.find(entry => entry.id === original.id); assert(entry)
    if (!original.notifyOnCompletion) { assert.equal(entry.notifyOnCompletion, true); assert.equal(entry.recoveredAfterRestart, true) }
    for (const key of ['pid', 'sessionId', 'agentName', 'nodeId', 'command', 'initialCwd', 'logPath', 'statusPath', 'cwdPath', 'startedAt', 'completionCapability']) assert.deepEqual(entry[key], original[key], key)
  }
  assert.equal(await readFile(join(replacement.cwd, 'finished-count'), 'utf8'), 'once')
  await until(async () => (await readFile(join(replacement.cwd, 'running-count'), 'utf8')) === 'startdone', 'original Node wrapper survives TS shutdown')
  mode.set('takeover', 'accept')
  await until(async () => (await tracked(replacement)).execs.length === 0, 'recovered jobs removed only after accepted completion', 22000)
  assert.equal(await readFile(join(replacement.cwd, 'running-count'), 'utf8'), 'startdone')
  assert.equal(events(replacement).filter(event => event.execId === finished.request.backgroundExecId).every(event => event.eventId === 'remote-exec-completion:' + finished.request.backgroundExecId && event.completionCapability === finished.request.completionCapability), true)
  assert.equal((await command(replacement, 'printf forbidden > takeover-collision', {}, { backgroundExecId: running.request.backgroundExecId })).reply.error.code, 'PERSISTENT_EXEC_ID_COLLISION')
  await stop(replacement)

  // An actual new CLI command also survives its own clean shutdown; restart marks foreground recovery.
  mode.set('restart', 'drop')
  let restart = await launch('restart')
  restart.socket.send(JSON.stringify({ type: 'tool_call', callId: 'restart-foreground', tool: 'exec', sessionId: 'main/owned', agentName: 'main', backgroundExecId: 'native-restart', completionCapability: 'owned-restart-grant', args: { command: 'printf start >> restart-count; sleep 3; printf done >> restart-count', timeout: 30 } }))
  await until(() => exists(join(restart.cwd, 'restart-count')), 'new native wrapper launched before shutdown')
  await stop(restart)
  // No reply can cross the old connection. The command itself remains independently alive.
  const record = (await tracked(restart)).execs[0]; assert(record)
  mode.set('restart', 'accept'); restart = await launch('restart')
  await until(async () => (await tracked(restart)).execs.length === 0, 'new wrapper recovery acknowledged')
  assert.equal(await readFile(join(restart.cwd, 'restart-count'), 'utf8'), 'startdone')
  const event = events(restart).find(event => event.execId === record.id); assert(event)
  await stop(restart)

  // Tracking expiry uses a real still-running Source command. Only its owned timestamp is advanced.
  mode.set('expiry', 'drop')
  const expiring = await launch('expiry', true)
  const expired = await command(expiring, 'printf start > expiry-count; sleep 4; printf done >> expiry-count', { timeout: 1 })
  good(expired); await stop(expiring)
  const expiredRegistry = await tracked(expiring); expiredRegistry.execs[0].startedAt = Date.now() - 86400001
  await writeFile(registry(expiring), JSON.stringify(expiredRegistry))
  const expiry = await launch('expiry')
  await until(async () => (await tracked(expiry)).execs.length === 0, 'strictly expired tracking removed')
  assert.equal(events(expiry).length, 0)
  await until(async () => (await readFile(join(expiry.cwd, 'expiry-count'), 'utf8')) === 'startdone', 'expired tracking does not kill original process')
  assert(await exists(expiredRegistry.execs[0].logPath)); await until(() => exists(expiredRegistry.execs[0].statusPath), 'original expired wrapper still publishes its status')
  await stop(expiry)
  console.log(JSON.stringify({ corpusRows: corpus.length, actualSourceTakeoverJobs: originals.length, sourceAndNewShutdownSurvival: true, foregroundStopBackgroundAck: true, rejectedAckRetry: true, expiryWithoutKill: true, clients: clients.length }))
} catch (error) {
  for (const handle of clients) console.error(handle.id, handle.output)
  throw error
} finally {
  for (const handle of clients) await stop(handle)
  for (const socket of sockets) socket.terminate()
  await new Promise(done => peer.close(done)); await new Promise(done => http.close(done))
  if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await rm(root, { recursive: true, force: true })
  else console.log('Retained owned CLI exec root: ' + root)
}
