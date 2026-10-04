#!/usr/bin/env node
import { migrateModelFixture } from './experimentModelFixture.mjs'
// One original App/Architecture/local Responses workflow: inherited memory and layered skills.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-wait-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(root, 'work'); const globalRoot = join(root, 'global-skills')
const modelsFile = join(root, 'models.json')
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
async function history(id) { const result = await request('GET', `${path(id)}/history`); if (result.status === 404) return []; assert.equal(result.status, 200, JSON.stringify(result)); return result.body.messages }
async function authority(id) { return JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', `${id}.json`), 'utf8')) }
async function send(id, value) { assert.equal((await request('POST', `${path(id)}/message`, { text: value })).status, 202) }
async function command(id, value) { return request('POST', `${path(id)}/message`, { text: value }) }
async function create(agent, name, script = []) {
  const result = await request('POST', '/api/sessions', { agentId: agent, sessionId: name })
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
  await migrateModelFixture(dataRoot, modelsFile, { KNOWLEDGE_TOKEN: providerToken })
  const child = spawn(dotnet, [process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot, FOXWARM_EXPERIMENT_TOOL_ROOT: workRoot,
      FOXWARM_EXPERIMENT_PORT: String(port), FOXWARM_EXPERIMENT_API_TOKEN: token,
      FOXWARM_EXPERIMENT_SKILLS_ROOT: globalRoot, FOXWARM_EXPERIMENT_MODELS_FILE: modelsFile, KNOWLEDGE_TOKEN: providerToken,
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
  await mkdir(dataRoot); await mkdir(workRoot); await mkdir(globalRoot)
  await mkdir(join(workRoot, 'memory')); await mkdir(join(workRoot, 'agents')); await writeFile(join(workRoot, 'memory', 'ONBOOT.md'), ' \n')
  await mkdir(join(dataRoot, 'state')); await mkdir(join(workRoot, 'agents', 'legacy', 'memory'), { recursive: true })
  await writeFile(join(dataRoot, 'state', 'agents.json'), JSON.stringify({ version: 1, agents: ['legacy'] }))
  await writeFile(join(workRoot, 'agents', '00_SYSTEM.md'), 'FRAMEWORK-FIRST')
  await mkdir(join(globalRoot, 'common')); await writeFile(join(globalRoot, 'common', 'SKILL.md'), '---\ndescription: GLOBAL-COMMON\n---\n# Common\nGLOBAL-ENTRY')
  await writeFile(join(globalRoot, 'common', 'resource.txt'), 'GLOBAL-RESOURCE')
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.headers.authorization, `Bearer ${providerToken}`); assert.equal(req.url, '/responses')
      assert.equal(body.tools.length, 24); assert(body.tools.some(tool => tool.name === 'skill'))
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
  await writeFile(modelsFile, JSON.stringify({ default: 'a/one', providers: {
    a: { providerType: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKeyEnv: 'KNOWLEDGE_TOKEN', contextLimit: 25000, models: [{ id: 'one' }] },
    b: { providerType: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKeyEnv: 'KNOWLEDGE_TOKEN', contextLimit: 25000, models: [{ id: 'two' }] }
  } }))
  host = await startHost(); firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage(); const frames = []; const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', event => { try { frames.push(JSON.parse(event.response.payloadData)) } catch {} })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' }); await page.waitForSelector('#token')
  await page.type('#token', token); await page.click('button[type="submit"]'); await page.waitForSelector('button[aria-label="New session"]')

  const agentDir = agent => join(workRoot, 'agents', agent)
  const snapshot = async id => (await authority(id)).persistentMemorySnapshot
  const prompt = body => body.instructions || ''
  const toolValue = (rows, id) => rows.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
  async function refresh(id) { assert.equal((await request('POST', `${path(id)}/refresh-memory`)).status, 200) }
  async function skill(agent, name, description, body = '', files = {}) {
    const dir = join(agent === 'global' ? globalRoot : join(agentDir(agent), 'skills'), name)
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), `---\ndescription: ${description}\n---\n# ${name}\n${body}`)
    for (const [file, content] of Object.entries(files)) { await mkdir(join(dir, file, '..'), { recursive: true }); await writeFile(join(dir, file), content) }
  }
  async function browserAgent(agent, inherit) {
    await page.click('button[aria-label="New session"]'); await page.waitForSelector('button[aria-label="New agent"]'); await page.click('button[aria-label="New agent"]')
    await page.waitForSelector('input[placeholder="my-agent"]'); await page.type('input[placeholder="my-agent"]', agent)
    if (inherit) await page.select('form[role="dialog"] select', inherit)
    await page.click('form[role="dialog"] button[type="submit"]'); await page.waitForSelector('form[role="dialog"]', { hidden: true })
    await until(async () => (await request('GET', `${path(agent + '/main')}/state`)).status === 200, `${agent} original creation`)
    plans.set(agent + '/main', [])
    await writeFile(join(agentDir(agent), 'memory', 'MEMORY.md'), `${agent.toUpperCase()}-V1`)
    await refresh(agent + '/main')
  }
  async function turn(id, label, ...steps) {
    const script = plans.get(id); const start = script.length
    script.push(...steps.map((step, index) => async (body, res) => {
      const output = typeof step === 'function' ? await step(body, res) : step
      if (!output.some(item => item.type === 'function_call')) {
        script.splice(start + index + 1, steps.length - index)
        return [...output, text(label + '-DONE')]
      }
      return output
    }), [text(label + '-DONE')])
    await send(id, label); await final(id, label + '-DONE')
  }
  await browserAgent('base')
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'state', 'agents.json'), 'utf8')).version, 2)
  assert((await request('GET', '/api/agents')).body.agents.some(agent => agent.id === 'legacy'))
  await skill('base', 'shared', 'BASE-SHARED', 'BASE-SHARED-ENTRY')
  await skill('base', 'inherited', 'BASE-INHERITED', 'INHERITED-FULL-ENTRY', { 'resource.txt': 'INHERITED-RESOURCE' })
  await writeFile(join(agentDir('base'), 'memory', 'scoped.md'), '---\ninclude-session: leaf/*\n---\nTARGET-LEAF-ONLY')
  await writeFile(join(agentDir('base'), 'memory', 'only-b.md'), '<foxwarm-if model-id="b/two">\nONLY-B\n</foxwarm-if>')
  await browserAgent('middle', 'base')
  await skill('middle', 'shared', 'MIDDLE-SHARED', 'MIDDLE-SHARED-ENTRY')
  await browserAgent('leaf', 'middle')
  await skill('leaf', 'shared', 'LEAF-SHARED', 'LOCAL-FULL-ENTRY')
  await skill('global', 'shared', 'GLOBAL-SHARED', 'GLOBAL-SHARED-ENTRY')
  await skill('leaf', 'common', '[malformed', 'BAD-LOCAL-ENTRY')
  await skill('leaf', 'vendor/analyzer', 'NESTED-CONTAINER', 'NESTED-ENTRY')
  await skill('leaf', 'package', 'PACKAGE-ENTRY', 'PACKAGE-DOCUMENT', { 'nested/deep/SKILL.md': '# Nested resource\nNOT-A-CATALOG-ENTRY' })
  await skill('leaf', 'big', 'BIG-ENTRY', 'BIG-FULL-ENTRY', Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`resources/${String(i).padStart(3, '0')}.txt`, 'RESOURCE-NOT-EAGER'])) )
  await mkdir(join(agentDir('leaf'), 'memory', 'archive')); await writeFile(join(agentDir('leaf'), 'memory', 'archive', 'note.md'), 'ARCHIVED-NOT-SNAPSHOT')
  await writeFile(join(agentDir('leaf'), 'memory', 'SOUL.md'), 'SELF-SOUL')
  await refresh('leaf/main')
  const initial = await snapshot('leaf/main')
  assert(initial.indexOf('FRAMEWORK-FIRST') < initial.indexOf('BASE-V1') && initial.indexOf('BASE-V1') < initial.indexOf('MIDDLE-V1') && initial.indexOf('MIDDLE-V1') < initial.indexOf('LEAF-V1'))
  assert(initial.includes('agent=base; ownership=inherited') && initial.includes('agent=leaf; ownership=self'))
  assert(initial.includes('TARGET-LEAF-ONLY') && !initial.includes('ONLY-B'))
  assert(initial.includes('LEAF-SHARED') && !initial.includes('MIDDLE-SHARED') && initial.includes('GLOBAL-COMMON'))
  assert(initial.includes('vendor/analyzer') && !initial.includes('<name>package/nested/deep</name>'))
  assert(!initial.includes('LOCAL-FULL-ENTRY') && !initial.includes('INHERITED-FULL-ENTRY') && !initial.includes('RESOURCE-NOT-EAGER'))
  assert.deepEqual((await request('GET', '/api/agents')).body.agents.find(agent => agent.id === 'leaf').inheritanceChain, ['base', 'middle', 'leaf'])
  assert.deepEqual((await request('GET', '/api/agents/leaf/memory')).body.files.map(file => file.path), ['MEMORY.md', 'SOUL.md', 'archive/note.md'])
  assert.equal((await request('PUT', '/api/agents/base', { inheritAgent: 'leaf', isolatedNode: null })).status, 400)
  assert.equal((await request('PUT', '/api/agents/leaf', { inheritAgent: 'missing', isolatedNode: null })).status, 400)
  assert.equal((await request('PUT', '/api/agents/leaf', { inheritAgent: 'leaf', isolatedNode: null })).status, 400)
  assert.equal((await request('PUT', '/api/agents/leaf', { inheritAgent: 'base', isolatedNode: 'unsupported-node' })).status, 501)
  assert.equal((await request('GET', '/api/agents')).body.agents.find(agent => agent.id === 'leaf').inherit, 'middle')

  await writeFile(join(globalRoot, 'oversized.txt'), 'x'.repeat(1024 * 1024 + 1))
  await symlink(join(globalRoot, 'common', 'resource.txt'), join(globalRoot, 'linked.txt'))
  execFileSync('mkfifo', [join(globalRoot, 'pipe')])

  // Actual skill load + normal read, not eager resources or executable registration.
  await turn('leaf/main', 'SKILL-WORK', body => { assert.equal(prompt(body), initial); return [call('skill-list', 'skill', { action: 'list' }), call('skill-inherited', 'skill', { action: 'load', skillName: 'inherited' }), call('skill-global', 'skill', { action: 'load', skillName: 'common' }), call('skill-big', 'skill', { action: 'load', skillName: 'big' }), call('skill-boundary', 'skill', { action: 'load', skillName: 'package/nested/deep' })] },
    [call('read-inherited', 'read', { filePath: join(agentDir('base'), 'skills', 'inherited', 'resource.txt') }), call('read-global', 'read', { filePath: join(globalRoot, 'common', 'resource.txt') }), call('outside-write', 'write', { filePath: join(globalRoot, 'common', 'no-write.txt'), content: 'must-not-write' }), call('read-large', 'read', { filePath: join(globalRoot, 'oversized.txt') }), call('read-link', 'read', { filePath: join(globalRoot, 'linked.txt') }), call('read-pipe', 'read', { filePath: join(globalRoot, 'pipe') }), call('read-device', 'read', { filePath: '/dev/zero' })])
  const skillRows = await history('leaf/main')
  assert(toolValue(skillRows, 'skill-inherited').output.includes('Source: inherited:base'))
  assert(toolValue(skillRows, 'skill-inherited').output.includes('INHERITED-FULL-ENTRY'))
  assert(toolValue(skillRows, 'skill-global').output.includes('GLOBAL-ENTRY'))
  assert(toolValue(skillRows, 'skill-boundary').error)
  assert(toolValue(skillRows, 'skill-big').output.includes('resource listing truncated'))
  assert.equal(toolValue(skillRows, 'skill-big').output.split('\n').filter(line => line.startsWith('- resources/')).length, 200)
  assert(toolValue(skillRows, 'read-inherited').output.startsWith('INHERITED-RESOURCE\n---\n'))
  assert(toolValue(skillRows, 'read-global').output.startsWith('GLOBAL-RESOURCE\n---\n')); assert(toolValue(skillRows, 'outside-write').error)
  assert(toolValue(skillRows, 'read-large').output.includes('middle omitted')); assert(toolValue(skillRows, 'read-large').output.length < 13000)
  for (const id of ['read-link', 'read-pipe', 'read-device']) assert(toolValue(skillRows, id).error, id)
  assert.equal(await snapshot('leaf/main'), initial, 'Skill load does not rewrite the stored catalog')
  assert.equal((await readFile(join(agentDir('leaf'), 'memory', 'MEMORY.md'), 'utf8')), 'LEAF-V1', 'Inherited directories are not copied')

  // Held real request remains frozen; new live skill list sees filesystem changes, same-marker prompt does not.
  const heldKnowledge = signal(); holds.push(heldKnowledge)
  plans.get('leaf/main').push(async body => { assert.equal(prompt(body), initial); await heldKnowledge.promise; return [text('FROZEN-DONE')] })
  await send('leaf/main', 'FROZEN'); await until(() => counts.get('leaf/main') === 4, 'held knowledge request')
  await writeFile(join(agentDir('base'), 'memory', 'MEMORY.md'), 'BASE-V2')
  await skill('leaf', 'shared', 'LEAF-SHARED-V2', 'LOCAL-FULL-ENTRY-V2')
  await page.evaluate(() => { location.hash = '#architecture' })
  await page.waitForSelector('.foxwarm-architecture-surface-tab')
  await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Agents').click())
  await page.waitForSelector('[data-architecture-agent-id="leaf"]')
  await page.click('[data-architecture-agent-id="leaf"]')
  await page.waitForSelector('[data-architecture-agent-inspector-id="leaf"]')
  await page.select('[data-architecture-agent-inspector-id="leaf"] select', 'base')
  await page.evaluate(() => [...document.querySelectorAll('[data-architecture-agent-inspector-id="leaf"] button')].find(button => button.textContent.includes('Save agent settings')).click())
  await until(async () => (await request('GET', '/api/agents')).body.agents.find(agent => agent.id === 'leaf').inherit === 'base', 'original Architecture inherit PUT')
  assert.equal(await snapshot('leaf/main'), initial); heldKnowledge.release(); await final('leaf/main', 'FROZEN-DONE')
  await turn('leaf/main', 'REUSE', body => { assert.equal(prompt(body), initial); return [call('live-list', 'skill', { action: 'list' })] })
  assert(toolValue(await history('leaf/main'), 'live-list').output.includes('LEAF-SHARED-V2'))
  assert.equal(await snapshot('leaf/main'), initial)

  // Fresh children use their owning Agent's current graph, not the parent's captured old prefix.
  plans.set('leaf/kid', [body => { assert(prompt(body).includes('BASE-V2') && !prompt(body).includes('MIDDLE-V1')); return [text('CHILD-LEAF-DONE')] }])
  plans.get('leaf/main').push([call('child-leaf', 'create_child_session', { suffix: 'kid', message: 'OWNING-KNOWLEDGE', afterSend: 'finish' })])
  await send('leaf/main', 'CHILD-LEAF'); await final('leaf/kid', 'CHILD-LEAF-DONE'); await idle('leaf/main')
  plans.set('base/cross', [body => { assert(prompt(body).includes('BASE-V2') && !prompt(body).includes('LEAF-V1') && !prompt(body).includes('TARGET-LEAF-ONLY')); return [text('CHILD-BASE-DONE')] }])
  plans.get('leaf/main').push([call('child-base', 'create_child_session', { agentName: 'base', suffix: 'cross', message: 'CROSS-KNOWLEDGE', afterSend: 'finish' })])
  await send('leaf/main', 'CHILD-BASE'); await final('base/cross', 'CHILD-BASE-DONE'); await idle('leaf/main')
  await turn('leaf/main', 'MODEL-AGENT', [call('new-agent', 'create_agent', { agentName: 'model-made', inherit: 'base', createMainSession: false })])
  assert.equal((await request('GET', '/api/agents')).body.agents.find(agent => agent.id === 'model-made').inherit, 'base')

  // Explicit refresh keeps recorded A; the next real B request rebuilds strictly using B conditions.
  assert.equal((await request('POST', `${path('leaf/main')}/model`, { model: 'b/two' })).status, 200)
  await refresh('leaf/main'); const refreshedA = await snapshot('leaf/main')
  assert(refreshedA.includes('BASE-V2') && !refreshedA.includes('MIDDLE-V1') && !refreshedA.includes('ONLY-B'))
  await turn('leaf/main', 'ACTUAL-B', body => { assert.equal(body.model, 'two'); assert(prompt(body).includes('ONLY-B')); return [text('B-OBSERVED')] })
  const refreshedB = await snapshot('leaf/main'); assert(refreshedB.includes('ONLY-B'))
  const oldSuccess = await create('leaf', 'old-success'); const oldSuccessBefore = await snapshot(oldSuccess)
  const old = await create('leaf', 'old'); const oldBefore = await snapshot(old)
  const control = await create('base', 'control'); const unrelated = await create('middle', 'unrelated')
  // middle still inherits base, so use an Agent outside the graph for the unaffected owner.
  assert.equal((await request('POST', '/api/agents', { agentId: 'outside' })).status, 201); plans.set('outside/main', [])
  const outsideBefore = await snapshot('outside/main')
  await writeFile(join(workRoot, 'memory', 'MEMORY.md'), 'MAIN-KNOWLEDGE')
  const unchangedBeforeRestart = await snapshot('leaf/main')
  await stopHost()
  // Offline owned fixture data, not fabricated running internal state: force the source inactivity predicate.
  const oldPath = join(dataRoot, 'state', 'sessions', old + '.json'); const oldJson = JSON.parse(await readFile(oldPath, 'utf8'))
  oldJson.meta.lastMessageTime = Date.now() - 2 * 60 * 60 * 1000; await writeFile(oldPath, JSON.stringify(oldJson))
  const oldSuccessPath = join(dataRoot, 'state', 'sessions', oldSuccess + '.json'); const oldSuccessJson = JSON.parse(await readFile(oldSuccessPath, 'utf8'))
  oldSuccessJson.meta.lastMessageTime = Date.now() - 2 * 60 * 60 * 1000; await writeFile(oldSuccessPath, JSON.stringify(oldSuccessJson))
  // Read-old cycle includes one missing directory; mutation remains separately validated.
  const catalogPath = join(dataRoot, 'state', 'agents.json'); const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  catalog.metadata.base = { inherit: 'ghost' }; catalog.metadata.ghost = { inherit: 'base' }; await writeFile(catalogPath, JSON.stringify(catalog))
  host = await startHost(); secondPid = host.child.pid; assert.notEqual(firstPid, secondPid)
  const readOld = (await request('GET', '/api/agents')).body.agents.find(agent => agent.id === 'leaf')
  assert.deepEqual(readOld.inheritanceChain, ['ghost', 'base', 'leaf'])
  await turn('leaf/main', 'RESTART-REUSE', body => { assert.equal(prompt(body), unchangedBeforeRestart); return [text('UNCHANGED-RESTART')] })
  assert.equal((await request('PUT', '/api/agents/base', { inheritAgent: null, isolatedNode: '' })).status, 200)
  assert.equal((await request('PUT', '/api/agents/base', { inheritAgent: 'missing', isolatedNode: null })).status, 400)
  await turn(control, 'REFRESH-RECENT', [call('refresh-chain', 'set_agent_inherit', { agentName: 'base', inheritAgentName: 'main', refreshSnapshots: true })])
  const result = JSON.parse(toolValue(await history(control), 'refresh-chain').output)
  assert(result.affectedSessions.includes('leaf/main') && result.affectedSessions.includes(unrelated)); assert(!result.affectedSessions.includes(old) && !result.affectedSessions.includes(oldSuccess) && !result.affectedSessions.includes('outside/main'))
  assert.equal(await snapshot(old), oldBefore); assert.equal(await snapshot('outside/main'), outsideBefore)
  assert((await snapshot('leaf/main')).includes('MAIN-KNOWLEDGE')); assert((await snapshot('leaf/main')).includes('ONLY-B'), 'Recent refresh uses recorded B')

  assert.equal(await snapshot(oldSuccess), oldSuccessBefore)
  await turn(oldSuccess, 'STALE-SUCCESS', async body => {
    assert(prompt(body).includes('MAIN-KNOWLEDGE') && !prompt(body).includes('ONLY-B'))
    await writeFile(join(workRoot, 'memory', 'MEMORY.md'), 'MAIN-KNOWLEDGE\nMID-TURN-NEW')
    return [call('stale-live-list', 'skill', { action: 'list' })]
  }, body => { assert(prompt(body).includes('MAIN-KNOWLEDGE') && !prompt(body).includes('MID-TURN-NEW')); return [text('ONCE-PER-LOGICAL-TURN')] })
  assert((await snapshot(oldSuccess)).includes('MAIN-KNOWLEDGE') && !(await snapshot(oldSuccess)).includes('MID-TURN-NEW'))

  // Stale refresh failure is observable but source-like continuation reuses old A; explicit refresh then succeeds.
  const faults = join(dataRoot, 'state', 'experiment-faults'); await mkdir(faults, { recursive: true })
  await writeFile(join(faults, 'id_' + Buffer.from(old).toString('base64url') + '.snapshot-before-rename'), 'fail')
  await turn(old, 'STALE-FAIL', body => { assert.equal(prompt(body), oldBefore); return [text('STALE-CONTINUED')] })
  const warned = (await request('GET', `${path(old)}/state`)).body.session
  assert(warned.snapshotRefreshWarning && warned.bestEffortFailureCount > 0); assert.equal(await snapshot(old), oldBefore)
  await refresh(old); assert((await snapshot(old)).includes('MAIN-KNOWLEDGE'))

  // Actual changed leaf failure still prevents provider send despite stale best-effort being a different path.
  assert.equal((await request('POST', `${path(old)}/model`, { model: 'b/two' })).status, 200)
  await writeFile(join(faults, 'id_' + Buffer.from(old).toString('base64url') + '.snapshot-before-rename'), 'fail')
  const priorRequests = counts.get(old); await send(old, 'STRICT-MODEL-FAIL')
  await until(async () => (await request('GET', `${path(old)}/state`)).body.session.failureCount > 0, 'strict actual leaf failure')
  await idle(old); assert.equal(counts.get(old), priorRequests); assert(!(await snapshot(old)).includes('ONLY-B'))
  plans.get(old).push(body => { assert.equal(body.model, 'two'); assert(prompt(body).includes('ONLY-B')); return [text('STRICT-RECOVERED')] })
  assert.equal((await command(old, '/continue')).status, 200); await final(old, 'STRICT-RECOVERED')

  // Live foreign-Agent skill view is knowledge selection, not inherited workspace/tool access.
  await turn('leaf/main', 'FOREIGN-SKILLS', [call('foreign-list', 'skill', { action: 'list', agentName: 'base' })])
  assert(toolValue(await history('leaf/main'), 'foreign-list').output.includes('BASE-SHARED'))
  assert(!toolValue(await history('leaf/main'), 'foreign-list').output.includes('LEAF-SHARED'))
  assert.equal(errors.length, 0, errors.join('\n'))
  const archived = JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("select session_id,count(*) from archive_messages group by session_id").fetchall()))', join(dataRoot, 'state', 'archive-store.sqlite')], { encoding: 'utf8' }))
  for (const [id, count] of archived) assert.equal((await history(id)).length, count, id)
  await stopHost()
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid, requests: requests.length, inheritedOrder: true, skillsPrecedence: true,
    sourceBoundaryResources: true, absoluteResourceRead: true, originalArchitecture: true, recordedIdentity: true,
    metadataOnlyReuse: true, freshOwningChild: true, readOldCycleMissing: true, recentRefresh: true, staleFailureContinues: true,
    actualLeafStrictFailure: true, archiveRows: archived.reduce((sum, row) => sum + row[1], 0) }))
} finally {
  for (const hold of holds) hold.release()
  await browser?.close().catch(() => {})
  if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(5000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  console.log(JSON.stringify({ root, firstPid, secondPid: host?.child.pid }))
  await rm(root, { recursive: true, force: true })
}
