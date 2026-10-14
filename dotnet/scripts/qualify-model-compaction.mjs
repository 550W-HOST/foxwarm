#!/usr/bin/env node
// Owned localhost qualification through the normal HTTP host, Session tools and provider requests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

assert(process.env.DOTNET_ROOT, 'Select a .NET 10 SDK with DOTNET_ROOT.')
const root = await mkdtemp(join(tmpdir(), 'foxwarm-model-compact-'))
const data = join(root, 'data'), work = join(root, 'work'), skills = join(root, 'skills')
const token = 'localhost-model-compact-fixture'
const requests = [], failures = []
let host, output = '', sessionId, preservedIds, planMode = 'preserve'
let releasePlan, planReached
const planReady = new Promise(done => { planReached = done })
const planRelease = new Promise(done => { releasePlan = done })
const sleep = ms => new Promise(done => setTimeout(done, ms).unref())
async function until(check, label, seconds = 20) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    if (failures.length) throw failures[0]
    if (host?.exitCode != null) throw new Error(`Host exited: ${output}`)
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}; host=${output}`)
}
const seenCommands = new Set()
const provider = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    assert.equal(body.max_output_tokens, body.model === 'a-wire' ? 137 : 222)
    const texts = (body.input || []).flatMap(row => row.content || []).map(part => part.text || '')
    const latest = texts.filter(text => /^(image|skill|large|seed|continue|leaf)/.test(text)).at(-1) || ''
    const planner = texts.some(text => text.includes('COMPACTION STARTED:'))
    let items, usage
    const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
    if (planner) {
      const candidateText = texts.filter(text => text.includes('COMPACTION STARTED:')).at(-1).split('Previously preserved raw messages')[0]
      const ranges = [...candidateText.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)]
      const blocks = ranges.length ? [{ level: 1, sourceKind: 'message', sourceStart: +ranges[0][1], sourceEnd: +(ranges.at(-1)[2] || ranges.at(-1)[1]), summary: 'Qualified prior context.' }] : []
      if (planMode === 'preserve') {
        planReached()
        await planRelease
      }
      items = [call('planner-' + planMode, 'submit_compact_plan', { replaceAsBlocks: blocks,
        ...(planMode === 'preserve' ? { preserveMessages: [preservedIds[1]] } : { removePreservedMessages: preservedIds }) })]
    } else if (!seenCommands.has(latest) && /^(image|skill|large|continue)/.test(latest)) {
      seenCommands.add(latest)
      if (latest.startsWith('skill')) items = [call('genuine-skill', 'skill', { action: 'load', skillName: 'fixture' })]
      else items = [call(latest.startsWith('large') ? 'ordinary-read' : latest.startsWith('continue') ? 'continued-read-' + seenCommands.size : 'image-' + body.model,
        'read', { filePath: latest.startsWith('large') ? join(work, 'large.txt') : latest.startsWith('continue') ? join(work, 'small.txt') : join(work, 'image.png') })]
      if (latest.startsWith('continue')) usage = { input_tokens: 21000, output_tokens: 1 }
    } else {
      const images = (body.input || []).flatMap(row => row.content || (Array.isArray(row.output) ? row.output : [])).filter(part => part.type === 'input_image')
      if (latest.startsWith('image')) {
        assert(images.length > 0, JSON.stringify(body.input))
        assert(images.every(image => image.image_url.startsWith(body.model === 'a-wire' ? 'data:image/webp;' : 'data:image/jpeg;')))
      }
      items = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer' }] }]
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'fixture', status: 'completed', output: items, ...(usage ? { usage } : {}) } }) + '\n\n')
  } catch (error) {
    failures.push(error)
    res.writeHead(400)
    res.end('Fixture rejected request')
  }
})
let hostPort
async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
async function history() { const result = await api('GET', `/api/sessions/${sessionId}/history`); assert.equal(result.status, 200); return result.body.messages }
async function idle() { return until(async () => !(await api('GET', `/api/sessions/${sessionId}/state`)).body.session.busy, 'idle Session') }
async function send(text) { assert.equal((await api('POST', `/api/sessions/${sessionId}/message`, { text })).status, 202); await idle() }
try {
  await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work); await mkdir(join(skills, 'fixture'), { recursive: true })
  await writeFile(join(data, 'state', 'token'), token)
  await writeFile(join(data, 'state', 'config.yaml'), 'llm:\n  contextLimit: 40000\n  maxOutput: 400\n  providerImageOutputFormat: jpeg\n')
  await writeFile(join(skills, 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Local qualification skill.\n---\n\nSKILL_MIDDLE_SENTINEL\n' + 'skill body '.repeat(500))
  await writeFile(join(work, 'large.txt'), 'ORDINARY_MIDDLE_SENTINEL\n' + 'ordinary output '.repeat(1800))
  await writeFile(join(work, 'small.txt'), 'completed real tool')
  await sharp({ create: { width: 4097, height: 2, channels: 3, background: { r: 90, g: 80, b: 70 } } }).png().toFile(join(work, 'image.png'))
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const providerUrl = `http://127.0.0.1:${provider.address().port}`
  const models = { default: 'a', defaults: { contextLimit: 30000, maxOutput: 300, providerImageOutputFormat: 'jpeg' }, providers: {
    a: { providerType: 'openai-responses', baseUrl: providerUrl, contextLimit: 20000, maxOutput: 111, providerImageOutputFormat: 'webp', extraFields: { max_output_tokens: 137 }, models: ['a-wire'] },
    b: { providerType: 'openai-responses', baseUrl: providerUrl, contextLimit: 20000, models: [{ id: 'b-wire', maxOutput: 222, providerImageOutputFormat: 'jpeg' }] },
    pool: { providerType: 'session-hash', targets: ['a', 'b'] },
  } }
  const installed = JSON.stringify(models)
  await writeFile(join(data, 'state', 'models.yaml'), installed)
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening')
  hostPort = portServer.address().port; await new Promise(done => portServer.close(done))
  host = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, FOXWARM_DATA_DIR: data, FOXWARM_CONFIG_PATH: join(data, 'state', 'config.yaml'), FOXWARM_EXPERIMENT_TOOL_ROOT: work,
    FOXWARM_EXPERIMENT_PORT: String(hostPort), FOXWARM_EXPERIMENT_SKILLS_ROOT: skills, FOXWARM_PUBLIC_BASE_URL: `http://127.0.0.1:${hostPort}/`,
  } })
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000) })
  await until(async () => { try { return (await api('GET', '/health')).status === 200 } catch { return false } }, 'HTTP host')
  const created = await api('POST', '/api/agents', { agentId: 'qualification' }); assert.equal(created.status, 201)
  sessionId = encodeURIComponent(created.body.sessionId)
  const bad = structuredClone(models); bad.defaults.maxOutput = 0
  assert.equal((await api('POST', '/api/setup/models', { yaml: JSON.stringify(bad) })).status, 400)
  assert.equal(await readFile(join(data, 'state', 'models.yaml'), 'utf8'), installed)
  await send('image-a')
  assert.equal((await api('POST', `/api/sessions/${sessionId}/model`, { model: 'b' })).status, 200)
  await send('image-b')
  assert.equal((await api('POST', `/api/sessions/${sessionId}/model`, { model: 'pool' })).status, 200)
  await send('leaf virtual selection')
  assert.equal((await api('POST', `/api/sessions/${sessionId}/model`, { model: 'a' })).status, 200)
  await send('skill load')
  await send('large read')
  for (let i = 0; i < 8; i++) await send('seed-' + i + ' ' + 'context '.repeat(130))
  const original = await history()
  const skillCall = original.find(row => row.parts.some(part => part.functionCall?.id === 'genuine-skill'))
  const skillResponse = original.find(row => row.parts.some(part => part.functionResponse?.tool_use_id === 'genuine-skill'))
  assert(skillResponse.parts[0].functionResponse.response.output.includes('SKILL_MIDDLE_SENTINEL'))
  preservedIds = [skillCall.__meta.seq, skillResponse.__meta.seq]
  await send('continue real tool after usage')
  const pruned = await history()
  assert.equal(requests.filter(body => JSON.stringify(body.input).includes('COMPACTION STARTED:')).length, 0)
  assert.deepEqual(pruned.find(row => row.__meta.seq === preservedIds[1]), skillResponse)
  assert(pruned.find(row => row.parts.some(part => part.functionResponse?.tool_use_id === 'ordinary-read')).parts[0].functionResponse.response.output.includes('historical tool response pruned'))
  assert.equal((await api('POST', `/api/sessions/${sessionId}/message`, { text: '/compact' })).status, 202)
  await Promise.race([planReady, sleep(15000).then(() => { throw new Error('Planner request missing') })])
  const beforeContinuation = requests.length
  assert.equal((await api('POST', `/api/sessions/${sessionId}/message`, { text: 'continue real tool while planner is held' })).status, 202)
  await until(async () => (await history()).filter(row => row.parts.some(part => part.functionResponse?.tool_use_id?.startsWith('continued-read-'))).length === 2, 'complete tool pair before continuation wait')
  assert.equal(requests.length, beforeContinuation + 1, 'No next provider call while over-limit planning is held')
  assert.equal((await api('GET', `/api/sessions/${sessionId}/state`)).body.session.busy, true)
  releasePlan()
  await until(async () => (await history()).some(row => row.__meta?.contextBlock), 'committed compact')
  await idle()
  assert.equal(requests.length, beforeContinuation + 2, 'Owner compact commit admits exactly one new provider request')
  const compacted = await history()
  assert(compacted.find(row => row.__meta.seq === preservedIds[0]).__meta.preservedFromBlockId)
  assert(compacted.find(row => row.__meta.seq === preservedIds[1]).__meta.preservedFromBlockId)
  planMode = 'remove'
  assert.equal((await api('POST', `/api/sessions/${sessionId}/message`, { text: '/compact' })).status, 202)
  await until(async () => !(await history()).some(row => preservedIds.includes(row.__meta?.seq)), 'whole exchange removal')
  await idle()
  const archived = await api('GET', `/api/sessions/${sessionId}/archive/messages/${preservedIds[1]}`)
  assert.equal(archived.status, 200); assert.deepEqual(archived.body.message, skillResponse)
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  const [exit] = await once(host, 'exit'); assert.equal(exit, 0, output)
  console.log(JSON.stringify({ requests: requests.length, maskedInvalidSavePreserved: true, physicalLeafOutputAndImage: true, virtualSelection: true, genuineSkillRetained: true, materialPrune: true, overLimitHeldPlannerAndOwnerContinuation: true, pairedPreserveAndRemove: true, immutableArchive: true }))
} finally {
  releasePlan?.()
  if (host && host.exitCode == null) { host.kill('SIGKILL'); await once(host, 'exit') }
  provider.closeAllConnections(); await new Promise(done => provider.close(done))
  await rm(root, { recursive: true, force: true })
}
