// Real CLI screenshots through normal Source and C# Main model and canonical image owners.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name: name.startsWith('browse_') ? 'call_tool' : name, arguments: JSON.stringify(name.startsWith('browse_') ? { source: 'node', name, args } : args) })
const dll = resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')
for (const runtime of ['source', 'dotnet']) {
  const env = {}, fixture = await createHostFixture('browser-cli-' + runtime, { runtime, normalStartup: true, env })
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '', FOXWARM_BIND_ADDRESS: '127.0.0.1' })
  const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local browser</title><h1>Local browser fixture</h1>') })
  site.listen(0, '127.0.0.1'); await once(site, 'listening'); const origin = `http://127.0.0.1:${site.address().port}`
  const plans = new Map(), rounds = new Map(), requests = [], errors = [], processes = []
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
  const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'BROWSER-DONE-' + key }] }]
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw)
      const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...prompt.matchAll(/BROWSERCLI:([\w-]+)/g)].at(-1)?.[1]
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || final(key)
      requests.push({ key, body })
      for (const tool of output.filter(part => part.type === 'function_call')) assert((body.tools || []).some(def => def.type === 'function' && def.name === tool.name), 'ordinary advertised tool ' + tool.name)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: browser-cli-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, models: ['wire'] } } }))
  async function online() { return until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'browser-cli' && node.online), runtime + ' native Node online', 22000) }
  async function launch(extra) {
    const cwd = join(fixture.root, 'cli'), agents = join(cwd, 'agents')
    await mkdir(join(agents, 'main'), { recursive: true })
    for (const path of ['home', 'config', 'cache']) await mkdir(join(cwd, path), { recursive: true })
    const executable = process.env.FOXWARM_CLI_EXECUTABLE
    const child = spawn(executable || join(process.env.DOTNET_ROOT, 'dotnet'), [...(executable ? [] : [dll]), '--host', fixture.origin, '--no-local-trigger', '--credentials-file', join(cwd, 'credentials.json'), ...extra], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: agents, PUPPETEER_EXECUTABLE_PATH: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', HOME: join(cwd, 'home'), XDG_CONFIG_HOME: join(cwd, 'config'), XDG_CACHE_HOME: join(cwd, 'cache') }, stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = { child, output: '' }; processes.push(handle)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-20000) })
    return handle
  }
  async function stop(handle) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
    const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
    await Promise.race([exited, sleep(4000).then(() => handle.child.kill('SIGKILL'))]); await exited
  }
  async function turn(id, key, steps) {
    plans.set(key, steps); rounds.set(key, 0)
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'BROWSERCLI:' + key })
    assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
    return until(async () => {
      if (errors.length) throw new Error(errors.join('\n'))
      const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
      return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'BROWSER-DONE-' + key)) ? state : null
    }, runtime + ' model/file turn ' + key, 30000)
  }
  function good(state, id) { const result = pair(state, id); assert(result && !result.error, id + ': ' + JSON.stringify(result)); return result }
  try {
    await fixture.start()
    let cli = await launch(['--id', 'browser-cli', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()])
    const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'browser-cli'), 'ordinary pairing pending')
    assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    await online()
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'browser-cli-owner' })
    assert.equal(created.status, 200, JSON.stringify(created)); const id = created.body.sessionId
    let state = await turn(id, 'select', [[call('select', 'node', { action: 'select', nodeId: 'browser-cli' })]])
    good(state, 'select')
    await turn(id, 'discover', [[call('discover', 'search_tools', { query: 'browse_open', sources: ['node'], limit: 1 })]])
    let tabId, imageId
    state = await turn(id, 'browser', [[call('open', 'browse_open', { url: origin + '/local' })], async () => {
      tabId = good(await saved(id), 'open').tabId
      return [call('html', 'browse_get', { tabId }), call('screenshot', 'browse_get', { tabId, screenshot: true })]
    }, body => {
      const ids = []
      function collect(value) {
        if (typeof value === 'string') for (const match of value.matchAll(/\[IMAGE: id=("(?:\\.|[^"\\])*"|[^,\]\s]+)/g)) ids.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1])
        else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
      }
      collect(body.input); assert(ids.length > 0, JSON.stringify(body.input)); imageId = ids.at(-1)
      assert(JSON.stringify(body.input).includes('input_image'), 'screenshot enters the next real provider request')
      return [call('crop', 'image_crop', { id: imageId, x: 0, y: 0, width: 100, height: 80 }), call('export', 'image_write_to_file', { id: imageId, filePath: 'exported.png' })]
    }, () => [call('read-export', 'read', { filePath: 'exported.png' }), call('delivery', 'send_file', { filePath: 'exported.png' }), call('close', 'browse_close', { tabId })]])
    for (const name of ['open', 'html', 'screenshot', 'crop', 'export', 'read-export', 'delivery', 'close']) good(state, name)
    assert(good(state, 'html').content.includes('<h1>Local browser fixture</h1>'))
    const parts = state.history.flatMap(row => row.parts || []), images = parts.filter(part => part.inlineDataRef)
    const screenshot = images.find(part => part.toolUseId === 'screenshot' || part.tool_use_id === 'screenshot')
    assert(screenshot, 'canonical screenshot sibling with its actual tool owner')
    assert.equal(screenshot.inlineDataRef.imageId, imageId)
    assert(!JSON.stringify(state).includes('"inlineData":'), 'history stores references, not inline image authority')
    assert(!good(state, 'screenshot').inlineData)
    const blobId = screenshot.inlineDataRef.blobId, blob = await fetch(fixture.origin + '/api/blobs/' + blobId, { headers: { authorization: 'Bearer ' + fixture.token } })
    assert.equal(blob.status, 200)
    const png = Buffer.from(await blob.arrayBuffer()), exported = await readFile(join(fixture.root, 'cli/agents/main/exported.png'))
    const delivered = good(state, 'delivery').fileDelivery
    assert.equal(delivered.sourceNodeId, 'browser-cli'); assert.equal(delivered.downloadNodeId, 'master'); assert.equal(delivered.mimeType, 'image/png')
    assert.deepEqual(await readFile(delivered.downloadPath), png, 'actual Main-owned delivery payload')
    assert.deepEqual(exported, png); const meta = await sharp(png).metadata(); assert.equal(meta.width, 800); assert.equal(meta.height, 600)
    const history = await fixture.api('GET', route(id) + '/history')
    assert(!JSON.stringify(history.body).includes(png.toString('base64')))
    assert(JSON.stringify(history.body).includes(blobId))
    assert(!JSON.stringify(state).includes(png.toString('base64')))
    assert(images.some(part => part.toolUseId === 'read-export' || part.tool_use_id === 'read-export'), 'exported image is readable through the selected Node')
    // Restart only our owned Main. Its canonical image identity and bytes survive.
    await fixture.stop(); await fixture.start(); await online()
    state = await turn(id, 'persisted-image', [[call('persisted-export', 'image_write_to_file', { id: imageId, filePath: 'persisted.png' })]])
    good(state, 'persisted-export'); assert.deepEqual(await readFile(join(fixture.root, 'cli/agents/main/persisted.png')), png)
    assert.equal(errors.length, 0)
    console.log(JSON.stringify({ runtime, nativeCli: !!process.env.FOXWARM_CLI_EXECUTABLE, hostStarts: fixture.hostPids.length, modelRequests: requests.length, browserOpenHtmlScreenshot: true, nextPreparedRequest: true, canonicalHistory: true, cropReadExportDelivery: true, persistedImageExport: true }))
  } catch (error) { console.error(runtime, fixture.output, processes.map(process => process.output).join('\n')); throw error }
  finally {
    for (const process of processes) await stop(process)
    model.closeAllConnections(); await new Promise(done => model.close(done)); site.closeAllConnections(); await new Promise(done => site.close(done)); await fixture.cleanup()
  }
}
