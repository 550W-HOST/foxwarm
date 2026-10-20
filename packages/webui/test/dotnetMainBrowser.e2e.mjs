// Actual normal Main model/discovery callers, local browser effects and existing image owners.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const names = ['browse_open', 'browse_list', 'browse_get', 'browse_close', 'browse_interact']
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const browse = (id, name, args = {}, nodeId) => call(id, 'call_tool', { source: 'node', name, ...(nodeId ? { nodeId } : {}), args })
const exists = path => access(path).then(() => true, () => false)
for (const runtime of ['source', 'dotnet']) {
  const env = {}, options = { runtime, normalStartup: true, env }
  const fixture = await createHostFixture('main-browser-' + runtime, options)
  options.cwd = fixture.root
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '', FOXWARM_BIND_ADDRESS: '127.0.0.1', HOME: join(fixture.root, 'home'), XDG_CONFIG_HOME: join(fixture.root, 'config'), XDG_CACHE_HOME: join(fixture.root, 'cache') })
  for (const path of ['home', 'config', 'cache']) await mkdir(join(fixture.root, path))
  const effects = [], requests = [], errors = [], plans = new Map(), rounds = new Map(), results = []
  let cli
  const site = createServer((req, res) => {
    effects.push(req.url)
    if (req.url === '/redirect') { res.writeHead(302, { location: '/one' }); res.end(); return }
    res.setHeader('content-type', 'text/html')
    const title = req.url === '/two' ? 'Two' : 'One'
    res.end(`<!doctype html><title>${title}</title><body style="margin:0;min-height:1800px"><h1>${title}</h1><input id="entry" value="seed"><button id="button" onclick="window.clicked++">Click</button><div><button onclick="window.item=1">Item</button><button onclick="window.item=2">Item</button></div><a id="link" href="/two">Next</a><div hidden id="hidden">hidden</div><script>window.clicked=0;window.inputs=0;window.changes=0;document.querySelector('#entry').addEventListener('input',()=>inputs++);document.querySelector('#entry').addEventListener('change',()=>changes++);setTimeout(()=>{const x=document.createElement('div');x.id='later';document.body.append(x)},100);</script></body>`)
  })
  site.listen(0, '127.0.0.1'); await once(site, 'listening'); const origin = `http://127.0.0.1:${site.address().port}`
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
  const good = (state, id) => { const value = pair(state, id); assert(value && !value.error, id + ': ' + JSON.stringify(value)); return value }
  const text = (state, id) => good(state, id).output
  const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MAIN-BROWSER-DONE-' + key }] }]
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...prompt.matchAll(/MAINBROWSER:([\w-]+)/g)].at(-1)?.[1]
      assert(!(body.tools || []).some(tool => names.includes(tool.name)), 'Main browser records stay default-hidden')
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || final(key)
      requests.push({ key, body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const deniedPath = join(fixture.root, 'denied.png')
  await writeFile(deniedPath, 'unchanged')
  await writeFile(join(fixture.data, 'state/tool-authorization.yaml'), `version: 1\nrules:\n- action: deny\n  tool: {source: node, name: browse_open}\n  args: {url: [${JSON.stringify(origin + '/denied')}]}\n- action: deny\n  tool: {source: node, name: browse_get}\n  args: {screenshot: [${JSON.stringify(deniedPath)}]}\n`)
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: main-browser-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, models: ['wire'] } } }))
  async function create(name, agent = 'main') { const response = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name }); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.sessionId }
  async function turn(id, key, steps) {
    plans.set(key, steps); rounds.set(key, 0)
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'MAINBROWSER:' + key }); assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
    return until(async () => {
      if (errors.length) throw new Error(errors.join('\n'))
      const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
      return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'MAIN-BROWSER-DONE-' + key)) ? state : null
    }, runtime + ' ' + key, 45000)
  }
  async function launchRemote() {
    const cwd = join(fixture.root, 'cli'); await mkdir(cwd)
    cli = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll'), '--host', fixture.origin, '--no-local-trigger', '--id', 'remote', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim(), '--credentials-file', join(cwd, 'credentials.json')], { cwd, env: isolatedApplicationEnv(join(cwd, 'data')), stdio: ['ignore', 'pipe', 'pipe'] })
    cli.stdout.resume(); cli.stderr.resume()
    const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'remote'), 'owned remote pairing')
    assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'remote' && node.online), 'owned remote online')
  }
  try {
    await fixture.start()
    const id = await create('main-browser'), second = await create('second-browser')
    let state = await turn(id, 'discover', [[call('discover', 'search_tools', { query: 'browse_open', sources: ['node'], nodeId: 'master', limit: 1 }), browse('empty', 'browse_list'), browse('open', 'browse_open', { url: origin + '/redirect' })]])
    assert.match(text(state, 'discover'), /node:master\/browse_open/)
    assert.equal(text(state, 'empty'), 'No tabs open')
    assert.equal(text(state, 'open'), `Tab opened: tab1\nTitle: One\nURL: ${origin}/redirect`)
    const mainPid = fixture.hostPids.at(-1), browserProcesses = []
    async function descendants(pid) {
      const tasks = await readdir(`/proc/${pid}/task`).catch(() => [])
      const children = [...new Set((await Promise.all(tasks.map(tid => readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '')))).join(' ').trim().split(/\s+/).filter(Boolean))]
      for (const child of children) {
        browserProcesses.push({ pid: child, command: await readFile(`/proc/${child}/cmdline`, 'utf8').catch(() => '') })
        await descendants(child)
      }
    }
    await descendants(mainPid)
    const browserPid = browserProcesses.find(item => item.command.includes('--remote-debugging-') && !item.command.includes('--type='))?.pid
    assert(browserPid, 'actual launched browser is a Main descendant: ' + JSON.stringify(browserProcesses))
    const tabId = 'tab1'
    const act = (id, action, params = {}) => browse(id, 'browse_interact', { tabId, action, params })
    const evaluate = (id, code) => act(id, 'evaluate', { code })
    state = await turn(second, 'shared-settings', [[call('direct-list', 'browse_list', {}), browse('text', 'browse_get', { tabId }), evaluate('settings', '({url:location.href,ua:navigator.userAgent,width:innerWidth,height:innerHeight,webdriver:navigator.webdriver})')]])
    assert.equal(text(state, 'direct-list'), `tab1: One\n  URL: ${origin}/redirect`)
    assert.equal(text(state, 'text'), 'One\nClick\nItemItem\nNext')
    assert.deepEqual(JSON.parse(text(state, 'settings').slice(11)), { url: origin + '/one', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', width: 1280, height: 720, webdriver: false })
    state = await turn(id, 'fill', [[act('fill', 'fill', { selector: '#entry', text: 'replacement' }), evaluate('fill-effect', '({value:document.querySelector("#entry").value,inputs,changes})')]])
    if (runtime === 'source') {
      assert.match(JSON.stringify(pair(state, 'fill').error), /fill is not a function/)
      assert.equal(text(state, 'fill-effect'), 'Evaluated: {"value":"seed","inputs":0,"changes":0}')
      await writeFile(join(fixture.root, 'source-fill-before.json'), JSON.stringify({ failure: pair(state, 'fill'), effect: pair(state, 'fill-effect') }, null, 2))
    } else {
      assert.equal(text(state, 'fill'), 'Filled #entry with "replacement"')
      assert.equal(text(state, 'fill-effect'), 'Evaluated: {"value":"replacement","inputs":1,"changes":0}')
    }
    const initial = runtime === 'source' ? 'seed' : 'replacement'
    state = await turn(id, 'actions', [[evaluate('caret', '(()=>{const el=document.querySelector("#entry");el.focus();el.setSelectionRange(el.value.length,el.value.length);return true})()'), act('type', 'type', { selector: '#entry', text: 'APPEND' }), act('end', 'press', { key: 'End' }), act('key', 'press', { key: 'X' }), evaluate('typed', 'document.querySelector("#entry").value'), act('click', 'click', { selector: '#button' }), evaluate('clicked', 'clicked'), act('scroll', 'scroll', { y: 350 }), evaluate('scrolled', 'scrollY'), act('zero', 'scroll', { y: 0 }), act('wait', 'wait', { selector: '#later' }), act('wait-zero', 'wait', { selector: '#hidden', timeout: 0 }), act('aria-one', 'wait', { selector: 'aria/Click' }), act('aria-all', 'wait', { selector: '::-p-aria(Item):nth-of-type(2)' }), act('aria-click', 'click', { selector: '::-p-aria(Item):nth-of-type(2)' }), evaluate('aria-effect', 'item')]])
    assert.equal(text(state, 'type'), 'Typed "APPEND" into #entry'); assert.equal(text(state, 'typed'), 'Evaluated: ' + JSON.stringify(initial + 'APPENDX'))
    assert.equal(text(state, 'clicked'), 'Evaluated: 1'); assert.equal(text(state, 'scrolled'), 'Evaluated: 350'); assert.equal(text(state, 'zero'), 'Scrolled by 0px'); assert.equal(text(state, 'aria-effect'), 'Evaluated: 2')
    for (const key of ['end', 'key', 'click', 'scroll', 'wait', 'wait-zero', 'aria-one', 'aria-all', 'aria-click']) good(state, key)
    state = await turn(id, 'metadata', [[evaluate('rename', 'document.title="Changed"'), browse('cached', 'browse_list'), browse('get-cached', 'browse_get', { tabId }), act('goto', 'goto', { url: origin + '/two' }), act('back', 'back'), browse('back-cache', 'browse_list'), evaluate('back-effect', 'location.pathname'), act('forward', 'forward'), evaluate('forward-effect', 'location.pathname'), act('reload', 'reload')]])
    assert.equal(text(state, 'cached'), `tab1: One\n  URL: ${origin}/redirect`); assert.equal(text(state, 'goto'), `Navigated to: ${origin}/two\nTitle: Two`)
    assert.equal(text(state, 'back-cache'), `tab1: Two\n  URL: ${origin}/two`); assert.equal(text(state, 'back-effect'), 'Evaluated: "/one"'); assert.equal(text(state, 'forward-effect'), 'Evaluated: "/two"'); assert.equal(text(state, 'reload'), 'Page reloaded')
    const rawPath = join(fixture.root, 'raw.png'), missingPath = join(fixture.root, 'missing/shot.png')
    await writeFile(rawPath, 'overwrite me')
    state = await turn(id, 'file-policy-errors', [[browse('save', 'browse_get', { tabId, screenshot: rawPath }), browse('save-missing', 'browse_get', { tabId, screenshot: missingPath }), browse('denied-open', 'browse_open', { url: origin + '/denied' }), browse('denied-save', 'browse_get', { tabId, screenshot: deniedPath }), browse('missing-tab', 'browse_get', { tabId: 'missing' }), act('missing-selector', 'fill', { selector: '#absent', text: 'x' }), evaluate('js-error', '(()=>{throw new Error("owned-js-error")})()'), act('bad-action', 'unknown'), act('bad-navigation', 'goto', { url: 'http://127.0.0.1:1/unreachable' })]])
    assert.equal(text(state, 'save'), 'Screenshot saved to: ' + rawPath)
    for (const key of ['save-missing', 'denied-open', 'denied-save', 'missing-tab', 'missing-selector', 'js-error', 'bad-action', 'bad-navigation']) assert(pair(state, key)?.error, key + ' ordinary tool error')
    assert(!effects.includes('/denied')); assert.equal(await readFile(deniedPath, 'utf8'), 'unchanged'); assert(!await exists(missingPath))
    assert(!state.history.flatMap(row => row.parts || []).some(part => (part.toolUseId || part.tool_use_id) === 'save' && part.inlineDataRef), 'save branch does not register an image')
    const rawMeta = await sharp(await readFile(rawPath)).metadata(); assert.equal(rawMeta.width, 1280); assert.equal(rawMeta.height, 720)
    // Return to a real page after the intentionally failed navigation.
    await turn(id, 'restore-page', [[act('restore-page', 'goto', { url: origin + '/one' })]])
    let imageId
    state = await turn(id, 'images', [[browse('screenshot', 'browse_get', { tabId, screenshot: true }), browse('full-is-viewport', 'browse_get', { tabId, screenshot: 'full' })], body => {
      const serialized = JSON.stringify(body.input), ids = []
      function collect(value) {
        if (typeof value === 'string') for (const match of value.matchAll(/\[IMAGE: id=("(?:\\.|[^"\\])*"|[^,\]\s]+)/g)) ids.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1])
        else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
      }
      collect(body.input)
      assert(ids.length); imageId = ids.at(-1); assert(serialized.includes('input_image'), 'real next provider request contains screenshot')
      return [call('crop', 'image_crop', { id: imageId, x: 0, y: 0, width: 100, height: 80 }), call('export', 'image_write_to_file', { id: imageId, filePath: join(fixture.root, 'exported.png') })]
    }, () => [call('read-export', 'read', { filePath: join(fixture.root, 'exported.png') }), call('delivery', 'send_file', { filePath: join(fixture.root, 'exported.png') })]])
    for (const key of ['screenshot', 'full-is-viewport', 'crop', 'export', 'read-export', 'delivery']) good(state, key)
    const images = state.history.flatMap(row => row.parts || []).filter(part => part.inlineDataRef)
    for (const key of ['screenshot', 'full-is-viewport']) {
      const image = images.find(part => (part.toolUseId || part.tool_use_id) === key); assert(image)
      const response = await fetch(fixture.origin + '/api/blobs/' + image.inlineDataRef.blobId, { headers: { authorization: 'Bearer ' + fixture.token } }); assert.equal(response.status, 200)
      const bytes = Buffer.from(await response.arrayBuffer()), meta = await sharp(bytes).metadata(); assert.equal(meta.width, 1280); assert.equal(meta.height, 720)
    }
    const image = images.find(part => (part.toolUseId || part.tool_use_id) === 'full-is-viewport'); assert.equal(image.inlineDataRef.imageId, imageId)
    const delivery = good(state, 'delivery').fileDelivery; assert.equal(delivery.sourceNodeId, 'master'); assert.equal(delivery.downloadNodeId, 'master'); assert.equal(delivery.mimeType, 'image/png')
    const exported = await readFile(join(fixture.root, 'exported.png'))
    assert.deepEqual(await readFile(delivery.downloadPath), exported)
    assert(!JSON.stringify(state).includes('"inlineData":')); assert(!JSON.stringify(state).includes(exported.toString('base64')))
    state = await turn(id, 'script', [[call('script', 'run_script', { code: `value = call_tool('browse_list', {})\nassert isinstance(value, str)\nreturn value` })]])
    assert.equal(good(state, 'script').result, `tab1: One\n  URL: ${origin}/one`)
    await launchRemote()
    state = await turn(id, 'remote', [[call('select', 'node', { action: 'select', nodeId: 'remote' }), browse('remote-list', 'browse_list'), browse('explicit-master', 'browse_list', {}, 'master'), call('back-master', 'node', { action: 'select', nodeId: 'master' })]])
    assert(['{}', '[]'].includes(JSON.stringify(good(state, 'remote-list'))), 'remote empty result, not Main cached text'); assert.equal(text(state, 'explicit-master'), `tab1: One\n  URL: ${origin}/one`)
    // Existing persisted exact rules, not a generic allow, permit only the chosen master browser capabilities.
    assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'bound' })).status, 201)
    assert.equal((await fixture.api('PUT', '/api/agents/bound', { isolatedNode: 'remote' })).status, 200)
    const bound = await create('browser-bound', 'bound')
    state = await turn(bound, 'default-isolated', [[browse('isolated-denied', 'browse_list', {}, 'master')]])
    assert(pair(state, 'isolated-denied').error)
    state = await turn(id, 'grant', [[call('grant', 'call_tool', { toolId: 'builtin:set_agent_isolated', args: { agentName: 'bound', toolRules: names.map(tool => ({ effect: 'allow', source: 'node', node: 'master', tool })) } })]])
    good(state, 'grant')
    state = await turn(bound, 'exact-isolated', [[call('exact-discover', 'search_tools', { query: 'browse_list', sources: ['node'], nodeId: 'master', limit: 1 }), browse('exact-list', 'browse_list', {}, 'master'), browse('exact-save', 'browse_get', { tabId, screenshot: join(fixture.root, 'isolated-raw.png') }, 'master'), browse('exact-denied-save', 'browse_get', { tabId, screenshot: deniedPath }, 'master'), browse('no-master-exec', 'exec', { command: 'touch never-exec' }, 'master'), call('no-master-select', 'node', { action: 'select', nodeId: 'master' })]])
    assert.match(text(state, 'exact-discover'), /node:master\/browse_list/); assert.equal(text(state, 'exact-list'), `tab1: One\n  URL: ${origin}/one`); good(state, 'exact-save')
    for (const key of ['exact-denied-save', 'no-master-exec', 'no-master-select']) assert(pair(state, key).error)
    assert.equal((await sharp(await readFile(join(fixture.root, 'isolated-raw.png'))).metadata()).height, 720)
    state = await turn(id, 'cancel-before', [[call('cancel-before', 'call_tool', { source: 'node', name: 'browse_open', args: { url: origin + '/cancel-before' }, __cancelTool: true }), browse('after-cancel', 'browse_list')]])
    assert(pair(state, 'cancel-before').canceled); assert(!effects.includes('/cancel-before'))
    plans.set('stop-dispatched', [[evaluate('stop-dispatched', `new Promise(resolve=>{fetch('${origin}/dispatch-started');setTimeout(()=>{document.title='After Stop';fetch('${origin}/dispatch-finished');resolve(42)},1200)})`)]]); rounds.set('stop-dispatched', 0)
    assert([200, 202].includes((await fixture.api('POST', route(id) + '/message', { text: 'MAINBROWSER:stop-dispatched' })).status))
    await until(() => effects.includes('/dispatch-started'), 'actual dispatched JS')
    assert([200, 202].includes((await fixture.api('POST', route(id) + '/message', { text: '/stop' })).status))
    await until(() => effects.includes('/dispatch-finished'), 'already dispatched effect survives Stop')
    await until(async () => !(await fixture.api('GET', route(id) + '/history')).body.session.busy, 'stopped turn drain')
    state = await turn(second, 'after-stop', [[evaluate('after-stop', 'document.title'), browse('close', 'browse_close', { tabId }), browse('empty-again', 'browse_list'), browse('reopen', 'browse_open', { url: origin + '/one' })]])
    assert.equal(text(state, 'after-stop'), 'Evaluated: "After Stop"'); assert.equal(text(state, 'close'), 'Tab tab1 closed'); assert.equal(text(state, 'empty-again'), 'No tabs open'); assert(await exists(`/proc/${browserPid}`), 'closing last tab and Session Stop do not end the browser'); assert.match(text(state, 'reopen'), /^Tab opened: tab2\n/)
    state = await turn(second, 'tab-order', [[browse('third-tab', 'browse_open', { url: origin + '/two' }), browse('remove-earlier', 'browse_close', { tabId: 'tab2' }), browse('fourth-tab', 'browse_open', { url: origin + '/one' }), browse('tab-order', 'browse_list')]])
    assert.equal(text(state, 'tab-order'), `tab3: Two\n  URL: ${origin}/two\n\ntab4: One\n  URL: ${origin}/one`)
    // Main process owns tabs; images retain their normal durable identities across its restart.
    await fixture.stop()
    await until(async () => { const status = await readFile(`/proc/${browserPid}/status`, 'utf8').catch(() => ''); return !status || /^State:\s+Z/m.test(status) }, 'browser process exited with its Main')
    await fixture.start()
    state = await turn(second, 'restart', [[browse('restart-list', 'browse_list'), browse('restart-open', 'browse_open', { url: origin + '/one' })]])
    assert.equal(text(state, 'restart-list'), 'No tabs open'); assert.match(text(state, 'restart-open'), /^Tab opened: tab1\n/)
    // Export retained image from its actual owner Session, not another Session's image namespace.
    state = await turn(id, 'persisted-owner', [[call('persisted-owner', 'image_write_to_file', { id: imageId, filePath: join(fixture.root, 'persisted.png') })]])
    good(state, 'persisted-owner'); assert.deepEqual(await readFile(join(fixture.root, 'persisted.png')), exported)
    await fixture.stop()
    results.push({ runtime, hostStarts: fixture.hostPids.length, modelRequests: requests.length, sourceFillFailure: runtime === 'source', correctedFill: runtime === 'dotnet', actions: 11, viewportPng: true, rawFileEffects: true, sharedTabs: true, exactIsolatedGrant: true, policyBeforeEffects: true, scalarProgrammatic: true, imageOwnerRestart: true, stopDispatchedEffect: true })
    await writeFile(join(fixture.root, 'main-browser-evidence.json'), JSON.stringify({ results, effects, requests }, null, 2)); console.log(JSON.stringify(results.at(-1)))
  } catch (error) { console.error(runtime, fixture.output); throw error }
  finally {
    if (cli && cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await Promise.race([exited, sleep(4000).then(() => cli.kill('SIGKILL'))]) }
    model.closeAllConnections(); await new Promise(done => model.close(done)); site.closeAllConnections(); await new Promise(done => site.close(done)); await fixture.cleanup()
  }
}
