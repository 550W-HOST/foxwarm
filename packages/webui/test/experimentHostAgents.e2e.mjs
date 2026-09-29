#!/usr/bin/env node
// One owned localhost original-Chat Agent-memory/child/result workflow with clean restart.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-agents-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(root, 'work')
const apiToken = 'synthetic-agents-api-secret'; const providerToken = 'synthetic-agents-provider-secret'
const dll = process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const errors = []; const requests = []; const counts = new Map()
const sleep = ms => new Promise(done => setTimeout(done, ms))
let provider, host, browser, heldParent, releaseParent, firstPid, parentId, betaId, childId, secondId, legacyId
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(40) }
  throw new Error(`Timed out waiting for ${label}; ${JSON.stringify({ errors, requests: requests.slice(-5), host: host?.output })}`)
}
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const chosen = server.address().port; await new Promise(done => server.close(done)); return chosen
}
function event(res, output) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 100, output_tokens: 15 } } })}\n\n`)
}
const text = value => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const valueOf = (rows, id) => rows.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const idFrom = body => {
  const content = body.input.filter(item => item.type === 'message').flatMap(item => item.content || []).map(item => item.text || '').join('\n')
  return /currentSessionId="([^"]+)"/.exec(content)?.[1]
}
const userFrom = body => body.input.filter(item => item.type === 'message' && item.role === 'user').at(-1)
  ?.content?.map(item => item.text || '').join('\n') || ''
try {
  await mkdir(dataRoot); await mkdir(workRoot)
  await mkdir(join(workRoot, 'agents'))
  await mkdir(join(workRoot, 'memory'))
  await writeFile(join(workRoot, 'agents', '00_SYSTEM.md'), 'FRAME-SHARED\n<foxwarm-if model-id="local-b/two">\nFRAME-B-ONLY\n</foxwarm-if>\n')
  await writeFile(join(workRoot, 'memory', 'MEMORY.md'), 'LEGACY-MAIN-MEMORY')
  const modelsFile = join(root, 'models.json')
  await writeFile(modelsFile, JSON.stringify({ default: 'local-a/one', providers: {
    'local-a': { providerType: 'openai', baseUrl: 'http://127.0.0.1:REPLACE', apiKeyEnv: 'LOCAL_A_SECRET',
      contextLimit: 25000, effort: { allowed: ['none', 'low'], default: 'low' }, models: [{ id: 'one' }] },
    'local-b': { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:REPLACE', apiKeyEnv: 'LOCAL_B_SECRET',
      contextLimit: 25000, effort: { allowed: ['none', 'low'], default: 'none' }, models: [{ id: 'two' }] },
  } }))
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.url, '/responses')
      assert.equal(req.headers.authorization, `Bearer ${providerToken}`)
      assert.equal(body.tools.length, 13)
      const id = idFrom(body); const latest = userFrom(body)
      assert(id, 'Canonical Session identity must reach the actual provider request')
      const count = (counts.get(id) || 0) + 1; counts.set(id, count)
      const snapshot = body.instructions || ''
      assert(snapshot.includes('EXPLICIT-BASE-INSTRUCTIONS'))
      assert(snapshot.includes('FRAME-SHARED'))
      if (id.startsWith('beta/')) {
        assert(snapshot.includes('BETA-'), `${id} missing beta memory`)
        assert(!snapshot.includes('ALPHA-V1'), `${id} inherited another Agent memory`)
      } else if (id.startsWith('alpha/')) {
        assert(snapshot.includes('ALPHA-V1'))
        assert(!snapshot.includes('BETA-V1'))
      } else if (id.startsWith('gamma/')) {
        assert(snapshot.includes('agent_folder:') && snapshot.includes('/agents/gamma'))
        assert(!snapshot.includes('LEGACY-MAIN-MEMORY') && !snapshot.includes('BETA-V1'))
      } else assert(snapshot.includes('LEGACY-MAIN-MEMORY'))
      requests.push({ id, latest: latest.slice(0, 110), model: body.model, instructions: snapshot })
      const previousCalls = body.input.filter(item => item.type === 'function_call')
      let output
      if (latest.includes('LEGACY-ROOT'))
        output = previousCalls.some(item => item.call_id === 'legacy-pwd') ? [text('LEGACY-DONE')] :
          [call('legacy-pwd', 'exec', { command: 'pwd', timeout: 2 })]
      else if (latest.includes('LEGACY-CHILD'))
        output = previousCalls.some(item => item.call_id === 'legacy-child-pwd') ? [text('LEGACY-CHILD-DONE')] :
          [call('legacy-child-pwd', 'exec', { command: 'pwd', timeout: 2 })]
      else if (latest.includes('LITERAL-PERCENT')) output = [text('LITERAL-DONE')]
      else if (latest.includes('LEGACY-POSTRENAME')) output = [text('LEGACY-POSTRENAME-DONE')]
      else if (latest.includes('MODEL-CATALOG')) {
        if (!previousCalls.some(item => item.call_id === 'model-create-agent'))
          output = [call('model-create-agent', 'create_agent', { agentName: 'gamma', createMainSession: false })]
        else if (!previousCalls.some(item => item.call_id === 'model-create-session'))
          output = [call('model-create-session', 'create_session', {
            agentName: 'gamma', sessionName: 'main', forceModel: { modelId: 'local-b/two' },
          })]
        else output = [text('MODEL-CATALOG-DONE')]
      } else if (latest.includes('GAMMA-WORK')) output = previousCalls.some(item => item.call_id === 'gamma-exec')
        ? [text('GAMMA-WORK-DONE')] : [call('gamma-write', 'write', { filePath: 'result.txt', content: 'GAMMA-OWNED' }),
          call('gamma-exec', 'exec', { command: 'pwd', timeout: 2 })]
      else if (latest.includes('ALPHA-DELEGATE')) {
        if (!previousCalls.some(item => item.call_id === 'spawn'))
          output = [call('spawn', 'create_child_session', {
            suffix: 'probe', agentName: 'beta', message: 'CHILD-TASK',
            forceModel: { modelId: 'local-b/two', effort: 'low' }, afterSend: 'continue',
          })]
        else {
          heldParent = true
          await new Promise(done => { releaseParent = done })
          output = [text('PARENT-HELD-COMPLETED')]
        }
      } else if (latest.includes('CHILD-REPORT')) output = [text('PARENT-GOT-REPORT')]
      else if (latest.includes('CHILD-TASK')) {
        if (!previousCalls.some(item => item.call_id === 'child-read'))
          output = [call('child-read', 'read', { filePath: 'memory/MEMORY.md' }),
            call('child-write', 'write', { filePath: 'child-work.txt', content: 'BETA-WORK' }),
            call('child-exec', 'exec', { command: 'pwd', timeout: 2 })]
        else output = [call('report', 'send_to_session', {
          sessionId: '<parent>', message: 'CHILD-REPORT: BETA-WORK', afterSend: 'finish',
        }), call('child-error', 'nonexistent_tool', {})]
      } else if (latest.includes('ALPHA-SECOND'))
        output = previousCalls.some(item => item.call_id === 'second-pwd') ? [text('SECOND-DONE')] :
          [call('second-pwd', 'exec', { command: 'pwd', timeout: 2 })]
      else if (latest.includes('ALPHA-SEND-OTHER')) output = [call('other-send', 'send_to_session', {
        sessionId: betaId, message: 'BETA-NONPARENT', afterSend: 'finish',
      }), call('other-error', 'nonexistent_tool', {})]
      else if (latest.includes('BETA-NONPARENT')) output = [text('BETA-RECEIVED-NONPARENT')]
      else if (latest.includes('BETA-SAME')) output = [text('BETA-SAME-DONE')]
      else if (latest.includes('BETA-REFRESH')) output = [text('BETA-REFRESH-DONE')]
      else if (latest.includes('BETA-MODEL-REFRESH')) output = previousCalls.some(item => item.call_id === 'refresh-self')
        ? [text('BETA-MODEL-REFRESH-DONE')] : [call('refresh-self', 'refresh_session_snapshot', {})]
      else if (latest.includes('BETA-LEAF')) output = [text('BETA-LEAF-DONE')]
      else if (latest.includes('SNAPSHOT-RECOVER')) output = [text('SNAPSHOT-RECOVER-DONE')]
      else output = [text(`UNEXPECTED: ${latest.slice(0, 100)}`)]
      event(res, output)
    } catch (error) { errors.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const providerPort = provider.address().port; const hostPort = await port()
  const contents = JSON.parse(await readFile(modelsFile, 'utf8'))
  contents.providers['local-a'].baseUrl = `http://127.0.0.1:${providerPort}`
  contents.providers['local-b'].baseUrl = `http://127.0.0.1:${providerPort}`
  await writeFile(modelsFile, JSON.stringify(contents))
  async function request(method, path, value) {
    const response = await fetch(`http://127.0.0.1:${hostPort}${path}`, { method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000) })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  async function startHost() {
    const child = spawn(dotnet, [dll], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot, FOXWARM_EXPERIMENT_TOOL_ROOT: workRoot,
      FOXWARM_EXPERIMENT_MODELS_FILE: modelsFile, FOXWARM_EXPERIMENT_PORT: String(hostPort),
      FOXWARM_EXPERIMENT_API_TOKEN: apiToken, FOXWARM_EXPERIMENT_INSTRUCTIONS: 'EXPLICIT-BASE-INSTRUCTIONS',
      LOCAL_A_SECRET: providerToken, LOCAL_B_SECRET: providerToken,
      FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist'),
    } })
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-18000) })
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${output}`)
      try { return (await request('GET', '/health')).status === 200 } catch { return false }
    }, 'host ready', 12000)
    return { child, get output() { return output } }
  }
  async function stopHost() {
    assert.equal((await request('POST', '/admin/shutdown')).status, 202)
    const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([status]) => status), sleep(16000).then(() => 'timeout')])
    assert.equal(code, 0, host.output)
  }
  async function send(id, textValue) {
    assert.equal((await request('POST', `/api/sessions/${encodeURIComponent(id)}/message`, { text: textValue })).status, 202)
  }
  async function history(id) {
    const response = await request('GET', `/api/sessions/${encodeURIComponent(id)}/history`)
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.messages
  }
  async function finished(id, marker) {
    await until(async () => (await history(id)).some(row => row.parts?.some(part => part.text?.includes(marker))), marker)
  }
  host = await startHost(); firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load' })
  await page.waitForSelector('#experiment-token'); await page.type('#experiment-token', apiToken)
  await page.click('button[type="submit"]'); await page.waitForSelector('input[aria-label="New agent name"]')
  async function browserCreateAgent(name, memoryText) {
    await page.type('input[aria-label="New agent name"]', name)
    await page.type('input[aria-label="Agent memory"]', memoryText)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'Create agent')?.click())
    await page.waitForFunction(value => [...document.querySelectorAll('select[aria-label="Agent"] option')]
      .some(item => item.value === value), {}, name)
    return `${name}/main`
  }
  parentId = await browserCreateAgent('alpha', 'ALPHA-V1')
  betaId = await browserCreateAgent('beta', 'BETA-V1')
  await writeFile(join(workRoot, 'agents', 'beta', 'memory', 'notes.md'),
    '---\ninclude-session: beta/probe\n---\nBETA-CHILD-ONLY\n')
  await writeFile(join(workRoot, 'agents', 'beta', 'memory', 'unknown.md'),
    '---\nunknown-header: preserved-as-ordinary-frontmatter\n---\nUNKNOWN-HEADER-VISIBLE\n')
  assert.deepEqual((await request('GET', '/api/agents')).body.agents, ['alpha', 'beta', 'main'])
  assert.equal((await request('GET', '/api/sessions/main/state')).status, 404, 'No fabricated main Session')
  legacyId = (await request('POST', '/api/sessions')).body.sessionId
  assert(legacyId.startsWith('s_')); await send(legacyId, 'LEGACY-ROOT'); await finished(legacyId, 'LEGACY-DONE')
  assert.match(valueOf(await history(legacyId), 'legacy-pwd').output, new RegExp(workRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const legacyChild = (await request('POST', `/api/sessions/${encodeURIComponent(legacyId)}/children`,
    { suffix: 'legacykid', message: 'LEGACY-CHILD' })).body.sessionId
  assert.equal(legacyChild, `${legacyId}_legacykid`)
  await finished(legacyChild, 'LEGACY-CHILD-DONE')
  assert.match(valueOf(await history(legacyChild), 'legacy-child-pwd').output,
    new RegExp(workRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent(legacyChild)}/state`)).body.session.parentSessionId, legacyId)
  await send(legacyId, 'MODEL-CATALOG'); await finished(legacyId, 'MODEL-CATALOG-DONE')
  assert.deepEqual((await request('GET', '/api/agents')).body.agents, ['alpha', 'beta', 'gamma', 'main'])
  assert.equal((await request('GET', '/api/sessions/gamma%2Fmain/state')).body.session.agent, 'gamma')
  assert.equal((await request('GET', '/api/sessions/gamma%2Fmain/state')).body.session.parentSessionId, null)
  await send('gamma/main', 'GAMMA-WORK'); await finished('gamma/main', 'GAMMA-WORK-DONE')
  assert.equal(await readFile(join(workRoot, 'agents', 'gamma', 'result.txt'), 'utf8'), 'GAMMA-OWNED')
  assert.match(valueOf(await history('gamma/main'), 'gamma-exec').output, /agents\/gamma/)
  const literalId = 'literal%2Fname'
  assert.equal((await request('POST', '/api/sessions', { agentName: 'main', sessionName: literalId })).body.sessionId, literalId)
  await send(literalId, 'LITERAL-PERCENT'); await finished(literalId, 'LITERAL-DONE')
  await send(parentId, 'ALPHA-DELEGATE')
  await until(() => heldParent && releaseParent && (counts.get(parentId) || 0) === 2, 'held parent provider')
  childId = 'beta/probe'; await until(async () => (await history(childId)).some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'report')),
    'child report and error batch')
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent(parentId)}/state`)).body.session.busy, true)
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent(parentId)}/state`)).body.session.queueCount, 1)
  assert.equal(counts.get(parentId), 2, 'parent must not start second processor while provider is held')
  const childRows = await history(childId)
  assert(childRows.some(row => row.parts?.some(part => part.functionCall?.id === 'child-error')))
  assert(childRows.some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'child-error')))
  assert.equal((await readFile(join(workRoot, 'agents', 'beta', 'child-work.txt'), 'utf8')), 'BETA-WORK')
  assert.match(valueOf(childRows, 'child-exec').output, /agents\/beta/)
  assert.match(valueOf(childRows, 'child-read').output, /BETA-V1/)
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent(childId)}/state`)).body.session.parentSessionId, parentId)
  assert(requests.some(item => item.id === childId && item.instructions.includes('BETA-CHILD-ONLY')))
  assert(requests.some(item => item.id === childId && item.instructions.includes('UNKNOWN-HEADER-VISIBLE')))
  const childAuthority = JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', 'beta', 'probe.json'), 'utf8'))
  assert.equal(childAuthority.model, 'local-b/two'); assert.equal(childAuthority.effort, 'low')
  assert.equal(childAuthority.childModelDefault, undefined)
  assert.equal(childAuthority.childEffortDefault, undefined)
  await page.select('select[aria-label="Agent"]', 'alpha')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'New session')?.click())
  await until(async () => (await request('GET', '/api/sessions')).body.sessions.find(item => item.agent === 'alpha' && item.id !== parentId)?.id,
    'second alpha Session')
  secondId = (await request('GET', '/api/sessions')).body.sessions.find(item => item.agent === 'alpha' && item.id !== parentId).id
  await send(secondId, 'ALPHA-SECOND'); await finished(secondId, 'SECOND-DONE')
  assert.match(valueOf(await history(secondId), 'second-pwd').output, /agents\/alpha/)
  assert.equal(counts.get(parentId), 2)
  releaseParent(); await finished(parentId, 'PARENT-GOT-REPORT')
  assert.equal(counts.get(parentId), 3)
  await page.goto(`http://127.0.0.1:${hostPort}/?sessionId=${encodeURIComponent(parentId)}`, { waitUntil: 'load' })
  await page.waitForFunction(value => document.querySelector('select[aria-label="Session"]')?.value === value, {}, parentId)
  await page.type('input[aria-label="Child suffix"]', 'browser')
  await page.select('select[aria-label="Child agent"]', 'beta')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'Create child')?.click())
  await until(async () => (await request('GET', `/api/sessions/${encodeURIComponent('beta/browser')}/state`)).status === 200,
    'browser-created cross-Agent child')
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent('beta/browser')}/state`)).body.session.parentSessionId, parentId)
  await page.waitForFunction(() => document.querySelector('select[aria-label="Session"]')?.value === 'beta/browser')
  await page.goto(`http://127.0.0.1:${hostPort}/?sessionId=${encodeURIComponent(childId)}`, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-root')
  await page.waitForFunction(value => document.querySelector('select[aria-label="Session"]')?.value === value, {}, childId)
  assert(await page.evaluate(() => [...document.querySelectorAll('button')]
    .some(item => item.textContent?.includes('Parent: alpha/main'))))
  // No automatic refresh at the same concrete identity, then explicit strict owner refresh.
  await writeFile(join(workRoot, 'agents', 'beta', 'memory', 'MEMORY.md'), 'BETA-V2')
  await send(childId, 'BETA-SAME'); await finished(childId, 'BETA-SAME-DONE')
  const same = requests.filter(item => item.id === childId && item.latest.includes('BETA-SAME')).at(-1)
  assert(same.instructions.includes('BETA-V1') && !same.instructions.includes('BETA-V2'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'Refresh memory')?.click())
  await until(async () => JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', 'beta', 'probe.json'), 'utf8'))
    .persistentMemorySnapshot.includes('BETA-V2'), 'strict beta snapshot refresh')
  await send(childId, 'BETA-REFRESH'); await finished(childId, 'BETA-REFRESH-DONE')
  assert(requests.filter(item => item.id === childId && item.latest.includes('BETA-REFRESH')).at(-1).instructions.includes('BETA-V2'))
  await writeFile(join(workRoot, 'agents', 'beta', 'memory', 'MEMORY.md'), 'BETA-V3')
  await send(childId, 'BETA-MODEL-REFRESH'); await finished(childId, 'BETA-MODEL-REFRESH-DONE')
  assert(requests.filter(item => item.id === childId && item.latest.includes('BETA-MODEL-REFRESH')).at(-1).instructions.includes('BETA-V3'))
  assert(JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', 'beta', 'probe.json'), 'utf8'))
    .persistentMemorySnapshot.includes('BETA-V3'))
  assert.equal((await request('POST', `/api/sessions/${encodeURIComponent(childId)}/model`, { model: 'local-a/one', effort: null })).status, 200)
  await send(childId, 'BETA-LEAF'); await finished(childId, 'BETA-LEAF-DONE')
  const leaf = requests.filter(item => item.id === childId && item.latest.includes('BETA-LEAF')).at(-1)
  assert(leaf.instructions.includes('<foxwarm-current-model model-id="local-a/one" />'))
  assert(leaf.instructions.includes('BETA-V3') && !leaf.instructions.includes('FRAME-B-ONLY'))
  // Other-Agent non-parent delivery, plus finish after sibling tool error in the same paired row.
  await send(secondId, 'ALPHA-SEND-OTHER')
  await until(async () => (await history(secondId)).some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'other-error')),
    'other-Agent sibling error paired after finish')
  await finished(betaId, 'BETA-RECEIVED-NONPARENT')
  assert.equal((await history(betaId)).flatMap(row => row.parts || []).filter(part => part.system?.includes('BETA-NONPARENT')).length, 1)
  assert.equal(requests.filter(item => item.id === secondId && item.latest.includes('ALPHA-SEND-OTHER')).length, 1,
    'finish must not send another provider request')
  const firstSnapshot = JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', 'alpha', secondId.split('/')[1] + '.json'), 'utf8'))
    .persistentMemorySnapshot
  assert.equal((await request('POST', `/api/sessions/${encodeURIComponent(secondId)}/model`, { model: 'local-b/two', effort: null })).status, 200)
  const marker = 'id_' + Buffer.from(secondId).toString('base64url') + '.snapshot-before-rename'
  await mkdir(join(dataRoot, 'state', 'experiment-faults'), { recursive: true })
  await writeFile(join(dataRoot, 'state', 'experiment-faults', marker), 'fail exactly the owner memory snapshot rename')
  const beforeFault = requests.filter(item => item.id === secondId).length
  await send(secondId, 'SNAPSHOT-FAIL')
  await until(async () => (await request('GET', `/api/sessions/${encodeURIComponent(secondId)}/state`)).body.session.failureCount > 0,
    'observed strict memory save failure')
  assert.equal(requests.filter(item => item.id === secondId).length, beforeFault, 'no provider after failed strict snapshot save')
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', 'alpha', secondId.split('/')[1] + '.json'), 'utf8'))
    .persistentMemorySnapshot, firstSnapshot, 'pre-rename failure cannot publish a matching hot marker')
  await send(secondId, 'SNAPSHOT-RECOVER'); await finished(secondId, 'SNAPSHOT-RECOVER-DONE')
  assert(requests.filter(item => item.id === secondId && item.latest.includes('SNAPSHOT-RECOVER')).at(-1)
    .instructions.includes('<foxwarm-current-model model-id="local-b/two" />'))
  // Existing bare/{} legacy creation: a post-rename fault reports the committed ID
  // and retains its live owner even though the final directory sync failed.
  const archiveRowsFor = id => Number(execFileSync('python3', ['-c',
    'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT COUNT(*) FROM archive_messages WHERE session_id=?", (sys.argv[2],)).fetchone()[0])',
    join(dataRoot, 'state', 'archive-store.sqlite'), id], { encoding: 'utf8' }).trim())
  await writeFile(join(dataRoot, 'state', 'experiment-faults', 'legacy-create-after-rename'), 'one injected legacy create')
  const partial = await request('POST', '/api/sessions', {})
  assert.equal(partial.status, 409, JSON.stringify(partial.body))
  const committedLegacyId = partial.body.sessionId
  assert.match(committedLegacyId, /^s_[a-f0-9]{32}$/)
  assert.equal(partial.body.committed, true)
  assert.equal((await request('GET', `/api/sessions/${committedLegacyId}/state`)).status, 200)
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'state', 'sessions', committedLegacyId + '.json'), 'utf8')).history.length, 0)
  assert.equal(archiveRowsFor(committedLegacyId), 0)
  await send(committedLegacyId, 'LEGACY-POSTRENAME'); await finished(committedLegacyId, 'LEGACY-POSTRENAME-DONE')
  const committedHistory = await history(committedLegacyId)
  const rowsBeforeRestart = archiveRowsFor(committedLegacyId)
  assert.equal(rowsBeforeRestart, committedHistory.length)
  const requestsBeforeRestart = requests.length
  await stopHost(); host = await startHost(); assert.notEqual(host.child.pid, firstPid)
  assert.deepEqual(await history(committedLegacyId), committedHistory)
  assert.equal(archiveRowsFor(committedLegacyId), rowsBeforeRestart)
  assert.equal(requests.length, requestsBeforeRestart)
  assert((await request('GET', '/api/agents')).body.agents.includes('beta'))
  assert.equal((await request('GET', `/api/sessions/${encodeURIComponent(childId)}/state`)).body.session.parentSessionId, parentId)
  assert((await readFile(join(dataRoot, 'state', 'sessions', 'beta', 'probe.json'), 'utf8')).includes('BETA-V3'))
  assert((await readFile(join(workRoot, 'agents', 'beta', 'child-work.txt'), 'utf8')).includes('BETA-WORK'))
  const archive = execFileSync('python3', ['-c', `import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute('SELECT session_id,agent,COUNT(*),MAX(seq) FROM archive_messages GROUP BY session_id,agent ORDER BY session_id').fetchall()))`, join(dataRoot, 'state', 'archive-store.sqlite')], { encoding: 'utf8' })
  const records = JSON.parse(archive)
  assert(records.some(row => row[0] === childId && row[1] === 'beta' && row[2] >= 7))
  assert(records.some(row => row[0] === parentId && row[1] === 'alpha' && row[2] >= 6), JSON.stringify(records))
  assert.equal(errors.length, 0, errors.join('\n'))
  await stopHost()
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid: host.child.pid, providerRequests: requests.length,
    parentRequests: counts.get(parentId), childRequests: counts.get(childId), agents: ['alpha', 'beta', 'gamma', 'main'],
    legacyId, committedLegacyId, parentId, childId, sameAgentSession: secondId,
    strictSnapshotFailure: true, legacyPostRenameFailure: true, memoryRefresh: true }))
} finally {
  try { releaseParent?.() } catch {}
  try { await browser?.close() } catch {}
  if (host?.child?.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(6000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  await rm(root, { recursive: true, force: true })
}
