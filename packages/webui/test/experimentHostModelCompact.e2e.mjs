#!/usr/bin/env node
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { migrateModelFixture } from './experimentModelFixture.mjs'
// Concentrated localhost browser+HTTP+SQLite acceptance for the bounded .NET Chat host.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
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
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify({ failed: provider?.failed, host: host?.output, last: provider?.requests.slice(-2).map(row => row.input.slice(-2200)) })}`)
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
  await migrateModelFixture(dataRoot, modelsFile, { FOXWARM_ALPHA_PROVIDER_KEY: alphaToken, FOXWARM_BETA_PROVIDER_KEY: betaToken })
  const child = spawn(dotnet, [dll], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...testEnvironment.isolatedApplicationEnv(dataRoot),
    FOXWARM_EXPERIMENT_API_TOKEN: token,
    FOXWARM_EXPERIMENT_MODELS_FILE: modelsFile, FOXWARM_ALPHA_PROVIDER_KEY: alphaToken,
    FOXWARM_BETA_PROVIDER_KEY: betaToken,
    FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS: '8192',
  } })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000) })
  try { await until(async () => {
    if (child.exitCode !== null) throw new Error(`Host exited: ${output}`)
    try { return (await json(hostPort, 'GET', '/health')).status === 200 } catch { return false }
  }, 'host ready') } catch (error) { console.error('HOST-START', output); try { process.kill(-child.pid, 'SIGKILL') } catch {} throw error }
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
  await page.goto(`http://127.0.0.1:${hostPort}/#session/${id}`, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-root', { timeout: 15000 })
}

try {
  const dataRoot = join(root, 'data'); const toolRoot = join(dataRoot, 'agents', 'main')
  await mkdir(dataRoot); await mkdir(toolRoot, { recursive: true })
  const middleMarker = 'SENTINEL_MIDDLE_UNREWRITTEN_ARCHIVE'
  await writeFile(join(toolRoot, 'long.txt'), 'BEGIN:' + 'a'.repeat(19800) + middleMarker + 'b'.repeat(19800) + ':END', 'utf8')
  await writeFile(join(toolRoot, 'toolpair.txt'), 'PAIRED_TOOL_CONTENT', 'utf8')
  provider = await startScriptedProvider({ alphaToken, betaToken })
  const modelsFile = join(root, 'models.json')
  await writeFile(modelsFile, JSON.stringify({ default: 'alpha', providers: {
    alpha: { providerType: 'openai', asyncCompact: false, baseUrl: `http://127.0.0.1:${provider.port}`, apiKeyEnv: 'FOXWARM_ALPHA_PROVIDER_KEY',
      contextLimit: 18000, effort: { allowed: ['none', 'low', 'high'], default: 'low' }, models: [{ id: 'alpha-wire' }] },
    gamma: { providerType: 'openai-responses', asyncCompact: false, baseUrl: `http://127.0.0.1:${provider.port}`, apiKeyEnv: 'FOXWARM_BETA_PROVIDER_KEY', contextLimit: 20000, effort: { allowed: ['medium'], default: 'medium' }, models: [{ id: 'gamma-wire' }] },
    beta: { providerType: 'openai-responses', asyncCompact: false, baseUrl: `http://127.0.0.1:${provider.port}`, apiKeyEnv: 'FOXWARM_BETA_PROVIDER_KEY',
      contextLimit: 18000, effort: { allowed: ['none', 'low', 'high'], default: 'none' }, models: [{ id: 'beta-wire' }] },
  } }))
  const hostPort = await port()
  await mkdir(join(dataRoot, 'state'), { recursive: true })
  await writeFile(join(dataRoot, 'state/config.yaml'), `bot: {httpPort: ${hostPort}}\n`)
  await writeFile(join(dataRoot, 'state/token'), token, { mode: 0o600 })
  host = await hostStart(hostPort, dataRoot, toolRoot, modelsFile)
  assert.equal((await json(hostPort, 'GET', '/api/models')).body.defaultKey, 'alpha')
  const firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push('browser ' + String(error)))
  await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load' })
  await page.waitForSelector('#token')
  await page.type('#token', token)
  await page.click('button[type="submit"]')
  await page.waitForSelector('button[aria-label="New session"]')
  await page.click('button[aria-label="New session"]')
  await page.waitForSelector('form[role="dialog"]')
  await page.click('form[role="dialog"] button[type="submit"]')
  await page.waitForSelector('form[role="dialog"]', { hidden: true })
  await page.waitForSelector('.foxwarm-chat-root')
  const switchId = decodeURIComponent(new URL(page.url()).hash).slice('#tab/chat:'.length)
  assert.match(switchId, /^s_[a-f0-9]{32}$/)
  await send(hostPort, switchId, 'hold-switch')
  await until(() => provider.heldSwitch, 'held alpha request')
  await page.click('.foxwarm-model-selector-trigger')
  await page.waitForSelector('[data-model-selector-popup="true"]')
  assert(await page.$('[data-model-child-mode="specific"]'), 'Original child settings entry is available')
  assert(await page.$('[aria-label="Configure models"]'), 'Original Models Setup is available')
  await page.click('[data-model-column="current"] [data-model-option-key="beta"]')
  await until(async () => (await history(hostPort, switchId)).session.modelKey === 'beta', 'browser model switch')
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
  await page.click('[data-model-child-mode="specific"]')
  await page.waitForSelector('[data-model-column="child"]')
  await page.click('[data-model-column="child"] [data-model-option-key="gamma"]')
  await until(async () => (await history(hostPort, switchId)).session.effectiveChildModelKey === 'gamma/gamma-wire', 'original child model UI')
  assert.equal((await history(hostPort, switchId)).session.effectiveChildEffort, 'medium')
  if (!(await page.$('[data-model-selector-popup="true"]'))) await page.click('.foxwarm-model-selector-trigger')
  await page.click('[data-model-column="child"] [data-model-option-key="beta"]')
  await until(async () => (await history(hostPort, switchId)).session.effectiveChildModelKey === 'beta/beta-wire', 'original child effort target')
  if (!(await page.$('[data-model-selector-popup="true"]'))) await page.click('.foxwarm-model-selector-trigger')
  await page.waitForSelector('input[aria-label="Child effort"]')
  await page.waitForFunction(() => !document.querySelector('input[aria-label="Child effort"]')?.disabled)
  await page.focus('input[aria-label="Child effort"]'); await page.keyboard.press('End')
  await until(async () => (await history(hostPort, switchId)).session.childEffortDefault === 'high', 'original child effort UI')
  await page.click('[data-model-child-mode="follow"]')
  await until(async () => (await history(hostPort, switchId)).session.childModelDefault === null, 'original follow clears model only')
  assert.equal((await history(hostPort, switchId)).session.childEffortDefault, 'high')
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

  // Real fixed settings tools and strict owner lane, including targeted settings and child creation.
  const settingsAgent = await json(hostPort, 'POST', '/api/agents', { agentId: 'settings' }); assert.equal(settingsAgent.status, 201)
  const parentId = settingsAgent.body.sessionId
  const parentUrl = encodeURIComponent(parentId)
  async function setting(taskId, name, args, caller = parentId) {
    await send(hostPort, encodeURIComponent(caller), 'SETTINGS-TASK ' + JSON.stringify({ id: taskId, name, args }))
    await until(async () => (await history(hostPort, encodeURIComponent(caller))).messages.some(row => row.parts?.some(part => part.text === 'SETTINGS-DONE-' + taskId)), taskId)
    await until(async () => !(await state(hostPort, encodeURIComponent(caller))).busy, taskId + ' idle')
    return (await history(hostPort, encodeURIComponent(caller))).messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === taskId)?.functionResponse.response
  }
  const view = async id => (await history(hostPort, encodeURIComponent(id))).session
  assert(!(await setting('child-pair', 'set_session_child_model', { model: 'beta/beta-wire', effort: 'high' })).error)
  assert.equal((await view(parentId)).childEffortDefault, 'high')
  assert((await setting('invalid-pair', 'set_session_child_model', { model: 'gamma/gamma-wire', effort: 'high' })).error)
  assert.equal((await view(parentId)).childModelDefault, 'beta/beta-wire')
  assert(!(await setting('stale-normalize', 'set_session_child_model', { model: 'gamma/gamma-wire' })).error)
  assert.equal((await view(parentId)).childEffortDefault, null); assert.equal((await view(parentId)).effectiveChildEffort, 'medium')
  assert((await setting('bad-clear', 'set_session_child_model', { model: 'beta/beta-wire', clear: true })).error)
  assert(!(await setting('make-child', 'create_child_session', { suffix: 'one' })).error)
  const childId = 'settings/one'; assert.equal((await view(childId)).model, 'gamma/gamma-wire'); assert.equal((await view(childId)).childModelDefault, null)
  assert(!(await setting('grandchild', 'create_child_session', { suffix: 'two' }, childId)).error)
  assert.equal((await view('settings/one_two')).model, 'gamma/gamma-wire'); assert.equal((await view('settings/one_two')).childModelDefault, null)
  assert(!(await setting('targeted', 'set_session_child_model', { sessionId: parentId, model: 'beta/beta-wire', effort: 'low' }, childId)).error)
  assert.equal((await view(childId)).model, 'gamma/gamma-wire')
  assert(!(await setting('clear-only', 'set_session_child_model', { clear: true })).error)
  assert.equal((await view(parentId)).childModelDefault, null); assert.equal((await view(parentId)).childEffortDefault, 'low')
  assert(!(await setting('effort-unset', 'set_session_child_model', { effort: 'unset' })).error)
  assert.equal((await view(parentId)).childEffortDefault, null)
  const threshold = await setting('fraction', 'set_session_compact_threshold', { thresholdTokens: .9 })
  assert(threshold.output.includes('override: 0 tokens') && threshold.output.includes('15300'))
  assert.equal((await view(parentId)).compactThresholdTokens, 0)
  await setting('inspect-negative', 'set_session_compact_threshold', { thresholdTokens: -1 }); assert.equal((await view(parentId)).compactThresholdTokens, 0)
  await setting('threshold-clear', 'set_session_compact_threshold', { clear: true }); assert.equal((await view(parentId)).compactThresholdTokens, null)
  await setting('threshold-target', 'set_session_compact_threshold', { sessionId: parentId, thresholdTokens: 12345.9 }, childId)
  assert.equal((await view(parentId)).compactThresholdTokens, 12345)
  const authorityFile = join(dataRoot, 'state', 'sessions', parentId + '.json')
  const noOpBefore = await readFile(authorityFile, 'utf8')
  assert.equal((await json(hostPort, 'POST', `/api/sessions/${parentUrl}/child-model`, { clear: true })).status, 200)
  assert.equal(await readFile(authorityFile, 'utf8'), noOpBefore)
  const faults = join(dataRoot, 'state', 'experiment-faults'); await mkdir(faults, { recursive: true })
  const faultKey = 'id_' + Buffer.from(parentId).toString('base64url')
  // Use the same encoded Session segment as the existing scoped fault fixtures.
  await writeFile(join(faults, faultKey + '.settings-before-rename'), '')
  const beforeFault = await setting('before-fault', 'set_session_child_model', { model: 'beta/beta-wire' })
  assert(beforeFault.error); assert.equal((await view(parentId)).childModelDefault, null)
  await writeFile(join(faults, faultKey + '.settings-after-rename'), '')
  const afterFault = await setting('after-fault', 'set_session_child_model', { model: 'beta/beta-wire', effort: 'high' })
  assert(afterFault.error); assert.equal((await view(parentId)).childModelDefault, 'beta/beta-wire')

  // A real held target accepts strict setting faults, later ingress and immediate Stop without full-envelope rollback.
  const heldId = await create(hostPort)
  await send(hostPort, heldId, 'hold-settings')
  await until(() => provider.heldSettings, 'held settings target')
  const heldAuthority = join(dataRoot, 'state', 'sessions', heldId + '.json')
  const heldSnapshot = JSON.parse(await readFile(heldAuthority, 'utf8')).persistentMemorySnapshot
  await writeFile(join(faults, heldId + '.settings-before-rename'), '')
  assert((await setting('held-before', 'set_session_child_model', { sessionId: heldId, model: 'gamma/gamma-wire' })).error)
  assert.equal((await view(heldId)).childModelDefault, null)
  await writeFile(join(faults, heldId + '.settings-after-rename'), '')
  assert((await setting('held-after', 'set_session_child_model', { sessionId: heldId, model: 'gamma/gamma-wire' })).error)
  assert.equal((await view(heldId)).childModelDefault, 'gamma/gamma-wire')
  await send(hostPort, heldId, 'later-ingress-preserved')
  assert((await state(hostPort, heldId)).queueCount >= 1)
  await command(hostPort, heldId, '/stop')
  await until(async () => !(await state(hostPort, heldId)).busy, 'held setting Stop')
  assert.equal((await view(heldId)).childModelDefault, 'gamma/gamma-wire')
  assert.equal(JSON.parse(await readFile(heldAuthority, 'utf8')).persistentMemorySnapshot, heldSnapshot)
  assert((await state(hostPort, heldId)).queueCount >= 1 || JSON.stringify((await history(hostPort, heldId)).messages).includes('later-ingress-preserved'))
  // Clear primary effort when a model-only update changes its allowed set, and validate prospective child fallback.
  const primaryId = await create(hostPort)
  assert.equal((await json(hostPort, 'POST', `/api/sessions/${primaryId}/model`, { model: 'beta/beta-wire', effort: 'high' })).status, 200)
  assert.equal((await json(hostPort, 'POST', `/api/sessions/${primaryId}/model`, { model: 'gamma/gamma-wire' })).status, 200)
  assert.equal((await view(primaryId)).effort, null); assert.equal((await view(primaryId)).effectiveEffort, 'medium')

  const layeredId = await create(hostPort)
  assert(!(await setting('auto-threshold', 'set_session_compact_threshold', { sessionId: layeredId, thresholdTokens: 15000 }, parentId)).error)
  for (let index = 0; index < 26; index++) {
    await send(hostPort, layeredId, index === 8 ? 'seed-l1-tool read' :
      `seed-l1-${index} ` + `unique-${index}-`.repeat(125))
    await until(async () => (await history(hostPort, layeredId)).messages.length >= 2 * (index + 1) + (index >= 8 ? 2 : 0),
      `seed layered turn ${index}`, 25000)
  }
  const readCall = (await json(hostPort, 'GET', `/api/sessions/${layeredId}/archive/messages/18`)).body.message
  const readResult = (await json(hostPort, 'GET', `/api/sessions/${layeredId}/archive/messages/19`)).body.message
  assert.equal(readCall.parts[0].functionCall.id, 'layered-read-pair')
  assert(readResult.parts[0].functionResponse.response.output.startsWith('PAIRED_TOOL_CONTENT\n---\n'))
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

  // Actual exact model recall uses the same source records as original HTTP expansion.
  const readerId = await create(hostPort)
  const db = join(dataRoot, 'state', 'archive-store.sqlite')
  const sql = (statement, parameters = []) => JSON.parse(execFileSync('python3', ['-c',
    'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', db, statement, JSON.stringify(parameters)], { encoding: 'utf8' }))
  const archiveBefore = sql('SELECT * FROM archive_messages WHERE session_id=? ORDER BY seq', [layeredId])
  const blocksBefore = sql('SELECT * FROM archive_blocks WHERE session_id=? ORDER BY id', [layeredId])
  const activeBefore = await readFile(join(dataRoot, 'state', 'sessions', layeredId + '.json'), 'utf8')
  async function exact(testId, args, expectedError = false) {
    await send(hostPort, readerId, 'EXACT-RECALL ' + JSON.stringify({ testId, ...args }))
    await until(async () => (await history(hostPort, readerId)).messages.some(row => row.parts?.some(part => part.text === 'EXACT-DONE-exact-' + testId)), testId)
    await until(async () => !(await state(hostPort, readerId)).busy, testId + ' idle')
    const result = (await history(hostPort, readerId)).messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'exact-' + testId)?.functionResponse.response
    assert(result, testId); if (expectedError) { assert(result.error, testId); return result.error }
    assert.equal(typeof result.output, 'string', testId); assert(result.output.length <= (args.previewLength || 1000), testId + ' total budget')
    return result.output
  }
  const overview = await exact('overview', { sessionId: layeredId })
  assert(overview.includes('Available message log') && overview.includes('L2:'))
  const frontier = await exact('frontier', { sessionId: layeredId, target: 'blocks', previewLength: 20000 })
  assert(frontier.includes('B#' + l2.id)); assert(!frontier.includes('L1 B#' + firstChild + ' '))
  const blockDetail = await exact('l2', { sessionId: layeredId, target: 'block#' + l2.id, previewLength: 1000 })
  assert(blockDetail.includes('B#' + l2.id) && blockDetail.includes('immediate child'))
  const childDetail = await exact('l1', { sessionId: layeredId, target: 'B#' + firstChild, contentFilter: 'seed-l1-0', previewLength: 2000 })
  assert(childDetail.includes('seed-l1-0'))
  const rawDetail = await exact('raw', { sessionId: layeredId, target: 'MSG : B#' + l2.id, contentFilter: 'seed-l1-0', previewLength: 2000 })
  assert(rawDetail.includes('seed-l1-0'))
  const reversed = await exact('reversed', { sessionId: layeredId, target: 'msg#19-msg#18', toolDetail: 'full', previewLength: 2000 })
  assert(reversed.includes('layered-read-pair') && reversed.includes('PAIRED_TOOL_CONTENT'))
  const narrow = await exact('one', { sessionId: layeredId, target: 'msg#19', contentFilter: 'PAIRED_TOOL_CONTENT', toolDetail: 'names', previewLength: 1000 })
  assert(narrow.includes('Matched in omitted tool'))
  assert((await exact('missing-block', { sessionId: layeredId, target: 'B#999999' })).includes('No CTX-BLOCK'))
  assert((await exact('missing-session', { sessionId: 'missing-reader-owner', target: 'overview' })).includes('not found'))
  assert((await exact('missing-range', { sessionId: layeredId, target: 'msg#999999' })).includes('Available message log'))
  await exact('offset', { sessionId: layeredId, target: 'msg#19', offset: 0 }, true)
  await exact('vector', { sessionId: layeredId, vector_query: '' }, true)
  await exact('old-syntax', { sessionId: layeredId, target: 'raw#19' }, true)
  await exact('zero', { sessionId: layeredId, target: 'msg#0' }, true)
  assert.deepEqual(sql('SELECT * FROM archive_messages WHERE session_id=? ORDER BY seq', [layeredId]), archiveBefore)
  assert.deepEqual(sql('SELECT * FROM archive_blocks WHERE session_id=? ORDER BY id', [layeredId]), blocksBefore)
  assert.equal(await readFile(join(dataRoot, 'state', 'sessions', layeredId + '.json'), 'utf8'), activeBefore)
  assert.equal(sql('SELECT COUNT(*) FROM archive_messages WHERE session_id=?', ['missing-reader-owner'])[0][0], 0)
  assert.equal((await json(hostPort, 'GET', '/api/sessions/missing-reader-owner/state')).status, 404)
  const rangePlan = sql('EXPLAIN QUERY PLAN SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq', [layeredId, 18, 19])
  assert(rangePlan.some(row => row.join(' ').includes('SEARCH')) && !rangePlan.some(row => row.join(' ').includes('SCAN archive_messages')))
  const statsPlan = sql('EXPLAIN QUERY PLAN SELECT COUNT(*),MIN(seq),MAX(seq) FROM archive_messages WHERE session_id=? AND seq BETWEEN ? AND ?', [layeredId, 1, 9007199254740991])
  assert(statsPlan.some(row => row.join(' ').includes('COVERING INDEX')))

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

  const legacyId = await create(hostPort)
  const legacyPath = join(dataRoot, 'state', 'sessions', legacyId + '.json')
  await hostStop(hostPort, host)
  host = null
  // Owned offline read-old fixture: historical paired output is preserved, not regenerated by new recall.
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8')); const legacyTime = Date.now()
  legacy.history = [
    { role: 'model', parts: [{ functionCall: { id: 'legacy-recall', name: 'recall', args: { target: 'msg#1', offset: 0 }, rawArgsText: '{"target":"msg#1","offset":0}' } }], __meta: { seq: 1, timestamp: legacyTime } },
    { role: 'tool', parts: [{ functionResponse: { name: 'recall', tool_use_id: 'legacy-recall', response: { target: 'msg#1', offset: 0, text: 'LEGACY-RECALL-CONTENT', totalCharacters: 15000, nextOffset: 12000 } } }], __meta: { seq: 2, timestamp: legacyTime + 1 } },
    { role: 'model', parts: [{ text: 'Legacy completed result' }], __meta: { seq: 3, timestamp: legacyTime + 2 } }
  ]; legacy.nextMessageSeq = 4; legacy.meta.messageCount = 3
  await writeFile(legacyPath, JSON.stringify(legacy))
  execFileSync('python3', ['-c', 'import sqlite3,json,sys; p=json.load(open(sys.argv[2])); c=sqlite3.connect(sys.argv[1]); c.executemany("INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES(?,?,?,?,?,?)",[(sys.argv[3],"main",m["__meta"]["seq"],m["__meta"]["timestamp"],m["role"],json.dumps(m,separators=(",",":"),ensure_ascii=False)) for m in p["history"]]); c.commit()', db, legacyPath, legacyId])
  const legacyArchive = sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [legacyId])
  // Existing supported block shape can name decreasing/nonconsecutive children; keep their actual source identities.
  const orderedIds = [4, l2.sourceBlockIds[0]]
  execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); row=list(c.execute("SELECT * FROM archive_blocks WHERE session_id=? AND id=?",(sys.argv[2],int(sys.argv[3]))).fetchone()); names=[r[1] for r in c.execute("PRAGMA table_info(archive_blocks)")]; ids=json.loads(sys.argv[4]); row[names.index("id")]=900; row[names.index("source_start")]=ids[0]; row[names.index("source_end")]=ids[-1]; row[names.index("source_block_ids_json")]=json.dumps(ids); row[names.index("summary")]="Explicit reverse-order source fixture"; children=c.execute("SELECT raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp FROM archive_blocks WHERE session_id=? AND id IN (?,?)",(sys.argv[2],*ids)).fetchall(); row[names.index("raw_start_seq")]=min(r[0] for r in children); row[names.index("raw_end_seq")]=max(r[1] for r in children); row[names.index("raw_start_timestamp")]=min(r[2] for r in children); row[names.index("raw_end_timestamp")]=max(r[3] for r in children); c.execute("INSERT INTO archive_blocks VALUES("+",".join("?" for _ in row)+")",row); c.commit()', db, layeredId, String(l2.id), JSON.stringify(orderedIds)])
  const second = await hostStart(hostPort, dataRoot, toolRoot, modelsFile)
  host = second
  assert.notEqual(second.child.pid, firstPid)
  assert.equal((await history(hostPort, switchId)).session.modelKey, 'beta')
  assert.equal((await view(parentId)).childModelDefault, 'beta/beta-wire'); assert.equal((await view(parentId)).childEffortDefault, 'high'); assert.equal((await view(parentId)).compactThresholdTokens, 12345)
  assert.equal((await history(hostPort, switchId)).session.effectiveEffort, 'high')
  assert.equal((await history(hostPort, layeredId)).messages.find(row => row.__meta?.contextBlock?.level === 2)?.__meta?.contextBlock?.id, l2.id)
  await send(hostPort, legacyId, 'OLD-RECALL-RESTORE')
  await until(async () => (await history(hostPort, legacyId)).messages.some(row => row.parts?.some(part => part.text === 'OLD-RESULT-RESTORED')), 'old paired response restored')
  await until(async () => !(await state(hostPort, legacyId)).busy, 'old result idle')
  assert.deepEqual(sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq<=3 ORDER BY seq', [legacyId]), legacyArchive)
  const orderHttp = await json(hostPort, 'GET', `/api/sessions/${layeredId}/context-blocks/900/expand?previewLength=6000`)
  assert.deepEqual(orderHttp.body.items.map(item => item.block.id), orderedIds)
  const orderModel = await exact('ordered', { sessionId: layeredId, target: 'B#900', previewLength: 6000 })
  assert(orderModel.indexOf('L1 B#' + orderedIds[0]) < orderModel.indexOf('L1 B#' + orderedIds[1]))
  const cappedChildren = await exact('child-cap', { sessionId: layeredId, target: 'B#900', previewLength: 20000 })
  assert(cappedChildren.includes('capped at 1 of 2'))
  await exact('restart-raw', { sessionId: layeredId, target: 'msg#19', toolDetail: 'snippets', contentFilter: 'PAIRED_TOOL_CONTENT' })
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
    pruneOnlyRecallFiltered: true, exactLayeredRecall: true, selectedSessionReadPure: true, boundedSqlPlans: true, oldResultRestart: true, orderedSourceFixture: true, sessionSettings: true, originalChildSelector: true, childGrandchildDefaults: true, settingsFaultRestore: true, heldSettingsIngressStopSnapshot: true, heldPlannerStopped: provider.heldStopClosed, frozenModelAndPersistedEffort: true }))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (host?.child.exitCode === null) {
    try { process.kill(-host.child.pid, 'SIGKILL') } catch {}
    await once(host.child, 'exit').catch(() => {})
  }
  await provider?.close()
  await rm(root, { recursive: true, force: true })
}
