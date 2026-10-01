#!/usr/bin/env node
import { writeModelFixture } from './experimentModelFixture.mjs'
// One original-App/local Responses workflow: continuation, collaboration waits, clean-idle restart.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-wait-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(root, 'work')
const token = 'synthetic-wait-api-token'; const providerToken = 'synthetic-wait-provider-token'
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const plans = new Map(); const requests = []; const errors = []; const counts = new Map(); const holds = []
const sleep = ms => new Promise(done => setTimeout(done, ms))
const signal = () => { let release; const promise = new Promise(done => { release = done }); return { promise, release } }
const text = value => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const messageText = body => body.input.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join('\n')
let host, browser, provider, port, firstPid, secondPid
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(25) }
  throw new Error(`Timed out: ${label}; ${JSON.stringify({ errors, requests: requests.slice(-4).map(item => ({ id: item.id, n: item.n })), host: host?.output })}`)
}
async function request(method, path, value) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const path = id => `/api/sessions/${encodeURIComponent(id)}`
async function session(id) {
  const result = await request('POST', '/api/session-list/by-id', { ids: [id] })
  assert.equal(result.status, 200); return result.body.results[0].session
}
async function history(id) { return (await request('GET', `${path(id)}/history`)).body.messages }
async function authority(id) { return JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', `${id}.json`), 'utf8')) }
async function send(id, value) { assert.equal((await request('POST', `${path(id)}/message`, { text: value })).status, 202) }
async function command(id, value) { return request('POST', `${path(id)}/message`, { text: value }) }
async function create(name, script = []) {
  const result = await request('POST', '/api/sessions', { agentId: 'team', sessionId: name })
  assert.equal(result.status, 200, JSON.stringify(result)); const id = result.body.sessionId
  plans.set(id, script); return id
}
async function idle(id) { return until(async () => !(await session(id)).busy, `${id} idle`) }
async function waiting(id) { return until(async () => (await session(id)).runtimeState?.state === 'waiting', `${id} waiting`) }
async function final(id, marker) {
  await until(async () => (await history(id)).some(row => row.parts?.some(part => part.text?.includes(marker))), marker)
  await idle(id)
}
async function deliver(source, target, label, extra = []) {
  const id = `${label}-send`
  plans.get(source).push([call(id, 'send_to_session', { sessionId: target, message: label, afterSend: 'finish' }), ...extra])
  await send(source, label); await idle(source)
  await until(async () => (await history(source)).some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === id)), `${label} paired`)
}
async function startHost() {
  await writeModelFixture(dataRoot, { default: 'local', providers: { 'local': { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: providerToken, models: ['wire'] } } })
  const child = spawn(dotnet, [process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot, FOXWARM_EXPERIMENT_TOOL_ROOT: workRoot,
      FOXWARM_EXPERIMENT_PORT: String(port), FOXWARM_EXPERIMENT_API_TOKEN: token,
      FOXWARM_EXPERIMENT_RESPONSES_BASE_URI: `http://127.0.0.1:${provider.address().port}`,
      FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken, FOXWARM_EXPERIMENT_REQUEST_MODEL: 'wire',
      FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'local/wire', FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist') } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-14000) })
  const owned = { child, get output() { return output } }; host = owned
  await until(async () => { try { return (await request('GET', '/health')).status === 200 } catch { assert.equal(child.exitCode, null, output); return false } }, 'host health')
  return owned
}
async function stopHost() {
  assert.equal((await request('POST', '/admin/shutdown')).status, 202)
  const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([status]) => status), sleep(15000).then(() => 'timeout')])
  assert.equal(code, 0, host.output)
}
try {
  await mkdir(dataRoot); await mkdir(workRoot)
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.headers.authorization, `Bearer ${providerToken}`); assert.equal(req.url, '/responses')
      assert(body.tools.some(tool => tool.name === 'wait'))
      const id = /currentSessionId="([^"]+)"/.exec(messageText(body))?.[1]
      assert(id, 'Real snapshot Session identity'); const n = counts.get(id) || 0; counts.set(id, n + 1)
      requests.push({ id, n, body })
      const step = plans.get(id)?.[n]; assert(step, `Unexpected provider request ${id} #${n}`)
      const output = typeof step === 'function' ? await step(body, res) : step
      if (output === null || res.destroyed) return
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`)
    } catch (error) { errors.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); port = reserve.address().port; await new Promise(done => reserve.close(done))
  host = await startHost(); firstPid = host.child.pid
  assert.equal((await request('POST', '/api/agents', { agentId: 'team' })).status, 201)
  plans.set('team/main', [])
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage(); const frames = []; const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', event => { try { frames.push(JSON.parse(event.response.payloadData)) } catch {} })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' }); await page.waitForSelector('#dotnet-token')
  await page.type('#dotnet-token', token); await page.click('button[type="submit"]'); await page.waitForSelector('button[aria-label="New session"]')

  // Real original Continue button; no fabricated input and no replay of a completed effect/handoff.
  const sink = await create('sink', [[text('SINK-DONE')]])
  const held = signal(); const stopped = signal(); const stoppedContinue = signal(); holds.push(held)
  const continued = await create('continued', [async (_, res) => { res.on('close', () => stopped.release()); await stopped.promise; return null },
    async (_, res) => { res.on('close', () => stoppedContinue.release()); await stoppedContinue.promise; return null },
    async () => { await held.promise; return [call('once-write', 'write', { filePath: 'once.txt', content: 'one-effect' })] },
    [call('finished-report', 'send_to_session', { sessionId: sink, message: 'REPORT-ONCE', afterSend: 'finish' })]])
  await page.evaluate(id => { location.hash = '#session/' + encodeURIComponent(id) }, continued)
  await send(continued, 'INTERRUPT-ME'); await until(() => counts.get(continued) === 1, 'held provider')
  assert.equal((await command(continued, '/continue')).status, 409)
  assert.equal((await command(continued, '/stop')).status, 200); await stopped.promise; await idle(continued)
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Continue'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Continue').click())
  await until(() => counts.get(continued) === 2, 'original Continue provider'); assert.equal((await command(continued, '/continue')).status, 409)
  assert.equal((await command(continued, '/stop')).status, 200); await stoppedContinue.promise; await idle(continued)
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Continue'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Continue').click())
  await until(() => counts.get(continued) === 3, 'Continue after stopped continuation')
  held.release(); await final(sink, 'SINK-DONE'); await idle(continued)
  assert.equal(counts.get(continued), 4); assert.equal((await command(continued, '/continue')).status, 409)
  assert.equal((await history(continued)).filter(row => row.role === 'user' && row.parts.some(part => part.text === 'INTERRUPT-ME')).length, 1)
  assert.equal(await readFile(join(workRoot, 'agents', 'team', 'once.txt'), 'utf8'), 'one-effect')

  // Handoff wait still survives a sibling error and a child result releases the same parent processor.
  const releaseChild = signal(); holds.push(releaseChild)
  const slow = await create('slow', [[call('birth', 'create_child_session', { suffix: 'slow-child', message: 'DO-WORK', afterSend: 'wait' }), call('sibling-error', 'nonexistent_tool', {})], [text('SLOW-PARENT-DONE')]])
  plans.set('team/slow_slow-child', [async () => { await releaseChild.promise; return [call('slow-report', 'send_to_session', { sessionId: slow, message: 'SLOW-RESULT', afterSend: 'finish' })] }])
  await page.evaluate(id => { location.hash = '#session/' + encodeURIComponent(id) }, slow)
  await send(slow, 'DELEGATE'); await waiting(slow)
  await until(() => frames.some(frame => frame.type === 'session-state' && frame.sessionId === slow && frame.session.runtimeState?.state === 'waiting'), 'real Chat waiting frame')
  assert.equal((await command(slow, '/continue')).status, 409); assert.equal((await command(slow, '/stop')).body.stoppedCurrent, false)
  assert.equal((await authority(slow)).meta.wait.waitAnySessions[0], 'team/slow_slow-child')
  await sleep(650); assert.equal(counts.get(slow), 1, 'Active child suppresses quiescence wake')
  releaseChild.release(); await final(slow, 'SLOW-PARENT-DONE'); assert.equal((await authority(slow)).meta.wait, undefined)

  // An explicit wait loses only its own token when another tool errors, then continues the provider loop.
  const explicit = await create('explicit', [[call('wait-error-batch', 'wait', { waitForInput: true }), call('bad-sibling', 'nonexistent_tool', {})], [text('EXPLICIT-ERROR-HANDLED')]])
  await send(explicit, 'HANDLE-ERROR'); await final(explicit, 'EXPLICIT-ERROR-HANDLED'); assert.equal((await authority(explicit)).meta.wait, undefined)
  const fast = await create('fast', [[call('fast-birth', 'create_child_session', { suffix: 'fast-child', message: 'FAST-WORK', afterSend: 'wait' }), call('slow-sibling', 'exec', { command: 'sleep 1', timeout: 2 })], [text('FAST-PARENT-DONE')]])
  plans.set('team/fast_fast-child', [[call('fast-report', 'send_to_session', { sessionId: fast, message: 'FAST-RESULT', afterSend: 'finish' })]])
  await send(fast, 'FAST-DELEGATE')
  await until(async () => (await authority(fast)).queue.some(item => item.parts?.some(part => part.system?.includes('FAST-RESULT'))), 'actual fast reply queued before handoff wait arm')
  assert(!(await history(fast)).some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'fast-birth')))
  await final(fast, 'FAST-PARENT-DONE')
  assert.equal(counts.get(fast), 2); assert.equal((await authority(fast)).meta.wait, undefined)
  const fastRows = await history(fast)
  assert(fastRows.findIndex(row => row.role === 'tool' && row.parts.some(part => part.functionResponse?.tool_use_id === 'fast-birth')) < fastRows.findIndex(row => row.parts.some(part => part.system?.includes('FAST-RESULT'))))

  // Invalid source-less/current/foreign-exec declarations are paired errors rather than stale waits.
  const invalid = await create('invalid', [[call('bare', 'wait', { reason: 'only reason' }), call('self', 'wait', { waitAnySessions: ['team/invalid'] }), call('foreign', 'wait', { waitExecIds: ['not-an-owned-exec'] })], [text('INVALID-HANDLED')]])
  await send(invalid, 'INVALID'); await final(invalid, 'INVALID-HANDLED')
  const invalidRow = (await history(invalid)).find(row => row.role === 'tool')
  assert(invalidRow.parts.every(part => part.functionResponse.response.error)); assert.equal((await authority(invalid)).meta.wait, undefined)

  const stoppedTool = await create('stopped-tool', [[call('wait-before-stop', 'wait', { wakeIfNoActivityAfterSeconds: 2 }), call('stop-shell', 'exec', { command: 'sleep 1.5', timeout: 3 })], [text('STOPPED-EXEC-EVENT')]])
  await send(stoppedTool, 'STOP-TOOL')
  await until(async () => (await authority(stoppedTool)).meta.wait && (await session(stoppedTool)).runtimeState.state === 'running-tool', 'actual waiting tool batch before Stop')
  assert.equal((await command(stoppedTool, '/stop')).status, 200); await idle(stoppedTool)
  assert.equal((await authority(stoppedTool)).meta.wait, undefined)
  await final(stoppedTool, 'STOPPED-EXEC-EVENT'); await sleep(900); assert.equal(counts.get(stoppedTool), 2)

  // Persisted waitAll barrier, strict failure classification and clean restart use real inter-Session send tools.
  const sourceA = await create('source-a'); const sourceB = await create('source-b')
  const barrier = await create('barrier', [[call('all', 'wait', { waitAllSessions: [sourceA, sourceB], wakeIfNoActivityAfterSeconds: 60 })], [text('ALL-DONE')]])
  await send(barrier, 'ALL'); await waiting(barrier)
  const markerRoot = join(dataRoot, 'state', 'experiment-faults'); await mkdir(markerRoot, { recursive: true })
  const segment = 'id_' + Buffer.from(barrier).toString('base64url')
  await writeFile(join(markerRoot, segment + '.wait-before-rename'), 'fail')
  plans.get(sourceA).push([call('pre-send', 'send_to_session', { sessionId: barrier, message: 'PRE-NOT-ACKED', afterSend: 'finish' })], [text('PRE-ERROR-HANDLED')])
  await send(sourceA, 'PRE'); await final(sourceA, 'PRE-ERROR-HANDLED')
  assert.equal((await authority(barrier)).meta.wait.waitAll.deferredQueue.length, 0)
  await writeFile(join(markerRoot, segment + '.wait-after-rename'), 'fail')
  plans.get(sourceA).push([call('post-send', 'send_to_session', { sessionId: barrier, message: 'FIRST-ACKED-AUTHORITY', afterSend: 'finish' })], [text('POST-ERROR-HANDLED')])
  await send(sourceA, 'POST'); await final(sourceA, 'POST-ERROR-HANDLED'); await waiting(barrier)
  const savedAll = await authority(barrier)
  assert.deepEqual(savedAll.meta.wait.waitAll.satisfiedSessions, [sourceA]); assert.equal(savedAll.meta.wait.waitAll.deferredQueue.length, 1)
  assert.equal(counts.get(barrier), 1); assert(!(await history(barrier)).some(row => row.parts.some(part => part.system?.includes('FIRST-ACKED-AUTHORITY'))))

  const input = await create('input', [[call('input-wait', 'wait', { waitForInput: true })], [text('INPUT-DONE')]])
  await send(input, 'WAIT-INPUT'); await waiting(input)
  const timed = await create('timed', [[call('timed-wait', 'wait', { wakeIfNoActivityAfterSeconds: 3 })], body => { assert(messageText(body).includes('type="wait-timeout"')); return [text('TIMEOUT-DONE')] }])
  await send(timed, 'WAIT-TIME'); await waiting(timed); const timedSaved = await authority(timed)
  await stopHost(); host = await startHost(); secondPid = host.child.pid; assert.notEqual(secondPid, firstPid)
  assert.deepEqual((await authority(barrier)).meta.wait.waitAll, savedAll.meta.wait.waitAll)
  await page.reload({ waitUntil: 'load' }); await waiting(input)
  await deliver(sourceB, barrier, 'SECOND-RESULT'); await final(barrier, 'ALL-DONE')
  assert.equal((await authority(barrier)).meta.wait, undefined)
  const allText = messageText(requests.find(item => item.id === barrier && item.n === 1).body)
  assert(allText.indexOf('FIRST-ACKED-AUTHORITY') < allText.indexOf('SECOND-RESULT')); assert(!allText.includes('PRE-NOT-ACKED'))
  await final(timed, 'TIMEOUT-DONE'); assert.equal(counts.get(timed), 2)
  assert(timedSaved.meta.wait.startedAt + timedSaved.meta.wait.timeoutSeconds * 1000 <= Date.now())
  await send(input, 'NEW-INPUT'); await final(input, 'INPUT-DONE')

  // Explicit wait creation failures retain truthfully committed state and clear only their own token after pairing.
  for (const stage of ['before', 'after']) {
    const faulted = await create(`faulted-${stage}`, [[call(`wait-${stage}`, 'wait', { waitForInput: true })], [text(`WAIT-${stage}-ERROR-HANDLED`)]])
    await writeFile(join(markerRoot, 'id_' + Buffer.from(faulted).toString('base64url') + `.wait-${stage}-rename`), 'fail')
    await send(faulted, 'FAULTED-WAIT'); await final(faulted, `WAIT-${stage}-ERROR-HANDLED`)
    const faultRow = (await history(faulted)).find(row => row.role === 'tool')
    assert(faultRow.parts[0].functionResponse.response.error)
    assert.equal((await authority(faulted)).meta.wait, undefined)
  }

  // Nonlisted input releases the all barrier with deferred content and the actual pending-source reminder.
  const unrelated = await create('unrelated', [[call('unrelated-all', 'wait', { waitAllSessions: [sourceA, sourceB], wakeIfNoActivityAfterSeconds: 60 })], body => {
    const content = messageText(body); assert(content.includes('PARTIAL-REPORT')); assert(content.includes('USER-OVERRIDE')); assert(content.includes('wait-all-pending')); return [text('UNRELATED-DONE')]
  }])
  await send(unrelated, 'WAIT-ALL'); await waiting(unrelated); await deliver(sourceA, unrelated, 'PARTIAL-REPORT'); await waiting(unrelated)
  await send(unrelated, 'USER-OVERRIDE'); await final(unrelated, 'UNRELATED-DONE')

  // Own actual background exec completion wakes; its old one-shot fallback must not run again.
  const execWait = await create('exec-wait', [[call('bg', 'exec', { command: 'sleep 2; printf EXEC-FINISHED', timeout: 1 })], body => {
    const output = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'bg')?.output
    const execId = /execId: ([^\s]+)/.exec(output)?.[1]; assert(execId, output)
    return [call('exec-wait-call', 'wait', { waitExecIds: [execId], wakeIfNoActivityAfterSeconds: 3 })]
  }, body => { assert(messageText(body).includes('background-process-finished')); return [text('EXEC-WAKE-DONE')] }])
  await send(execWait, 'BACKGROUND'); await waiting(execWait); await final(execWait, 'EXEC-WAKE-DONE')
  await sleep(1800); assert.equal(counts.get(execWait), 3); assert.equal((await authority(execWait)).meta.wait, undefined)

  // Any Session declaration remains advisory: a different real source wakes it, then stale timeout stays quiet.
  const any = await create('any', [[call('any-wait', 'wait', { waitAnySessions: [sourceA], wakeIfNoActivityAfterSeconds: 1 })], [call('any-input-next', 'wait', { waitForInput: true })], [text('ANY-DONE')]])
  await send(any, 'ANY'); await waiting(any); await deliver(sourceB, any, 'OTHER-SOURCE'); await waiting(any)
  await until(async () => (await authority(any)).meta.wait.waitForInput === true, 'new wait token')
  await sleep(1150); assert.equal(counts.get(any), 2)
  await send(any, 'INPUT-AFTER-OLD-DEADLINE'); await final(any, 'ANY-DONE')

  // Source-only graph diagnostic is bounded/deduplicated, while input-backed transitive progress suppresses it.
  const backed = await create('backed', [[call('backed-input', 'wait', { waitForInput: true })]])
  await send(backed, 'BACKED'); await waiting(backed)
  const graph = await create('graph', [[call('graph-wait', 'wait', { waitAnySessions: [backed] })], [text('GRAPH-DONE')]])
  await send(graph, 'GRAPH'); await waiting(graph); await sleep(650); assert.equal(counts.get(graph), 1)
  await deliver(sourceB, graph, 'GRAPH-REPLY'); await final(graph, 'GRAPH-DONE')
  const quiescent = await create('quiescent', [[call('q-wait', 'wait', { waitAnySessions: [sourceA] })], body => {
    assert(messageText(body).includes('wait-sources-quiescent')); return [call('q-wait-again', 'wait', { waitAnySessions: [sourceA] })]
  }])
  await send(quiescent, 'QUIESCENT'); await until(() => counts.get(quiescent) === 2, 'quiescence diagnostic'); await waiting(quiescent)
  await sleep(700); assert.equal(counts.get(quiescent), 2)
  assert.equal((await authority(quiescent)).meta.waitLivenessFingerprints.length, 1)

  // A real two-Session cycle has no progress path; at least one bounded diagnostic breaks the silent wait.
  const releaseCycle = signal(); holds.push(releaseCycle)
  const cycleA = await create('cycle-a'); const cycleB = await create('cycle-b')
  const afterCycle = body => messageText(body).includes('FORCE-CYCLE') ? [text('CYCLE-FINAL')] :
    (assert(messageText(body).includes('wait-sources-quiescent')), [call('cycle-input', 'wait', { waitForInput: true })])
  plans.get(cycleA).push([call('cycle-a-wait', 'wait', { waitAnySessions: [cycleB] })], afterCycle, afterCycle)
  plans.get(cycleB).push(async () => { await releaseCycle.promise; return [call('cycle-b-wait', 'wait', { waitAnySessions: [cycleA] })] }, afterCycle, afterCycle)
  await send(cycleB, 'CYCLE-B'); await until(() => counts.get(cycleB) === 1, 'active cycle source')
  await send(cycleA, 'CYCLE-A'); await waiting(cycleA); releaseCycle.release(); await waiting(cycleB)
  await until(() => (counts.get(cycleA) || 0) + (counts.get(cycleB) || 0) > 2, 'cycle diagnostic')
  await waiting(cycleA); await waiting(cycleB); await sleep(400)
  assert((counts.get(cycleA) || 0) + (counts.get(cycleB) || 0) <= 4)
  await send(cycleA, 'FORCE-CYCLE-A'); await send(cycleB, 'FORCE-CYCLE-B')
  await final(cycleA, 'CYCLE-FINAL'); await final(cycleB, 'CYCLE-FINAL')

  const beforeFinalRestart = requests.length; await stopHost(); host = await startHost()
  await sleep(700); assert.equal(requests.length, beforeFinalRestart)
  assert.equal((await session(quiescent)).runtimeState.state, 'waiting')
  assert(frames.some(frame => frame.type === 'session-state' && frame.sessionId === slow && frame.session.runtimeState?.state === 'waiting'))
  const archive = JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("select session_id,count(*) from archive_messages group by session_id").fetchall()))', join(dataRoot, 'state', 'archive-store.sqlite')], { encoding: 'utf8' }))
  for (const [id, count] of archive) assert.equal((await history(id)).length, count, id)
  assert.equal(errors.length, 0, errors.join('\n')); await stopHost()
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid, thirdPid: host.child.pid, requests: requests.length,
    originalContinue: true, noEffectReplay: true, slowAndFastHandoff: true, explicitSiblingError: true,
    strictWaitAllBeforeAfterRename: true, deferredRestart: true, timedRestart: true, actualExecWake: true,
    unrelatedWake: true, staleTimerQuiet: true, quiescenceDedupRestart: true, archiveRows: archive.reduce((sum, row) => sum + row[1], 0) }))
} finally {
  for (const hold of holds) hold.release()
  await browser?.close().catch(() => {})
  if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(5000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  await rm(root, { recursive: true, force: true })
}
