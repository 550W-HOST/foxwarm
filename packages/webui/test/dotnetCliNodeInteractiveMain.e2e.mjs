// Normal unchanged Source and C# Main, their real model/Session owners, and the native console entry.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { consoleClient } from './cliNodeConsoleFixture.mjs'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const functionCall = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const exists = path => access(path).then(() => true, () => false)
for (const runtime of ['source', 'dotnet']) {
  const env = {}, fixture = await createHostFixture('cli-console-' + runtime, { runtime, normalStartup: true, env })
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '' })
  const cwd = join(fixture.root, 'cli'); await mkdir(join(cwd, 'agents/main'), { recursive: true })
  const plans = new Map(), rounds = new Map(), failures = [], wire = [], sockets = new Set()
  const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const part = (state, id) => state.history.flatMap(row => row.parts || []).find(row => row.functionResponse?.tool_use_id === id)?.functionResponse?.response
  const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CONSOLE-DONE-' + key }] }]
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(row => row.text || '').join('\n')
      const key = [...prompt.matchAll(/CONSOLE:([\w-]+)/g)].at(-1)?.[1], round = rounds.get(key) || 0; rounds.set(key, round + 1)
      const output = plans.get(key)?.[round] || final(key)
      for (const tool of output.filter(row => row.type === 'function_call')) assert(body.tools.some(row => row.name === tool.name), 'real advertised tool ' + tool.name)
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: cli-console-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, models: ['wire'] } } }))
  const proxyHttp = createServer(), proxy = new WebSocketServer({ server: proxyHttp })
  proxyHttp.listen(0, '127.0.0.1'); await once(proxyHttp, 'listening')
  const host = `http://127.0.0.1:${proxyHttp.address().port}`
  proxy.on('connection', (down, request) => {
    const up = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url), pending = []
    sockets.add(up); sockets.add(down)
    up.on('open', () => { for (const bytes of pending) up.send(bytes.toString()) })
    down.on('message', bytes => { const frame = JSON.parse(bytes); wire.push({ from: 'cli', frame }); if (up.readyState === WebSocket.OPEN) up.send(bytes.toString()); else pending.push(bytes) })
    up.on('message', bytes => { wire.push({ from: 'main', frame: JSON.parse(bytes) }); if (down.readyState === WebSocket.OPEN) down.send(bytes.toString()) })
    for (const [from, to] of [[up, down], [down, up]]) { from.on('error', () => {}); from.on('close', () => { sockets.delete(from); if (to.readyState === WebSocket.OPEN) to.close() }) }
  })
  let ui
  const toolFrames = id => wire.filter(row => row.from === 'main' && row.frame.type === 'tool_call' && row.frame.sessionId === id).map(row => row.frame)
  const reply = call => until(() => wire.find(row => row.from === 'cli' && row.frame.callId === call.callId)?.frame, 'actual reply ' + call.callId)
  async function create(name) { const result = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: name }); assert.equal(result.status, 200); return result.body.sessionId }
  async function begin(id, key, steps) { plans.set(key, steps); rounds.set(key, 0); assert([200, 202].includes((await fixture.api('POST', route(id) + '/message', { text: 'CONSOLE:' + key })).status)) }
  async function finish(id, key, timeout = 22000) { return until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session; return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'CONSOLE-DONE-' + key)) ? state : null }, runtime + ' normal turn ' + key, timeout) }
  async function select(id) { const key = 'select-' + id.replaceAll('/', '-'); await begin(id, key, [[functionCall(key, 'node', { action: 'select', nodeId: 'console-cli' })]]); await ui.wait(handle => handle.screen().includes('Tool call pending for ' + id) && handle.screen().includes('get_default_cwd'), 'normal node selection cwd approval'); ui.write('Y'); await finish(id, key) }
  async function pending(id, key, name, args) {
    const before = toolFrames(id).length
    await begin(id, key, [[functionCall(key, name, args)]])
    const frame = await until(() => toolFrames(id)[before], key + ' actual Main call')
    await ui.wait(handle => handle.screen().includes('Tool call pending for ' + id), key + ' console prompt')
    assert.equal(frame.timeoutMs, 62000)
    return frame
  }
  async function decision(id, key, name, args, input, success) {
    const call = await pending(id, key, name, args); ui.write(input)
    assert.equal((await reply(call)).type, success ? 'tool_call_response' : 'tool_call_error')
    return { call, state: await finish(id, key) }
  }
  try {
    await fixture.start()
    const token = (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()
    ui = await consoleClient(cwd, ['--host', host, '--id', 'console-cli', '--token', token, '--credentials-file', join(cwd, 'credentials.json'), '--timeout', '3', '--no-local-trigger'])
    const pairing = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(row => row.requestedName === 'console-cli'), 'real pairing request')
    await ui.wait(handle => handle.screen().includes('/node approve ' + pairing.id), 'exact pairing command')
    assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pairing.id })).status, 200)
    await ui.wait(handle => handle.screen().includes('registered') && handle.screen().includes('nodeId=console-cli'), 'registered status')
    await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.some(node => node.id === 'console-cli' && node.online), 'actual registered Node')
    assert.equal(wire.find(row => row.frame.type === 'node_register').frame.capabilities.features.externalToolOwner, undefined)
    const actor = await create('console-actor'); await select(actor)
    await ui.wait(handle => handle.screen().includes('Send to ' + actor + ':') && handle.screen().includes('CONSOLE-DONE-select-'), 'actual native list/history')
    const sentText = 'CONSOLE:from-console 雪😀é'
    ui.write(sentText); await ui.wait(handle => handle.screen().includes('from-console'), 'actual Unicode draft'); ui.write('\r')
    await finish(actor, 'from-console')
    const sends = wire.filter(row => row.frame.type === 'session_send_message').map(row => row.frame)
    assert.equal(sends.length, 1); assert.equal(sends[0].sessionId, actor); assert.equal(sends[0].message, sentText)
    assert((await saved(actor)).history.some(row => row.role === 'user' && row.parts?.some(part => (part.text || part.system)?.includes(sentText))))
    await ui.wait(handle => handle.screen().includes('CONSOLE-DONE-from-console'), 'normal Main history refresh after send')
    const writeArgs = name => ({ filePath: join(cwd, name), content: 'actual model Unicode 雪😀' })
    await decision(actor, 'approve-write', 'write', writeArgs('approved-write'), 'Y', true)
    assert.equal(await readFile(join(cwd, 'approved-write'), 'utf8'), 'actual model Unicode 雪😀')
    await decision(actor, 'reject-write', 'write', writeArgs('rejected-write'), 'n', false); assert(!await exists(join(cwd, 'rejected-write')))
    await decision(actor, 'approve-exec', 'exec', { command: 'printf actual > approved-exec', timeout: 2 }, '\r', true); assert.equal(await readFile(join(cwd, 'approved-exec'), 'utf8'), 'actual')
    await decision(actor, 'reject-exec', 'exec', { command: 'touch rejected-exec' }, '\x1b', false); assert(!await exists(join(cwd, 'rejected-exec')))
    const serverFirst = await pending(actor, 'server-first', 'write', writeArgs('server-first'))
    await sleep(1300); assert(!wire.some(row => row.from === 'cli' && row.frame.callId === serverFirst.callId)); ui.write('n'); await reply(serverFirst); await finish(actor, 'server-first')
    const other = await create('console-other'); await select(other)
    const held = await pending(actor, 'busy-first', 'write', writeArgs('busy-first'))
    await begin(other, 'busy-second', [[functionCall('busy-second', 'write', writeArgs('busy-second'))]])
    const busy = await until(() => toolFrames(other).find(row => row.tool === 'write'), 'second actual Session request')
    assert.match((await reply(busy)).error.message, /another interactive tool call/); await finish(other, 'busy-second')
    assert(ui.screen().includes('Tool call pending for ' + actor)); assert(!await exists(join(cwd, 'busy-first'))); assert(!await exists(join(cwd, 'busy-second')))
    // Actual Main Code request completes while the model prompt stays open.
    const stat = await fixture.api('GET', '/api/vscode-web/fs/stat?nodeId=console-cli&path=' + encodeURIComponent(join(cwd, 'approved-write')))
    assert.equal(stat.status, 200); assert(ui.screen().includes('Tool call pending for ' + actor))
    ui.write('n'); await reply(held); await finish(actor, 'busy-first')
    const stopped = await pending(actor, 'stop-before', 'exec', { command: 'touch stop-before-never', timeout: 30 })
    assert.equal((await fixture.api('POST', route(actor) + (runtime === 'source' ? '/message' : '/stop'), runtime === 'source' ? { text: '/stop' } : {})).status, 200)
    await until(() => wire.some(row => row.frame.type === 'tool_call_cancel' && row.frame.callId === stopped.callId), 'real Stop exact call')
    assert.equal((await reply(stopped)).execStarted, false)
    await ui.wait(handle => !handle.screen().includes('Tool call pending'), 'Stop clears native approval'); ui.write('Y'); await sleep(80); ui.write('\x7f'); await sleep(80)
    assert(!await exists(join(cwd, 'stop-before-never')))
    const launched = await pending(other, 'stop-after', 'exec', { command: 'printf start > stop-after; sleep 2; printf done >> stop-after', timeout: 30 })
    ui.write('Y'); await until(() => exists(join(cwd, 'stop-after')), 'actual launch before Stop')
    assert.equal((await fixture.api('POST', route(other) + (runtime === 'source' ? '/message' : '/stop'), runtime === 'source' ? { text: '/stop' } : {})).status, 200)
    const launchedReply = await reply(launched); assert.equal(launchedReply.type, 'tool_call_response'); assert.match(launchedReply.result.output, /not killed/)
    await until(async () => (await saved(other)).meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + launched.backgroundExecId), 'real completion ACK after Stop')
    assert.equal(await readFile(join(cwd, 'stop-after'), 'utf8'), 'startdone')
    if (runtime === 'source') {
      const timed = await pending(actor, 'normal-timeout', 'exec', { command: 'touch normal-timeout-never' }), start = Date.now()
      const timedReply = await until(() => wire.find(row => row.from === 'cli' && row.frame.callId === timed.callId)?.frame, 'real server-derived approval timeout', 65000)
      assert.equal(timedReply.execStarted, false); assert.match(timedReply.error.message, /timed out waiting/); assert(Date.now() - start >= 59000 && Date.now() - start < 62000)
      assert(!await exists(join(cwd, 'normal-timeout-never'))); await finish(actor, 'normal-timeout')
    }
    const shutting = await pending(actor, 'shutdown-pending', 'write', writeArgs('shutdown-never'))
    await ui.signal(); await ui.stopped(); assert(!await exists(join(cwd, 'shutdown-never')))
    assert(!wire.some(row => row.from === 'cli' && row.frame.callId === shutting.callId && row.frame.type === 'tool_call_response'))
    console.log(JSON.stringify({ runtime, actualNativeEntry: !!process.env.FOXWARM_CLI_EXECUTABLE, actualPairingStatusListHistoryUnicodeSend: true, actualWriteExecApproveReject: true, realStopBeforeAndAfterLaunch: true, normalApprovalTimeoutObserved: runtime === 'source', busyAndCodeServiceBypass: true, exactOriginalReply: true, terminalRestored: true, modelRequests: [...rounds.values()].reduce((a, b) => a + b, 0), mainStarts: fixture.hostPids.length }))
  } catch (error) { console.error(runtime, fixture.output, ui?.output); throw error }
  finally { await ui?.dispose(); for (const socket of sockets) socket.terminate(); await new Promise(done => proxy.close(done)); await new Promise(done => proxyHttp.close(done)); model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup() }
}
