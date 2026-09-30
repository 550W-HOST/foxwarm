#!/usr/bin/env node
// One original-App/local Responses workflow: Session observation and canonical interval goals.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-observation-e2e-'))
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
let host, browser, provider, port, firstPid, secondPid, plannerTarget, plannerCount = 0
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
      assert.equal(body.tools.length, 21); assert(body.tools.some(tool => tool.name === 'get_session_messages'))
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
  host = await startHost(); firstPid = host.child.pid
  assert.equal((await request('POST', '/api/agents', { agentId: 'team' })).status, 201)
  plans.set('team/main', [])
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage(); const frames = []; const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', event => { try { frames.push(JSON.parse(event.response.payloadData)) } catch {} })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' }); await page.waitForSelector('#dotnet-token')
  await page.type('#dotnet-token', token); await page.click('button[type="submit"]'); await page.waitForSelector('button[aria-label="New session"]')

  const value = (rows, id) => rows.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
  const goalRows = rows => rows.filter(row => row.__meta?.goalReminder)
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
    call('current-status', 'session', { sessionId: target }), call('current-list', 'session', { action: 'list', count: 1 }),
    call('all-list', 'session', { action: 'list', scope: 'all', count: 1 }),
    call('rename', 'session', { action: 'update-display-name', sessionId: target, name: '  Observed name  ' }),
    call('rename-noop', 'session', { action: 'update-display-name', sessionId: target, name: 'Observed name' })])
  const observed = await history(actor)
  assert(value(observed, 'live-page').output.includes('requesting-model') && value(observed, 'live-page').output.includes('No messages found'))
  assert(value(observed, 'live-filter').output.includes('requesting-model') && value(observed, 'live-filter').output.includes('No messages matched'))
  assert(value(observed, 'current-status').output.includes('session id: `' + actor + '`'))
  assert(value(observed, 'current-status').output.includes('local workspace') && value(observed, 'current-status').output.includes('token estimate'))
  assert(!value(observed, 'current-list').output.includes('other/main')); assert(value(observed, 'all-list').output.includes('Found 4 session(s)'))
  assert(value(observed, 'rename').output.includes('changed from unset to "Observed name"')); assert(value(observed, 'rename-noop').output.includes('unchanged'))
  await page.evaluate(id => { location.hash = '#session=' + encodeURIComponent(id) }, target)
  await page.waitForFunction(() => document.body.innerText.includes('Observed name'))
  held.release(); await final(target, 'HELD-DONE')

  // Real canonical history and tool effect: full hidden content is searchable, display remains folded.
  await writeFile(join(workRoot, 'agents', 'team', 'needle.txt'), 'EARLY-RESOURCE ' + '🦊'.repeat(1300) + ' HIDDEN_TOOL_NEEDLE ' + 'tail '.repeat(300))
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

  // Waiting with no synthetic goal work, then an actual tool-active peer observed during an exec foreground await.
  await turn(target, 'MAKE-GOAL', [call('set-goal-target', 'set_goal', { goal: 'Keep target work coherent', remindEvery: 1 })])
  plans.get(target).push([call('wait-target', 'wait', { waitForInput: true })]); await send(target, 'DECLARE-WAIT'); await waiting(target)
  const beforeQuiet = requests.length; await sleep(500); assert.equal(requests.length, beforeQuiet)
  await turn(actor, 'WAIT-OBSERVE', [call('waiting-page', 'get_session_messages', { sessionId: target, count: 0 }), call('clear-name', 'session', { action: 'update-display-name', sessionId: target, name: '' })])
  assert(value(await history(actor), 'waiting-page').output.includes('waiting (input)')); assert(value(await history(actor), 'clear-name').output.includes('to unset'))
  const execTarget = await create('executing', [[call('held-exec', 'exec', { command: 'sleep 1.5; printf EXEC-DONE', timeout: 5 })], [text('EXEC-FINISHED')]])
  await send(execTarget, 'RUN-EXEC'); await until(async () => (await session(execTarget)).runtimeState.state === 'running-tool', 'actual tool active')
  await turn(actor, 'TOOL-OBSERVE', [call('tool-active-page', 'get_session_messages', { sessionId: execTarget, count: 0 })])
  assert(value(await history(actor), 'tool-active-page').output.includes('running-tool')); await final(execTarget, 'EXEC-FINISHED')

  // Interval goal is canonical context after a paired row, never a standalone wake or inherited child goal.
  const goal = await create('goal')
  await turn(goal, 'GOAL-SET', [call('set-goal', 'set_goal', { goal: '  Complete the long feature  ', remindEvery: 1 }), call('effect-once', 'write', { filePath: 'goal-effect.txt', content: 'ONE' })], body => {
    const input = body.input; const reply = input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'effect-once')
    const reminder = input.findIndex(item => item.type === 'message' && item.content?.some(part => part.text?.includes('kind="goal-reminder"')))
    assert(reply >= 0 && reminder > reply); return [text('PAIRED-GOAL-OBSERVED')]
  })
  let goalHistory = await history(goal); const reminder = goalRows(goalHistory)[0]
  assert(reminder && reminder.__meta.goalReminderKind === 'interval')
  assert.equal((await authority(goal)).goalState.anchorSeq, reminder.__meta.goalAnchorSeq)
  assert.equal((await authority(goal)).historyVersion, 0)
  const firstAnchor = reminder.__meta.goalAnchorSeq; const firstReminders = goalRows(goalHistory).length
  const noMore = requests.length; await sleep(300); assert.equal(requests.length, noMore)
  await turn(goal, 'GOAL-NO-ACTION', [text('[NO_ACTION]')]); await sleep(300)
  assert.equal(goalRows(await history(goal)).filter(row => row.__meta.goalAnchorSeq === firstAnchor).length, 1)
  const doneRequests = requests.length; await sleep(300); assert.equal(requests.length, doneRequests)
  plans.set('team/goal_goal-kid', [body => { assert(!JSON.stringify(body.input).includes('Complete the long feature')); return [text('CHILD-NO-GOAL')] }])
  plans.get(goal).push([call('fresh-goal-child', 'create_child_session', { suffix: 'goal-kid', message: 'CHILD-WORK', afterSend: 'finish' })])
  await send(goal, 'CHILD'); await final('team/goal_goal-kid', 'CHILD-NO-GOAL'); await idle(goal); assert.equal((await authority('team/goal_goal-kid')).goalState, undefined)
  await turn(goal, 'GOAL-UPDATE', [call('update-goal', 'set_goal', { goal: 'Carry goal through real compaction', remindEvery: 99 })])
  assert.equal((await authority(goal)).goalState.remindEvery, 99)
  for (let i = 0; i < 12; i++) await turn(goal, 'COMPACT-SEED-' + i + ' ' + ('context-' + i + '-').repeat(600))
  plannerTarget = goal; const versionBefore = (await authority(goal)).historyVersion
  assert.equal((await command(goal, '/compact')).status, 202)
  await until(async () => (await authority(goal)).historyVersion === versionBefore + 1, 'actual compact rewrite'); await idle(goal)
  let compacted = await history(goal); let completion = compacted.findLast(row => row.parts.some(part => part.system?.includes('event="compact-completed"')))
  assert.equal(completion.parts.filter(part => part.system).length, 2)
  assert(completion.parts[1].system.includes('Carry goal through real compaction')); assert.equal(completion.__meta.goalReminderKind, 'compact-completion')
  assert.equal((await authority(goal)).goalState.anchorSeq, completion.__meta.seq); assert.equal(completion.__meta.goalAnchorSeq, completion.__meta.seq)
  // Build enough later raw context to make a second actual rewrite remove the older completion from its retained tail.
  for (let i = 0; i < 7; i++) await turn(goal, 'COMPACT-SECOND-' + i + ' ' + ('later-' + i + '-').repeat(600))
  assert.equal((await command(goal, '/compact')).status, 202)
  await until(async () => (await authority(goal)).historyVersion === versionBefore + 2, 'second actual compact rewrite'); await idle(goal)
  compacted = await history(goal); assert.equal(compacted.filter(row => row.parts.some(part => part.system?.includes('event="compact-completed"'))).length, 1)
  completion = compacted.findLast(row => row.__meta.goalReminderKind === 'compact-completion')
  assert.equal((await authority(goal)).goalState.anchorSeq, completion.__meta.seq)

  // Narrow before/after-rename goal setting failure and real interval append failure/Continue dedup.
  const faults = join(dataRoot, 'state', 'experiment-faults'); await mkdir(faults, { recursive: true })
  const fault = async (id, when) => writeFile(join(faults, 'id_' + Buffer.from(id).toString('base64url') + '.goal-' + when + '-rename'), 'fail')
  const faulty = await create('faulty')
  await fault(faulty, 'before'); await turn(faulty, 'BEFORE-GOAL', [call('before-goal', 'set_goal', { goal: 'PRE-MUST-NOT-PUBLISH', remindEvery: 99 })])
  assert(value(await history(faulty), 'before-goal').error); assert.equal((await authority(faulty)).goalState, undefined)
  await fault(faulty, 'after'); await turn(faulty, 'AFTER-GOAL', [call('after-goal', 'set_goal', { goal: 'POST-MUST-REMAIN', remindEvery: 99 })])
  assert(value(await history(faulty), 'after-goal').error); assert.equal((await authority(faulty)).goalState.goal, 'POST-MUST-REMAIN')
  await turn(faulty, 'SET-SLOW', [call('slow-goal', 'set_goal', { goal: 'Interval strict boundary', remindEvery: 2 })])
  const savedBefore = await authority(faulty); const beforeProvider = counts.get(faulty)
  await fault(faulty, 'before'); await send(faulty, 'DUE-PRE-RENAME')
  await until(async () => (await request('GET', `${path(faulty)}/state`)).body.session.failureCount > 0, 'pre reminder failure'); await idle(faulty)
  assert.equal(counts.get(faulty), beforeProvider); assert.equal((await authority(faulty)).goalState.anchorSeq, savedBefore.goalState.anchorSeq)
  plans.get(faulty).push([text('CONTINUE-PRE-RECOVERED')]); assert.equal((await command(faulty, '/continue')).status, 200); await final(faulty, 'CONTINUE-PRE-RECOVERED')
  await fault(faulty, 'after'); const beforeAfter = counts.get(faulty); const priorFailures = (await request('GET', `${path(faulty)}/state`)).body.session.failureCount
  await send(faulty, 'DUE-POST-RENAME'); await until(async () => (await request('GET', `${path(faulty)}/state`)).body.session.failureCount > priorFailures, 'post reminder failure'); await idle(faulty)
  assert.equal(counts.get(faulty), beforeAfter); const committedReminder = goalRows(await history(faulty)).at(-1)
  assert.equal((await authority(faulty)).goalState.anchorSeq, committedReminder.__meta.goalAnchorSeq)
  plans.get(faulty).push([text('CONTINUE-POST-RECOVERED')]); assert.equal((await command(faulty, '/continue')).status, 200); await final(faulty, 'CONTINUE-POST-RECOVERED')
  assert.equal(goalRows(await history(faulty)).filter(row => row.__meta.goalAnchorSeq === committedReminder.__meta.goalAnchorSeq).length, 1)
  assert.equal(await readFile(join(workRoot, 'agents', 'team', 'goal-effect.txt'), 'utf8'), 'ONE')
  const goalBeforeRestart = (await authority(goal)).goalState; const rowsBeforeRestart = goalRows(await history(goal)).length
  await stopHost(); host = await startHost(); secondPid = host.child.pid; assert.notEqual(firstPid, secondPid)
  assert.deepEqual((await authority(goal)).goalState, goalBeforeRestart)
  await turn(goal, 'AFTER-RESTART', body => { assert(JSON.stringify(body.input).includes('Carry goal through real compaction')); return [text('GOAL-RESTORED')] })
  assert.equal(goalRows(await history(goal)).length, rowsBeforeRestart)
  await turn(goal, 'GOAL-KEEP-INTERVAL', [call('keep-interval', 'set_goal', { goal: 'Updated with omitted interval' })]); assert.equal((await authority(goal)).goalState.remindEvery, 99)
  await turn(goal, 'GOAL-CLEAR', [call('clear-goal', 'set_goal', { clear: true })]); assert.equal((await authority(goal)).goalState, undefined)
  await turn(goal, 'GOAL-EMPTY', [call('empty-goal', 'set_goal', { goal: '' })]); assert.equal((await authority(goal)).goalState, undefined)
  assert.equal(errors.length, 0, errors.join('\n'))
  const archiveCount = Number(execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select count(*) from archive_messages").fetchone()[0])', join(dataRoot, 'state', 'archive-store.sqlite')], { encoding: 'utf8' }))
  await stopHost(); console.log(JSON.stringify({ result: 'ok', requests: requests.length, firstPid, secondPid, originalNameUI: true,
    canonicalLiveRuntime: true, selectedPageFilters: true, foldedToolSearch: true, totalUnicodeBudget: true, pairedGoal: true,
    intervalNoSyntheticWake: true, childNoGoal: true, realCompactGoal: true, prePostRename: true, cleanRestore: true, archiveCount }))
} finally {
  for (const hold of holds) hold.release()
  await browser?.close().catch(() => {})
  if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(5000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  await rm(root, { recursive: true, force: true })
}
