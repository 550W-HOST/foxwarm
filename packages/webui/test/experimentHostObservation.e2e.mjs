#!/usr/bin/env node
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
// One original-App/local Responses workflow: Session observation, compaction and retained history.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-observation-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(dataRoot, 'agents', 'main')
const token = 'synthetic-wait-api-token'; const providerToken = 'synthetic-wait-provider-token'
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const plans = new Map(); const requests = []; const errors = []; const counts = new Map(); const holds = []
const sleep = ms => new Promise(done => setTimeout(done, ms))
const signal = () => { let release; const promise = new Promise(done => { release = done }); return { promise, release } }
const text = value => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const messageText = body => body.input.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join('\n')
let host, browser, provider, port, firstPid, secondPid, plannerTarget, plannerCount = 0
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (errors.length) throw new Error(errors.join('\n')); const result = await fn(); if (result) return result; await sleep(25) }
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
async function history(id) { const result = await request('GET', `${path(id)}/history`); if (result.status === 404) return []; assert.equal(result.status, 200); return result.body.messages }
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
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...testEnvironment.isolatedApplicationEnv(dataRoot),
      FOXWARM_EXPERIMENT_API_TOKEN: token,
      FOXWARM_EXPERIMENT_RESPONSES_BASE_URI: `http://127.0.0.1:${provider.address().port}`,
      FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken, FOXWARM_EXPERIMENT_REQUEST_MODEL: 'wire',
      FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'local/wire', } })
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
  await mkdir(dataRoot); await mkdir(workRoot, { recursive: true })
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.headers.authorization, `Bearer ${providerToken}`); assert.equal(req.url, '/responses')
      assert(body.tools.some(tool => tool.name === 'get_session_messages'))
      const compact = body.input.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').findLast(item => item.includes('COMPACTION STARTED:'))
      if (compact) {
        assert(plannerTarget)
        const ranges = [...compact.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => ({ start: Number(match[1]), end: Number(match[2] || match[1]) }))
        assert(ranges.length > 1, compact.slice(0, 2000)); requests.push({ id: plannerTarget, planner: true })
        const output = [call('plan-' + (++plannerCount), 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0].start, sourceEnd: ranges.at(-1).end, summary: 'The older source messages were compacted. Preserve the current long-running goal and follow the current context.' }] })]
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`)
        return
      }
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
  await mkdir(join(dataRoot, 'state'), { recursive: true })
  await writeFile(join(dataRoot, 'state/config.yaml'), `bot: {httpPort: ${port}}\n`)
  await writeFile(join(dataRoot, 'state/token'), token, { mode: 0o600 })
  host = await startHost(); firstPid = host.child.pid
  assert.equal((await request('POST', '/api/agents', { agentId: 'team' })).status, 201)
  plans.set('team/main', [])
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage(); const frames = []; const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', event => { try { frames.push(JSON.parse(event.response.payloadData)) } catch {} })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' }); await page.waitForSelector('#token')
  await page.type('#token', token); await page.click('button[type="submit"]'); await page.waitForSelector('button[aria-label="New session"]'); await waitForWebUiReady(page)

  const value = (rows, id) => rows.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
  async function turn(id, label, ...steps) {
    const script = plans.get(id); const start = script.length
    script.push(...steps.map((step, index) => async (body, res) => {
      const output = typeof step === 'function' ? await step(body, res) : step
      if (!output.some(item => item.type === 'function_call')) { script.splice(start + index + 1, steps.length - index); return [...output, text(label + '-DONE')] }
      return output
    }), [text(label + '-DONE')])
    await send(id, label); await final(id, label + '-DONE')
  }
  const actor = await create('observer')
  const target = await create('target')
  assert.equal((await request('POST', '/api/agents', { agentId: 'other' })).status, 201); plans.set('other/main', [])
  const held = signal(); holds.push(held)
  plans.get(target).push(async () => { await held.promise; return [text('HELD-DONE')] })
  await send(target, 'HELD-REQUEST'); await until(() => counts.get(target) === 1, 'actual held model')
  await turn(actor, 'LIVE-OBSERVE', [call('live-page', 'get_session_messages', { sessionId: target, count: 0 }),
    call('live-filter', 'get_session_messages', { sessionId: target, start: 0, count: 1, contentFilter: 'ABSENT' }),
    call('target-status', 'session', { sessionId: target }), call('current-status', 'session', {}), call('current-list', 'session', { action: 'list', count: 1 }),
    call('all-list', 'session', { action: 'list', scope: 'all', count: 1 }),
    call('rename', 'session', { action: 'update-display-name', sessionId: target, name: '  Observed name  ' }),
    call('rename-noop', 'session', { action: 'update-display-name', sessionId: target, name: 'Observed name' })])
  const observed = await history(actor)
  assert(value(observed, 'live-page').output.includes('requesting-model') && value(observed, 'live-page').output.includes('No messages found'))
  assert(value(observed, 'live-filter').output.includes('requesting-model') && value(observed, 'live-filter').output.includes('No messages matched'))
  assert(value(observed, 'current-status').output.includes('session id: `' + actor + '`'))
  assert(value(observed, 'target-status').output.includes('session id: `' + target + '`'))
  assert(value(observed, 'target-status').output.includes('requesting-model'))
  assert(value(observed, 'current-status').output.includes(join(dataRoot, 'agents', 'team')) && value(observed, 'current-status').output.includes('token estimate'))
  assert(!value(observed, 'current-list').output.includes('other/main')); assert(value(observed, 'all-list').output.includes('Found 4 session(s)'))
  assert(value(observed, 'rename').output.includes('changed from unset to "Observed name"')); assert(value(observed, 'rename-noop').output.includes('unchanged'))
  await page.evaluate(id => { location.hash = '#session=' + encodeURIComponent(id) }, target)
  await page.waitForFunction(() => document.body.innerText.includes('Observed name'))
  held.release(); await final(target, 'HELD-DONE')

  // Real canonical history and tool effect: full hidden content is searchable, display remains folded.
  await writeFile(join(dataRoot, 'agents', 'team', 'needle.txt'), 'EARLY-RESOURCE ' + '🦊'.repeat(1300) + ' HIDDEN_TOOL_NEEDLE ' + 'tail '.repeat(300))
  await turn(target, 'READ-SEED', [call('read-needle', 'read', { filePath: 'needle.txt' })])
  for (let i = 0; i < 7; i++) await turn(target, 'FOLLOW-' + i)
  const selected = await history(target); const toolIndex = selected.findIndex(row => row.parts.some(part => part.functionResponse?.tool_use_id === 'read-needle'))
  assert(toolIndex > 0 && selected.length > 10)
  await turn(actor, 'PAGES', [
    call('default-tail', 'get_session_messages', { sessionId: target }),
    call('negative-tail', 'get_session_messages', { sessionId: target, start: -2 }),
    call('start-only', 'get_session_messages', { sessionId: target, start: selected.length - 2 }),
    call('count-only', 'get_session_messages', { sessionId: target, count: 1 }),
    call('page-filter', 'get_session_messages', { sessionId: target, start: -2, contentFilter: 'EARLY-RESOURCE' }),
    call('tool-fold', 'get_session_messages', { sessionId: target, start: toolIndex, count: 1, contentFilter: 'hidden_tool_needle' }),
    call('tool-snippet', 'get_session_messages', { sessionId: target, start: toolIndex, count: 1, contentFilter: 'HIDDEN_TOOL_NEEDLE', toolDetail: 'snippets', previewLength: 1000 }),
    call('tool-full', 'get_session_messages', { sessionId: target, start: toolIndex, count: 1, toolDetail: 'full', previewLength: 1000 }),
    call('regex-page', 'get_session_messages', { sessionId: target, start: 0, count: selected.length, includeRegex: 'follow-[56]', excludeRegex: 'follow-5', previewLength: 1000 }),
    call('out-of-range', 'get_session_messages', { sessionId: target, start: 10000 }),
    call('bad-regex', 'get_session_messages', { sessionId: target, includeRegex: '[' })])
  const pages = await history(actor)
  assert(!value(pages, 'default-tail').output.includes('EARLY-RESOURCE'))
  assert(value(pages, 'negative-tail').output.includes('FOLLOW-6')); assert.equal(value(pages, 'negative-tail').output, value(pages, 'start-only').output)
  assert(value(pages, 'count-only').output.includes('HELD-REQUEST')); assert(!value(pages, 'count-only').output.includes('HELD-DONE'))
  assert(value(pages, 'page-filter').output.includes('No messages matched'))
  assert(value(pages, 'tool-fold').output.includes('content omitted') && value(pages, 'tool-fold').output.includes('Matched in omitted tool'))
  assert(!value(pages, 'tool-fold').output.includes('HIDDEN_TOOL_NEEDLE'))
  assert(value(pages, 'tool-snippet').output.includes('HIDDEN_TOOL_NEEDLE'))
  for (const id of ['tool-snippet', 'tool-full', 'regex-page']) {
    const output = value(pages, id).output; assert(output.length <= 1000, id); assert(output.includes('Session execution state:'), id)
    assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(output), id + ' Unicode')
  }
  assert(value(pages, 'regex-page').output.includes('FOLLOW-6') && !value(pages, 'regex-page').output.includes('FOLLOW-5'))
  assert(value(pages, 'out-of-range').output.includes('idle') && value(pages, 'out-of-range').output.includes('No messages found'))
  assert(value(pages, 'bad-regex').error)

  // Waiting remains quiet; observe a real tool-active peer during an exec foreground await.
  plans.get(target).push([call('wait-target', 'wait', { waitForInput: true })]); await send(target, 'DECLARE-WAIT'); await waiting(target)
  const beforeQuiet = requests.length; await sleep(500); assert.equal(requests.length, beforeQuiet)
  await turn(actor, 'WAIT-OBSERVE', [call('waiting-page', 'get_session_messages', { sessionId: target, count: 0 }), call('clear-name', 'session', { action: 'update-display-name', sessionId: target, name: '' })])
  assert(value(await history(actor), 'waiting-page').output.includes('waiting (input)')); assert(value(await history(actor), 'clear-name').output.includes('to unset'))
  const execTarget = await create('executing', [[call('held-exec', 'exec', { command: 'sleep 1.5; printf EXEC-DONE', timeout: 5 })], [text('EXEC-FINISHED')]])
  await send(execTarget, 'RUN-EXEC'); await until(async () => (await session(execTarget)).runtimeState.state === 'running-tool', 'actual tool active')
  await turn(actor, 'TOOL-OBSERVE', [call('tool-active-page', 'get_session_messages', { sessionId: execTarget, count: 0 })])
  assert(value(await history(actor), 'tool-active-page').output.includes('running-tool')); await final(execTarget, 'EXEC-FINISHED')

  // Real active-history rewrites preserve Archive-backed observations and restart without model work.
  for (let i = 0; i < 12; i++) await turn(target, 'COMPACT-SEED-' + i + ' ' + ('context-' + i + '-').repeat(600))
  plannerTarget = target
  const versionBefore = (await authority(target)).historyVersion
  assert.equal((await command(target, '/compact')).status, 200)
  await until(async () => (await authority(target)).historyVersion === versionBefore + 1, 'actual compact rewrite'); await idle(target)
  let compacted = await history(target)
  assert(compacted.some(row => row.__meta?.contextBlock))
  assert.equal(compacted.filter(row => row.parts.some(part => part.system?.includes('event="compact-completed"'))).length, 1)
  for (let i = 0; i < 7; i++) await turn(target, 'COMPACT-SECOND-' + i + ' ' + ('later-' + i + '-').repeat(600))
  assert.equal((await command(target, '/compact')).status, 200)
  await until(async () => (await authority(target)).historyVersion === versionBefore + 2, 'second actual compact rewrite'); await idle(target)
  compacted = await history(target)
  assert.equal(compacted.filter(row => row.parts.some(part => part.system?.includes('event="compact-completed"'))).length, 1)
  const requestsBeforeRestart = requests.length
  await stopHost(); host = await startHost(); secondPid = host.child.pid; assert.notEqual(firstPid, secondPid)
  assert.deepEqual(await history(target), compacted)
  assert.equal(requests.length, requestsBeforeRestart, 'cold restart does not start an idle observation target')
  await turn(actor, 'OBSERVE-RESTORED', [call('restored-page', 'get_session_messages', { sessionId: target, count: 0 })])
  assert(value(await history(actor), 'restored-page').output.includes('idle'))
  assert.equal(errors.length, 0, errors.join('\n'))
  const archiveCount = Number(execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select count(*) from archive_messages").fetchone()[0])', join(dataRoot, 'state', 'archive-store.sqlite')], { encoding: 'utf8' }))
  await stopHost(); console.log(JSON.stringify({ result: 'ok', requests: requests.length, firstPid, secondPid, originalNameUI: true,
    canonicalLiveRuntime: true, selectedPageFilters: true, foldedToolSearch: true, totalUnicodeBudget: true,
    quietWaiting: true, realCompaction: true, cleanRestore: true, archiveCount }))
} finally {
  for (const hold of holds) hold.release()
  await browser?.close().catch(() => {})
  if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(5000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  await rm(root, { recursive: true, force: true })
}
