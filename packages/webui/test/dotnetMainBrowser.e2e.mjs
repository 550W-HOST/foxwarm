// Main-hosted browser_* tools through normal model dispatch, discovery, authorization and the canonical image pipeline.
// A real headless Chromium is driven by the real packaged host under the installed node.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'
import { browserEnvironment } from '../../browser-host/test/fixture.mjs'
import { functionCall } from './ctlModelCalls.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const chromium = await browserEnvironment()
assert(chromium.available, 'A Chromium installation is required: ' + chromium.reason)

const names = ['browser_tabs', 'browser_open', 'browser_close', 'browser_navigate', 'browser_read', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll', 'browser_wait', 'browser_evaluate']
const call = functionCall
const tool = (id, name, args = {}, nodeId) => call(id, 'call_tool', { source: 'node', name, ...(nodeId ? { nodeId } : {}), args })

const env = {}, options = { runtime: 'dotnet', env }
const fixture = await createHostFixture('main-browser', options)
options.cwd = fixture.root
Object.assign(env, isolatedApplicationEnv(fixture.data), {
  FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '',
  HOME: join(fixture.root, 'home'), XDG_CONFIG_HOME: join(fixture.root, 'config'), XDG_CACHE_HOME: join(fixture.root, 'cache'),
  PUPPETEER_EXECUTABLE_PATH: chromium.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  PATH: process.env.PATH,
})
for (const path of ['home', 'config', 'cache']) await mkdir(join(fixture.root, path))

const effects = [], requests = [], errors = [], plans = new Map(), rounds = new Map()
const page = title => `<!doctype html><title>${title}</title><body style="margin:0;min-height:1800px"><h1>${title}</h1>
<input id="entry" aria-label="Entry" value="seed"><button id="go" onclick="window.clicked=(window.clicked||0)+1">Go</button>
<a id="link" href="/two">Next</a></body>`
const site = createServer((req, res) => {
  effects.push(req.url)
  res.setHeader('content-type', 'text/html')
  res.end(page(req.url === '/two' ? 'Two' : 'One'))
})
site.listen(0, '127.0.0.1'); await once(site, 'listening')
const origin = `http://127.0.0.1:${site.address().port}`

const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const good = (state, id) => { const value = pair(state, id); assert(value && !value.error, id + ': ' + JSON.stringify(value)); return value }
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MAIN-BROWSER-DONE-' + key }] }]
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/MAINBROWSER:([\w-]+)/g)].at(-1)?.[1]
    assert(!(body.tools || []).some(item => names.includes(item.name)), 'Node browser tools stay out of the default tool list')
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || final(key)
    requests.push({ key, body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')

const deniedPath = origin + '/denied'
await writeFile(join(fixture.data, 'state/tool-authorization.yaml'), `version: 1\nrules:\n- action: deny\n  tool: {source: node, name: browser_open}\n  args: {url: [${JSON.stringify(deniedPath)}]}\n`)
await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: main-browser-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, models: ['wire'] } } }))

async function create(name, agent = 'main') {
  const response = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name })
  assert.equal(response.status, 200, JSON.stringify(response)); return response.body.sessionId
}
async function turn(id, key, steps) {
  plans.set(key, steps); rounds.set(key, 0)
  const accepted = await fixture.api('POST', route(id) + '/message', { text: 'MAINBROWSER:' + key })
  assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
  return until(async () => {
    if (errors.length) throw new Error(errors.join('\n'))
    const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'MAIN-BROWSER-DONE-' + key)) ? state : null
  }, key, 60000)
}
let cli
async function launchRemote() {
  const cwd = join(fixture.root, 'cli'); await mkdir(cwd)
  cli = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll'), '--host', fixture.origin, '--no-local-trigger', '--id', 'remote', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim(), '--credentials-file', join(cwd, 'credentials.json')], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), PUPPETEER_EXECUTABLE_PATH: env.PUPPETEER_EXECUTABLE_PATH, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
  cli.stdout.resume(); cli.stderr.resume()
  const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'remote'), 'remote pairing')
  assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'remote' && node.online), 'remote online')
}
const collectImageIds = body => {
  const ids = []
  const walk = value => {
    if (typeof value === 'string') for (const match of value.matchAll(/\[IMAGE: id=("(?:\\.|[^"\\])*"|[^,\]\s]+)/g)) ids.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1])
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item)
  }
  walk(body.input); return ids
}

try {
  await fixture.start()
  const id = await create('main-browser'), second = await create('second-browser')

  // Discovery, then ordinary navigation, reading and forms through call_tool.
  let state = await turn(id, 'drive', [[
    call('discover', 'search_tools', { query: 'browser_open', sources: ['node'], nodeId: 'master', limit: 1 }),
    tool('empty', 'browser_tabs'),
    tool('open', 'browser_open', { url: origin + '/' }),
  ], async () => {
    const tabId = good(await saved(id), 'open').tabId
    return [
      tool('read', 'browser_read', { tabId }),
      tool('text', 'browser_read', { tabId, format: 'text' }),
      tool('fill', 'browser_fill', { tabId, selector: '#entry', text: 'replacement' }),
      tool('click', 'browser_click', { tabId, selector: '#go' }),
      tool('check', 'browser_evaluate', { tabId, code: '({value: document.querySelector("#entry").value, clicked: window.clicked})' }),
      tool('follow', 'browser_click', { tabId, selector: '#link' }),
      tool('tabs', 'browser_tabs'),
    ]
  }])
  assert.match(good(state, 'discover').output, /node:master\/browser_open/)
  assert.deepEqual(good(state, 'empty').tabs, [])
  const tabId = good(state, 'open').tabId
  assert.equal(good(state, 'open').title, 'One')
  assert(good(state, 'read').elements.some(item => item.label === 'Entry'))
  assert.match(JSON.stringify(good(state, 'text')), /One/)
  assert.equal(good(state, 'fill').filled, true)
  assert.deepEqual(good(state, 'check').result, { value: 'replacement', clicked: 1 })
  assert.equal(good(state, 'follow').navigated, true)
  assert.equal(good(state, 'follow').title, 'Two')
  assert.equal(good(state, 'tabs').tabs[0].url, origin + '/two')

  // Tabs belong to Main, not to a Session.
  state = await turn(second, 'shared', [[tool('shared-tabs', 'browser_tabs')]])
  assert.equal(good(state, 'shared-tabs').tabs.length, 1)

  // Policy decides before any page is opened; errors are ordinary tool errors.
  state = await turn(id, 'errors', [[
    tool('denied', 'browser_open', { url: deniedPath }),
    tool('scheme', 'browser_open', { url: 'file:///etc/hostname' }),
    tool('missing-tab', 'browser_read', { tabId: 999 }),
    tool('missing-element', 'browser_fill', { tabId, selector: '#absent', text: 'x' }),
    tool('js-error', 'browser_evaluate', { tabId, code: '(()=>{throw new Error("owned-js-error")})()' }),
  ]])
  for (const key of ['denied', 'scheme', 'missing-tab', 'missing-element', 'js-error']) assert(pair(state, key)?.error, key + ' is an ordinary tool error')
  assert(!effects.includes('/denied'))

  // A screenshot becomes a canonical image: next provider request, crop, export, delivery, history references.
  let imageId
  state = await turn(id, 'images', [[tool('screenshot', 'browser_screenshot', { tabId })], body => {
    const ids = collectImageIds(body)
    assert(ids.length, 'screenshot image identity reaches the model'); imageId = ids.at(-1)
    assert(JSON.stringify(body.input).includes('input_image'), 'real next provider request contains the screenshot')
    return [call('crop', 'image_crop', { id: imageId, x: 0, y: 0, width: 100, height: 80 }), call('export', 'image_write_to_file', { id: imageId, filePath: join(fixture.root, 'exported.png') })]
  }, () => [call('delivery', 'send_file', { filePath: join(fixture.root, 'exported.png') })]])
  for (const key of ['screenshot', 'crop', 'export', 'delivery']) good(state, key)
  const image = state.history.flatMap(row => row.parts || []).find(part => part.inlineDataRef && (part.toolUseId || part.tool_use_id) === 'screenshot')
  assert(image, 'screenshot sibling retains a durable image reference'); assert.equal(image.inlineDataRef.imageId, imageId)
  assert(!JSON.stringify(state).includes('"inlineData":'), 'history stores references, not inline image data')
  const blob = await fetch(fixture.origin + '/api/blobs/' + image.inlineDataRef.blobId, { headers: { authorization: 'Bearer ' + fixture.token } })
  assert.equal(blob.status, 200)
  const png = Buffer.from(await blob.arrayBuffer()), meta = await sharp(png).metadata()
  assert.equal(meta.format, 'png'); assert(meta.width > 0 && meta.height > 0)
  assert.deepEqual(await readFile(join(fixture.root, 'exported.png')), png)
  const delivery = good(state, 'delivery').fileDelivery
  assert.equal(delivery.sourceNodeId, 'master'); assert.equal(delivery.mimeType, 'image/png')

  // Programmatic callers receive the same structured result.
  state = await turn(id, 'script', [[call('script', 'run_script', { code: "value = call_tool('browser_tabs', {})\nreturn value" })]])
  assert.equal(good(state, 'script').result.tabs.length, 1)

  // A cancelled call never touches the page.
  state = await turn(id, 'cancel', [[call('cancel', 'call_tool', { source: 'node', name: 'browser_open', args: { url: origin + '/cancelled' }, __cancelTool: true })]])
  assert(pair(state, 'cancel').canceled); assert(!effects.includes('/cancelled'))

  // Closing the last tab leaves the host usable.
  state = await turn(second, 'close', [[tool('close', 'browser_close', { tabId }), tool('after-close', 'browser_tabs'), tool('reopen', 'browser_open', { url: origin + '/' })]])
  assert.equal(good(state, 'close').closed, true); assert.deepEqual(good(state, 'after-close').tabs, []); assert.equal(good(state, 'reopen').title, 'One')

  // Generic Node-capability authorization: an Agent whose rules deny master Node tools cannot reach master's browser.
  await launchRemote()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'bound' })).status, 201)
  assert.equal((await fixture.api('PUT', '/api/agents/bound', { defaultNode: 'remote', rules: [{ id: 'no-master-node-tools', action: 'deny', match: { tool: { source: 'node' }, targetNode: 'master' } }] })).status, 200)
  const bound = await create('browser-bound', 'bound')
  state = await turn(bound, 'isolated', [[tool('isolated-denied', 'browser_tabs', {}, 'master')]])
  assert(pair(state, 'isolated-denied').error)

  // The browser belongs to Main: image identity survives a restart, the tabs do not.
  await fixture.stop(); await fixture.start()
  state = await turn(second, 'restart', [[tool('restart-tabs', 'browser_tabs')]])
  assert.deepEqual(good(state, 'restart-tabs').tabs, [])
  state = await turn(id, 'persisted-owner', [[call('persisted-owner', 'image_write_to_file', { id: imageId, filePath: join(fixture.root, 'persisted.png') })]])
  good(state, 'persisted-owner'); assert.deepEqual(await readFile(join(fixture.root, 'persisted.png')), png)

  // Without a runnable browser the tools are not offered, and a direct call fails with the reason.
  await fixture.stop()
  env.PUPPETEER_EXECUTABLE_PATH = join(fixture.root, 'no-such-chromium')
  await fixture.start()
  state = await turn(id, 'unavailable', [[
    call('absent-discover', 'search_tools', { query: 'browser_tabs', sources: ['node'], nodeId: 'master', limit: 5 }),
    tool('absent-call', 'browser_open', { url: origin + '/' }),
  ]])
  assert(!/browser_/.test(JSON.stringify(good(state, 'absent-discover'))), 'unavailable browser tools are not discoverable')
  assert(pair(state, 'absent-call').error, JSON.stringify(pair(state, 'absent-call')))
  await fixture.stop()
  console.log(JSON.stringify({ hostStarts: fixture.hostPids.length, modelRequests: requests.length, tools: 'drive,errors,images,script,cancel,close,isolated,restart,unavailable' }))
} catch (error) { console.error(fixture.output); throw error }
finally {
  if (cli && cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await Promise.race([exited, sleep(4000).then(() => cli.kill('SIGKILL'))]) }
  model.closeAllConnections(); await new Promise(done => model.close(done)); site.closeAllConnections(); await new Promise(done => site.close(done)); await fixture.cleanup()
}
