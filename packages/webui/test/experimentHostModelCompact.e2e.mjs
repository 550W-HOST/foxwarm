#!/usr/bin/env node
// Concentrated localhost browser+HTTP+SQLite acceptance for the bounded .NET Chat host.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import puppeteer from 'puppeteer-core'
import { startScriptedProvider } from './experimentHostModelCompact.provider.mjs'

const token = 'local-multimodel-test-api-token'
const alphaToken = 'local-alpha-provider-secret'
const betaToken = 'local-beta-provider-secret'
const dll = process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve(import.meta.dirname, '../../../dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK.')
const dist = resolve('packages/webui/dist')
const root = await mkdtemp(join(tmpdir(), 'foxwarm-model-compact-browser-'))
let provider, browser, host
const errors = []
function sleep(ms) { return new Promise(done => setTimeout(done, ms)) }
async function until(check, label, ms = 22000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(35)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function port() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const chosen = socket.address().port
  await new Promise(done => socket.close(done))
  return chosen
}
async function json(hostPort, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
async function hostStart(hostPort, dataRoot, toolRoot, modelsFile) {
  const child = spawn(dotnet, [dll], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot, FOXWARM_EXPERIMENT_TOOL_ROOT: toolRoot,
    FOXWARM_EXPERIMENT_PORT: String(hostPort), FOXWARM_EXPERIMENT_API_TOKEN: token,
    FOXWARM_EXPERIMENT_MODELS_FILE: modelsFile, FOXWARM_ALPHA_PROVIDER_KEY: alphaToken,
    FOXWARM_BETA_PROVIDER_KEY: betaToken, FOXWARM_EXPERIMENT_WEBUI_DIST: dist,
    FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS: '8192',
  } })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000) })
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Host exited: ${output}`)
    try { return (await json(hostPort, 'GET', '/health')).status === 200 } catch { return false }
  }, 'host ready')
  return { child, get output() { return output } }
}
async function hostStop(hostPort, current) {
  assert.equal((await json(hostPort, 'POST', '/admin/shutdown')).status, 202)
  const status = current.child.exitCode !== null ? current.child.exitCode : await Promise.race([
    once(current.child, 'exit').then(([code]) => code), sleep(18000).then(() => 'timeout'),
  ])
  assert.equal(status, 0, `Host did not stop cleanly: ${current.output}`)
}
async function history(hostPort, id) {
  const result = await json(hostPort, 'GET', `/api/sessions/${id}/history`)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body
}
async function state(hostPort, id) {
  const result = await json(hostPort, 'GET', `/api/sessions/${id}/state`)
  assert.equal(result.status, 200)
  return result.body.session
}
async function send(hostPort, id, message) {
  const result = await json(hostPort, 'POST', `/api/sessions/${id}/message`, { text: message })
  assert.equal(result.status, 202, JSON.stringify(result.body))
}
async function command(hostPort, id, message) {
  return json(hostPort, 'POST', `/api/sessions/${id}/message`, { text: message })
}
async function create(hostPort) {
  const result = await json(hostPort, 'POST', '/api/sessions', {})
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.sessionId
}
async function visit(page, hostPort, id) {
  await page.goto(`http://127.0.0.1:${hostPort}/?sessionId=${id}`, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-root', { timeout: 15000 })
}

try {
  const dataRoot = join(root, 'data'); const toolRoot = join(root, 'workspace')
  await mkdir(dataRoot); await mkdir(toolRoot)
  const middleMarker = 'SENTINEL_MIDDLE_UNREWRITTEN_ARCHIVE'
  await writeFile(join(toolRoot, 'long.txt'), 'BEGIN:' + 'a'.repeat(19800) + middleMarker + 'b'.repeat(19800) + ':END', 'utf8')
  await writeFile(join(toolRoot, 'toolpair.txt'), 'PAIRED_TOOL_CONTENT', 'utf8')
  provider = await startScriptedProvider({ alphaToken, betaToken })
  const modelsFile = join(root, 'models.json')
  await writeFile(modelsFile, JSON.stringify({ default: 'alpha', providers: {
    alpha: { providerType: 'openai', baseUrl: `http://127.0.0.1:${provider.port}`, apiKeyEnv: 'FOXWARM_ALPHA_PROVIDER_KEY',
      contextLimit: 18000, effort: { allowed: ['none', 'low', 'high'], default: 'low' }, models: [{ id: 'alpha-wire' }] },
    beta: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.port}`, apiKeyEnv: 'FOXWARM_BETA_PROVIDER_KEY',
      contextLimit: 18000, effort: { allowed: ['none', 'low', 'high'], default: 'none' }, models: [{ id: 'beta-wire' }] },
  } }))
  const hostPort = await port()
  host = await hostStart(hostPort, dataRoot, toolRoot, modelsFile)
  assert.equal((await json(hostPort, 'GET', '/api/models')).body.defaultKey, 'alpha/alpha-wire')
  const firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push('browser ' + String(error)))
  await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load' })
  await page.waitForSelector('#experiment-token')
  await page.type('#experiment-token', token)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(item => item.textContent === 'New session'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'New session')?.click())
  await page.waitForSelector('.foxwarm-chat-root')
  const switchId = new URL(page.url()).searchParams.get('sessionId')
  assert.match(switchId, /^s_[a-f0-9]{32}$/)
  await send(hostPort, switchId, 'hold-switch')
  await until(() => provider.heldSwitch, 'held alpha request')
  await page.click('.foxwarm-model-selector-trigger')
  await page.waitForSelector('[data-model-selector-popup="true"]')
  assert.equal(await page.$('[data-model-column="child"]'), null, 'Experimental selector has no child controls')
  assert.equal(await page.$('[aria-label="Configure models"]'), null, 'No unsupported Setup action')
  await page.click('[data-model-column="current"] [data-model-option-key="beta/beta-wire"]')
  await until(async () => (await history(hostPort, switchId)).session.modelKey === 'beta/beta-wire', 'browser model switch')
  if (!(await page.$('[data-model-selector-popup="true"]'))) await page.click('.foxwarm-model-selector-trigger')
  await page.waitForSelector('input[aria-label="Current effort"]')
  await page.waitForFunction(() => {
    const slider = document.querySelector('input[aria-label="Current effort"]')
    return slider && !slider.disabled && document.querySelector('[data-model-selector-popup="true"]')?.getAttribute('data-model-saving') !== 'true'
  })
  await page.focus('input[aria-label="Current effort"]')
  await page.keyboard.press('End')
  await until(async () => (await history(hostPort, switchId)).session.effectiveEffort === 'high',
    `browser effort switch: ${JSON.stringify(await page.evaluate(() => {
      const slider = document.querySelector('input[aria-label="Current effort"]')
      return { value: slider?.value, disabled: slider?.disabled,
        error: document.querySelector('[data-model-selector-popup="true"]')?.textContent?.slice(-180) }
    }))}`)
  provider.releaseSwitch()
  await until(async () => (await history(hostPort, switchId)).messages.length === 2, 'alpha frozen request finish')
  const heldRequest = provider.requests.find(item => item.input.includes('hold-switch'))
  assert.equal(heldRequest.model, 'alpha-wire')
  assert.equal(heldRequest.authorization, `Bearer ${alphaToken}`)
  await send(hostPort, switchId, 'after-switch')
  await until(async () => (await history(hostPort, switchId)).messages.length === 4, 'beta next request')
  const betaRequest = provider.requests.find(item => item.input.includes('after-switch'))
  assert.equal(betaRequest.model, 'beta-wire')
  assert.equal(betaRequest.authorization, `Bearer ${betaToken}`)
  assert.deepEqual(betaRequest.reasoning, { effort: 'high', summary: 'auto' })
  assert.deepEqual(betaRequest.include, ['reasoning.encrypted_content'])

  const layeredId = await create(hostPort)
  for (let index = 0; index < 26; index++) {
    await send(hostPort, layeredId, index === 8 ? 'seed-l1-tool read' :
      `seed-l1-${index} ` + `unique-${index}-`.repeat(125))
    await until(async () => (await history(hostPort, layeredId)).messages.length >= 2 * (index + 1) + (index >= 8 ? 2 : 0),
      `seed layered turn ${index}`, 25000)
  }
  const readCall = (await json(hostPort, 'GET', `/api/sessions/${layeredId}/archive/messages/18`)).body.message
  const readResult = (await json(hostPort, 'GET', `/api/sessions/${layeredId}/archive/messages/19`)).body.message
  assert.equal(readCall.parts[0].functionCall.id, 'layered-read-pair')
  assert.equal(readResult.parts[0].functionResponse.response.output, 'PAIRED_TOOL_CONTENT')
  try {
    await until(async () => provider.layerPlanCount >= 1 && (await history(hostPort, layeredId)).messages.some(
      row => row.__meta?.contextBlock?.level === 1), 'automatic L1 compaction', 40000)
  } catch (error) {
    console.error('Automatic compact evidence', JSON.stringify({
      state: await state(hostPort, layeredId),
      count: (await history(hostPort, layeredId)).messages.length,
      plans: provider.layerPlanCount, invalid: provider.invalidSent, failed: provider.failed,
      last: provider.requests.slice(-3).map(item => ({ model: item.model, planner: item.planner,
        inputTail: item.input.slice(-600), usageInput: item.input.includes('seed-l1-25') })),
      host: host.output,
    }))
    throw error
  }
  assert(provider.invalidSent, 'First planner request submitted an invalid range')
  assert(provider.requests.some(item => item.planner && item.input.includes('COMPACT PLAN INVALID.')),
    'Planner saw source-derived invalid-plan feedback and retried')
  await until(async () => !(await state(hostPort, layeredId)).busy, 'automatic compaction idle')
  assert.equal((await command(hostPort, layeredId, '/compact')).status, 202)
  await until(async () => provider.layerPlanCount >= 2 && (await history(hostPort, layeredId)).messages.filter(
    row => row.__meta?.contextBlock?.level === 1).length >= 6, 'manual second L1 plan', 40000)
  await until(async () => !(await state(hostPort, layeredId)).busy, 'manual L1 idle')
  const beforeL2 = await history(hostPort, layeredId)
  assert.equal((await command(hostPort, layeredId, '/compact')).status, 202)
  await until(async () => provider.layerPlanCount >= 3 && (await history(hostPort, layeredId)).messages.some(
    row => row.__meta?.contextBlock?.level === 2), 'manual L2 plan', 40000)
  await until(async () => !(await state(hostPort, layeredId)).busy, 'manual L2 idle')
  const layered = await history(hostPort, layeredId)
  const l2 = layered.messages.find(row => row.__meta?.contextBlock?.level === 2)?.__meta?.contextBlock
  assert(l2?.sourceBlockIds?.length >= 2, 'Actual L2 has two archived L1 children')
  assert(layered.messages.length < beforeL2.messages.length, 'L2 reduced the active history')
  assert(layered.historyVersion >= 3 && layered.nextMessageSeq > 54)
  const toolPairBlock = layered.messages.find(row => row.__meta?.contextBlock?.level === 1
    && row.__meta.contextBlock.rawStartSeq <= 18 && row.__meta.contextBlock.rawEndSeq >= 19)
  assert(toolPairBlock, 'One actual L1 operation covered the whole call+tool candidate')
  assert.equal(layered.messages.filter(row => [18, 19].includes(row.__meta?.seq)).length, 0,
    'No orphan call or tool response remained active')
  const pairExpansion = await json(hostPort, 'GET', `/api/sessions/${layeredId}/context-blocks/${toolPairBlock.__meta.contextBlock.id}/expand?previewLength=6000`)
  assert.equal(pairExpansion.status, 200)
  assert(pairExpansion.body.messages.some(row => row.__meta?.seq === 18 && row.role === 'model'))
  assert(pairExpansion.body.messages.some(row => row.__meta?.seq === 19 && row.role === 'tool'))
  const l2Result = await json(hostPort, 'GET', `/api/sessions/${layeredId}/context-blocks/${l2.id}/expand?previewLength=6000`)
  assert.equal(l2Result.status, 200)
  assert.equal(l2Result.body.expansionKind, 'child-blocks')
  const firstChild = l2Result.body.items[0].block.id
  const rawResult = await json(hostPort, 'GET', `/api/sessions/${layeredId}/context-blocks/${firstChild}/expand?previewLength=6000`)
  assert.equal(rawResult.status, 200)
  assert.equal(rawResult.body.expansionKind, 'messages')
  assert(rawResult.body.messages.some(row => JSON.stringify(row).includes('seed-l1-0')))
  await send(hostPort, layeredId, 'post-l2 context check')
  await until(async () => (await history(hostPort, layeredId)).messages.at(-1)?.parts?.[0]?.text === 'synthetic response',
    'normal provider continues after L2')
  assert(provider.requests.some(item => !item.planner && item.input.includes('post-l2 context check')
    && item.input.includes(`[CTX-BLOCK L2 B#${l2.id}`)), 'Next provider consumes new L2 active context')

  const pruneId = await create(hostPort)
  await send(hostPort, pruneId, 'seed-prune read')
  await until(async () => (await history(hostPort, pruneId)).messages.length >= 4, 'read tool committed original')
  for (let index = 0; index < 7; index++) {
    await send(hostPort, pruneId, `seed-prune follow-${index}`)
    await until(async () => (await history(hostPort, pruneId)).messages.length >= 6 + 2 * index, 'prune follow-up')
  }
  await send(hostPort, pruneId, 'prune-trigger')
  await until(async () => (await history(hostPort, pruneId)).messages.some(row =>
    JSON.stringify(row).includes('historical tool response pruned')), 'automatic prune-only rewrite', 40000)
  await until(async () => !(await state(hostPort, pruneId)).busy, 'prune-only idle')
  const pruned = await history(hostPort, pruneId)
  assert(!pruned.messages.some(row => row.__meta?.contextBlock), 'Prune-only recovery did not create CTX blocks')
  assert(!JSON.stringify(pruned).includes(middleMarker), 'Original interior removed from active history')
  const original = await json(hostPort, 'GET', `/api/sessions/${pruneId}/archive/messages/3`)
  assert.equal(original.status, 200)
  assert(original.body.messageJson.includes(middleMarker), 'Immutable original JSON remains in Archive')
  assert(original.body.message.parts[0].functionResponse.response.output.includes(middleMarker))
  await send(hostPort, pruneId, 'find-pruned-middle')
  await until(async () => (await history(hostPort, pruneId)).messages.at(-1)?.parts?.[0]?.text?.includes('SENTINEL_MIDDLE'),
    'model-facing exact recall pagination', 40000)
  assert((await history(hostPort, pruneId)).messages.some(row => row.role === 'tool'
    && JSON.stringify(row).includes(middleMarker)), 'recall second page contained interior marker')

  const stopId = await create(hostPort)
  for (let i = 0; i < 8; i++) {
    await send(hostPort, stopId, `seed-stop-${i} ` + `stop-${i}-`.repeat(170))
    await until(async () => (await history(hostPort, stopId)).messages.filter(row => row.role === 'model').length >= i + 1,
      `stop seed ${i}`)
  }
  await until(async () => !(await state(hostPort, stopId)).busy, 'stop seed idle')
  assert.equal((await command(hostPort, stopId, '/compact')).status, 202)
  await until(() => provider.heldStop, 'held planner')
  const beforeStop = await history(hostPort, stopId)
  await send(hostPort, stopId, 'queued-stop after planner cancellation')
  assert.equal((await history(hostPort, stopId)).queueLength, 1)
  const stopped = await command(hostPort, stopId, '/stop compact')
  assert.equal(stopped.status, 200)
  assert.equal(stopped.body.stoppedCompact, true)
  await until(() => provider.heldStopClosed, 'planner connection closed')
  await until(async () => (await history(hostPort, stopId)).messages.some(row => row.parts?.[0]?.text ===
    'queued input resumed after compact cancellation'), 'queued input processed after stop', 40000)
  const stoppedHistory = await history(hostPort, stopId)
  assert(!stoppedHistory.messages.some(row => row.__meta?.contextBlock), 'Cancelled compact published no block')
  assert(stoppedHistory.messages.length >= beforeStop.messages.length + 2)
  assert.equal(stoppedHistory.queueLength, 0)

  await hostStop(hostPort, host)
  host = null
  const second = await hostStart(hostPort, dataRoot, toolRoot, modelsFile)
  host = second
  assert.notEqual(second.child.pid, firstPid)
  assert.equal((await history(hostPort, switchId)).session.modelKey, 'beta/beta-wire')
  assert.equal((await history(hostPort, switchId)).session.effectiveEffort, 'high')
  assert.equal((await history(hostPort, layeredId)).messages.find(row => row.__meta?.contextBlock?.level === 2)?.__meta?.contextBlock?.id, l2.id)
  await visit(page, hostPort, layeredId)
  await page.waitForSelector('.foxwarm-context-block-card')
  await page.evaluate(id => {
    const cards = [...document.querySelectorAll('.foxwarm-context-block-card')]
    const card = cards.find(item => item.textContent?.includes(`B#${id}`))
    if (!card) throw new Error(`Missing L2 B#${id} Chat card`)
    card.querySelector('button')?.click()
  }, l2.id)
  await page.waitForSelector('.foxwarm-context-block-nested .foxwarm-context-block-card')
  await page.evaluate(() => document.querySelector('.foxwarm-context-block-nested .foxwarm-context-block-card button')?.click())
  await page.waitForFunction(() => document.querySelector('.foxwarm-context-block-nested')?.textContent?.includes('seed-l1-0'))
  assert.equal((await json(hostPort, 'GET', `/api/sessions/${pruneId}/archive/messages/3`)).body.messageJson, original.body.messageJson)
  assert.deepEqual(errors, [])
  assert.deepEqual(provider.failed, [])
  await hostStop(hostPort, second)
  host = null
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid: second.child.pid, layeredId, switchId, pruneId,
    stopId, requestCount: provider.requests.length, planCount: provider.layerPlanCount,
    firstPlanInvalidThenCorrected: provider.invalidSent, l2Id: l2.id, childIds: l2.sourceBlockIds,
    archivedOriginalBytes: Buffer.byteLength(original.body.messageJson), browserNestedExpansion: true,
    pruneOnlyRecallPaged: true, heldPlannerStopped: provider.heldStopClosed, frozenModelAndPersistedEffort: true }))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (host?.child.exitCode === null) {
    try { process.kill(-host.child.pid, 'SIGKILL') } catch {}
    await once(host.child, 'exit').catch(() => {})
  }
  await provider?.close()
  await rm(root, { recursive: true, force: true })
}
