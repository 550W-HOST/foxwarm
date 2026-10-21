import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

let server, channel, browser, page, root, registry, sessionRuntime, baseUrl, fixtureUrl
const requests = []
const errors = []
let commandReads = 0
let delayCommands = false
let failNextCreate = false
let delayCreateResponse = false
let createCalls = 0
const createdResponses = []
const delayed = []
const component = fileURLToPath(new URL('../src/components/ArchitectureView.tsx', import.meta.url))
const nodesComponent = fileURLToPath(new URL('../src/components/NodesView.tsx', import.meta.url))
const theme = fileURLToPath(new URL('../src/theme/index.ts', import.meta.url))
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

async function click(label) {
  const button = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text || button.getAttribute('aria-label') === text), label)
  assert.ok(button.asElement(), `Expected button: ${label}`)
  await button.asElement().click(); await button.dispose()
}
async function replace(label, value) {
  await page.$eval(`input[aria-label="${label}"]`, element => { element.focus(); element.select() })
  await page.keyboard.type(value)
}
async function screenshot(name) {
  if (!process.env.FOXWARM_E2E_SCREENSHOT_DIR) return
  await fs.ensureDir(process.env.FOXWARM_E2E_SCREENSHOT_DIR)
  await page.screenshot({ path: path.join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, name), fullPage: true })
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-ui-'))
  process.env.FOXWARM_DATA_DIR = root
  await fs.ensureDir(path.join(root, 'state'))
  await fs.writeFile(path.join(root, 'state/config.yaml'), 'vector:\n  enabled: false\ndbWorkers: false\n')
  await fs.writeFile(path.join(root, 'state/node_token'), 'synthetic-pairing-credential')
  const { HttpServer, setHttpServer } = await import('../../../lib/httpServer.js')
  const { WebUIChannel } = await import('../../../lib/channels/webuiChannel.js')
  const sessionManager = await import('../../../lib/sessionManager.js')
  sessionRuntime = await import('../../../lib/sessionRuntime.js')
  registry = await import('../../../lib/nodes/registry.js')
  await sessionManager.loadSessions()
  const session = await sessionManager.getSession('main/browser-fixture')
  session.currentNode = 'unavailable-session-placement'
  await sessionManager.saveSession(session.id)
  await registry.createApprovedNode('offline-example')
  await registry.createPendingPairing({ requestedName: 'Synthetic laptop', nodeType: 'cli-node', capabilities: { tools: [] } })

  const bundle = await build({ absWorkingDir: packageRoot, stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import ArchitectureView from ${JSON.stringify(component)}; import NodesView from ${JSON.stringify(nodesComponent)}; import {initializeThemeRuntime} from ${JSON.stringify(theme)}; initializeThemeRuntime();
      window.fixtureClipboard=''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text}}});
      const root=createRoot(document.getElementById('root')); function Fixture(){ const [nodes,setNodes]=React.useState(false); window.fixtureShowArchitecture=()=>setNodes(false); return nodes ? React.createElement(NodesView) : React.createElement(ArchitectureView,{currentSession:'main/browser-fixture',onSelectSession:()=>{},onOpenNodes:()=>setNodes(true)}); } root.render(React.createElement(Fixture));`,
    loader: 'tsx', resolveDir: packageRoot, sourcefile: 'node-onboarding-fixture.tsx',
  }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, alias: webuiReactAliases,
  define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  const assets = await fs.readdir(new URL('../dist/assets/', import.meta.url))
  const css = await fs.readFile(new URL(`../dist/assets/${assets.find(name => /^index-.*\.css$/.test(name))}`, import.meta.url), 'utf8')
  server = new HttpServer(0, 'synthetic-browser-auth')
  server.app.use((req, res, next) => {
    if (req.url.startsWith('/deployment/')) req.url = req.url.slice('/deployment'.length)
    requests.push(req.url)
    if (req.path === '/api/nodes/onboarding/commands') commandReads++
    if (req.path === '/api/nodes/onboarding/create') {
      createCalls++
      if (failNextCreate) { failNextCreate = false; res.status(500).json({ error: 'Could not create this Node.' }); return }
      if (delayCreateResponse) {
        const respond = res.json.bind(res)
        res.json = payload => { createdResponses.push(() => respond(payload)); return res }
      }
    }
    if (delayCommands && req.path === '/api/nodes/onboarding/commands') { delayed.push(next); return }
    next()
  })
  server.app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`))
  setHttpServer(server)
  channel = new WebUIChannel({ router: {}, token: 'synthetic-browser-auth', enableTrigger: false, enableWebUI: true })
  await server.start()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  fixtureUrl = `${baseUrl}/deployment/`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 1280, height: 900 })
  await page.setCookie({ name: 'foxwarm_token', value: 'synthetic-browser-auth', url: baseUrl, httpOnly: true })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.innerText.includes('Execution topology'))
})

after(async () => {
  await browser?.close()
  await channel?.stop()
  await server?.stop()
  await sessionRuntime?.shutdownSessionRuntime()
  if (root) await fs.remove(root)
})

test('Nodes is a real independent surface; pending approval, inline copy and explicit Shell creation use authenticated APIs', { timeout: 45_000 }, async () => {
  assert.equal(commandReads, 0, 'ordinary Architecture loading never requests credentials')
  await page.waitForFunction(() => [...document.querySelectorAll('header button')].some(button => /[1-9]\d* in loaded window/.test(button.textContent)))
  const sessionCard = () => page.evaluate(() => {
    const card = [...document.querySelectorAll('header button')].find(button => button.textContent.includes('in loaded window'))
    return card ? { value: card.querySelector('.tabular-nums')?.textContent, detail: card.lastElementChild?.textContent } : null
  })
  const counts = await sessionCard()
  const positions = []
  for (const surface of ['Topology', 'Agents']) {
    await click(surface)
    await page.waitForFunction(name => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].some(button => button.textContent === name && button.getAttribute('aria-pressed') === 'true'), {}, surface)
    positions.push(await page.$eval('.foxwarm-architecture-surface-tab', button => button.parentElement.getBoundingClientRect().left))
    assert.ok(!(await page.$eval('header', header => header.innerText)).includes('loaded of'))
    assert.deepEqual(await sessionCard(), counts, 'summary-card values and loaded counts are retained')
  }
  assert.ok(Math.max(...positions) - Math.min(...positions) < 1, 'the surface switch retains its horizontal position')
  await click('Topology')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('protocol-compatible execution')).click())
  await page.waitForSelector('[data-node-surface]')
  await page.waitForFunction(() => document.body.innerText.includes('1 pending approvals'))
  const nodeText = await page.$eval('[data-node-surface]', element => element.textContent)
  assert.ok(nodeText.includes('master') && nodeText.includes('offline-example') && nodeText.includes('Offline'))
  assert.ok(!nodeText.includes('unavailable-session-placement'))
  assert.equal(await page.$('input[aria-label="Search sessions, models, tools"]'), null)
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('loaded of'))
  assert.equal(commandReads, 0)
  await screenshot('nodes-surface.png')
  await page.setViewport({ width: 390, height: 844 })
  await screenshot('nodes-surface-narrow.png')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewport({ width: 1280, height: 900 })
  const other = await browser.newPage(); await other.bringToFront()
  await page.waitForFunction(() => document.hidden, { polling: 100, timeout: 3000 })
  const pendingReads = requests.filter(url => url.includes('/onboarding/pending')).length
  await new Promise(resolve => setTimeout(resolve, 5200))
  assert.equal(requests.filter(url => url.includes('/onboarding/pending')).length, pendingReads, 'hidden Nodes page stops dispatching pending refreshes')
  await page.bringToFront(); await other.close()
  await page.waitForFunction(() => !document.hidden, { polling: 100 })

  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  assert.equal(await page.$eval('input[aria-label="Reachable address"]', element => element.value), `${baseUrl}/deployment`)
  assert.ok((await page.$eval('[data-node-command]', element => element.textContent)).includes(`${baseUrl}/deployment/node/run.sh`))
  await screenshot('new-nodes-modal.png')
  await replace('Reachable address', "https://reachable.example.invalid/deploy'path/$literal")
  await click('Update command')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes("deploy'\"'\"'path/$literal"))
  await click('Copy command')
  assert.equal(await page.evaluate(() => window.fixtureClipboard), await page.$eval('[data-node-command]', element => element.textContent))
  assert.ok((await page.evaluate(() => window.fixtureClipboard)).includes('synthetic-pairing-credential'))
  assert.ok(!(await page.evaluate(() => window.fixtureClipboard)).includes('BASE_URL'))
  await screenshot('new-nodes-literal-path.png')
  const readCount = commandReads
  await registry.createPendingPairing({ requestedName: 'Synthetic second laptop', nodeType: 'cli-node', capabilities: { tools: [] } })
  await page.waitForFunction(() => document.body.innerText.includes('2 pending approvals'), { timeout: 8000 })
  assert.equal(commandReads, readCount, 'pending refresh does not reload pairing credentials')
  await click('Approve')
  await page.waitForFunction(() => document.body.innerText.includes('1 pending approvals'))
  assert.equal((await registry.listApprovedNodes()).length, 2)
  const stale = (await registry.listPendingPairings()).find(entry => !entry.approvedNodeId)
  await registry.rejectPendingPairing(stale.id)
  await click('Approve')
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(element => element.textContent.includes('no longer awaiting approval')))
  await page.click('button[aria-label="Refresh pending approvals"]')
  await page.waitForFunction(() => !document.querySelector('[role=alert]'))

  await click('Shell')
  assert.equal(await page.$('[data-node-command]'), null)
  assert.equal((await registry.listApprovedNodes()).length, 2, 'selecting Shell does not create trust')
  await replace('Node name', 'browser-shell')
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes("--node-id='browser-shell'"))
  const shell = await page.$eval('[data-node-command]', element => element.textContent)
  assert.match(shell, /NODE_AUTH_TOKEN='[a-f0-9]{64}'/)
  assert.ok(!shell.includes('--pairing='))
  assert.equal((await registry.listApprovedNodes()).length, 3)
  const stores = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  assert.ok(!stores.includes('synthetic-pairing-credential'))
  assert.ok(!stores.includes(/NODE_AUTH_TOKEN='([a-f0-9]{64})'/.exec(shell)[1]))
  assert.ok(!requests.join('\n').includes('synthetic-pairing-credential'))
  assert.ok(!requests.join('\n').includes('NODE_AUTH_TOKEN'))
  await click('Close New nodes')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('NODE_AUTH_TOKEN'))
  await page.evaluate(() => window.fixtureShowArchitecture())
  await page.waitForSelector('input[aria-label="Search sessions, models, tools"]')
  assert.ok((await page.evaluate(() => document.body.innerText)).includes('Execution topology'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('protocol-compatible execution')).click())
  await page.waitForSelector('[data-node-surface]')
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await click('Shell')
  assert.equal(await page.$('[data-node-command]'), null, 'closed credentials are not reused on reopening')
  assert.equal((await registry.listApprovedNodes()).length, 3)
  await click('Close New nodes')
  delayCommands = true
  const beforeDelayed = commandReads
  await click('New nodes')
  await page.waitForFunction(() => document.querySelector('[role=dialog]'))
  while (commandReads === beforeDelayed) await new Promise(resolve => setTimeout(resolve, 20))
  await click('Close New nodes')
  delayCommands = false; delayed.splice(0).forEach(next => next())
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await page.$('[role=dialog]'), null, 'a late setup response cannot reopen or publish into the closed modal')
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('synthetic-pairing-credential'))
  assert.deepEqual(errors, [])
})


test('every setup method supports explicit pre-creation, safe switching, updates and mounted-only copied credentials', { timeout: 60_000 }, async () => {
  const choose = async label => {
    await page.evaluate(text => [...document.querySelectorAll('label')].find(element => element.textContent.trim() === text).querySelector('input').click(), label)
  }
  const idle = () => page.waitForFunction(() => ![...document.querySelectorAll('[role=status]')].some(element => element.textContent === 'Loading…'))
  const command = () => page.$eval('[data-node-command]', element => element.textContent)
  const copy = async () => {
    await click('Copy command')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Copied'))
    assert.equal(await page.evaluate(() => window.fixtureClipboard), await command())
  }
  const baseline = (await registry.listApprovedNodes()).length
  const callsBefore = createCalls
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await idle()
  for (const method of ['Linux CLI', 'Interactive CLI', 'Docker', 'Windows']) {
    await click(method)
    assert.ok((await command()).includes('synthetic-pairing-credential'), method)
    await choose('Pre-created token')
    assert.equal(await page.$('[data-node-command]'), null, method)
    assert.ok(await page.$('input[aria-label="Node name"]:enabled'))
    await choose('Pairing approval')
    assert.ok((await command()).includes('synthetic-pairing-credential'), method)
  }
  assert.equal(createCalls, callsBefore, 'method and authentication switches never call create')
  assert.equal((await registry.listApprovedNodes()).length, baseline)
  await click('Linux CLI')
  await choose('Start automatically with systemd')
  assert.ok((await command()).includes('--install'))
  await choose('Start automatically with systemd')
  await click('Docker')
  await choose('Manual Docker Compose')
  assert.ok((await command()).includes("NODE_PAIRING_TOKEN='synthetic-pairing-credential'"))
  await choose('Manual Docker Compose')
  await click('Linux CLI')
  await choose('Pre-created token')
  await replace('Node name', 'offline-example')
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('already in use'))
  await idle()
  assert.equal(await page.$('[data-node-command]'), null)
  assert.equal((await registry.listApprovedNodes()).length, baseline)
  await replace('Node name', 'browser-token')
  const address = "https://token.example.invalid/deploy'path/$literal"
  await replace('Reachable address', address)
  await replace('Installation directory', "/opt/node's directory/$literal")
  failNextCreate = true
  const failedCall = createCalls
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent === 'Could not create this Node.')
  await idle()
  assert.equal(createCalls, failedCall + 1, 'failure is not retried automatically')
  assert.equal((await registry.listApprovedNodes()).length, baseline)
  assert.equal(await page.$('[data-node-command]'), null)
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes('--auth-token='))
  await idle()
  const token = /--auth-token='([a-f0-9]{64})'/.exec(await command())[1]
  assert.equal((await registry.authenticateApprovedNode('browser-token', token))?.nodeId, 'browser-token')
  assert.equal((await registry.listApprovedNodes()).length, baseline + 1)
  const callsAfterCreate = createCalls
  for (const method of ['Linux CLI', 'Interactive CLI', 'Docker', 'Windows', 'Shell']) {
    await click(method)
    const text = await command()
    assert.ok(text.includes(token), method)
    assert.ok(!text.includes('synthetic-pairing-credential'), method)
    assert.ok(text.includes('browser-token'), method)
    assert.ok(text.includes('token.example.invalid'), method)
    assert.ok(!/--pairing=|-Pairing /.test(text), method)
    assert.equal(await page.$eval('input[aria-label="Node name"]', element => element.value), 'browser-token')
    assert.equal(await page.$eval('input[aria-label="Reachable address"]', element => element.value), address)
    assert.ok(await page.$('input[aria-label="Node name"]:disabled'))
    await copy()
    if (method === 'Linux CLI') {
      await choose('Start automatically with systemd')
      assert.ok((await command()).includes('--install'))
      assert.ok((await command()).includes(token))
      await copy()
      await choose('Start automatically with systemd')
    }
    if (method === 'Docker') {
      await choose('Manual Docker Compose')
      assert.ok((await command()).includes(`NODE_AUTH_TOKEN='${token}'`))
      assert.ok((await command()).includes("NODE_PAIRING_TOKEN=''"))
      await copy()
      await choose('Manual Docker Compose')
    }
  }
  assert.equal(createCalls, callsAfterCreate, 'reusing a token across methods never creates another identity')
  await click('Linux CLI')
  await choose('Pairing approval')
  await replace('Node name', 'pairing-draft')
  await replace('Reachable address', 'https://pairing.example.invalid/other')
  await replace('Installation directory', '/opt/changed directory')
  await click('Update command')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes('pairing-draft'))
  await idle()
  assert.ok((await command()).includes('synthetic-pairing-credential'))
  assert.ok(!(await command()).includes(token))
  await copy()
  // Even empty pairing drafts must not disable updates for the bound identity.
  await replace('Reachable address', '')
  await replace('Node name', '')
  await choose('Pre-created token')
  assert.equal(await page.$('[data-node-command]'), null, 'directory edits invalidate the old Linux token command')
  assert.equal(await page.$eval('input[aria-label="Node name"]', element => element.value), 'browser-token')
  assert.equal(await page.$eval('input[aria-label="Reachable address"]', element => element.value), address)
  await click('Update command')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes('/opt/changed directory'))
  await idle()
  assert.ok((await command()).includes(token))
  assert.ok(!(await command()).includes('pairing.example.invalid'))
  assert.equal(createCalls, callsAfterCreate)
  assert.equal((await registry.listApprovedNodes()).length, baseline + 1)
  await screenshot('new-nodes-precreated-token.png')
  await page.setViewport({ width: 390, height: 844 })
  await screenshot('new-nodes-precreated-token-narrow.png')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewport({ width: 1280, height: 900 })
  const stores = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  assert.ok(!stores.includes(token))
  assert.ok(!stores.includes('synthetic-pairing-credential'))
  assert.ok(!requests.join('\n').includes(token))
  assert.ok(!page.url().includes(token))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role=dialog]', { hidden: true })
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(token))

  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await idle()
  await choose('Pre-created token')
  assert.equal(await page.$('[data-node-command]'), null, 'reopen has no stored token')
  await replace('Node name', 'closed-before-response')
  delayCreateResponse = true
  await click('Create')
  // The actual route persists trust before returning its one-time response.
  while (!createdResponses.length) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await registry.listApprovedNodes()).length, baseline + 2)
  assert.ok(await page.$('input[aria-label="Node name"]:disabled'), 'pending actions cannot mix edited names into their result')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role=dialog]', { hidden: true })
  delayCreateResponse = false
  createdResponses.splice(0).forEach(respond => respond())
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await idle()
  await choose('Pre-created token')
  assert.equal(await page.$('[data-node-command]'), null, 'a late create response cannot publish into the next modal')
  assert.equal((await registry.listApprovedNodes()).length, baseline + 2)
  assert.equal(createCalls, callsAfterCreate + 1, 'closing never retries creation')
  await click('Close New nodes')
  assert.deepEqual(errors, [])
})


test('direct Nodes leaf loads only directory and visible pending data, and unmount cancels polling', async () => {
  const bundle = await build({ absWorkingDir: packageRoot, stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import NodesView from ${JSON.stringify(nodesComponent)}; const root=createRoot(document.getElementById('root')); window.unmountFixture=()=>root.unmount(); root.render(React.createElement(NodesView));`,
    loader: 'tsx', resolveDir: packageRoot,
  }, bundle: true, format: 'iife', platform: 'browser', write: false, alias: webuiReactAliases, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  await page.goto('about:blank')
  const leaf = await browser.newPage()
  try {
    await leaf.setRequestInterception(true)
    leaf.on('request', request => {
      if (request.isNavigationRequest()) void request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` })
      else void request.continue()
    })
    const start = requests.length
    await leaf.goto(fixtureUrl, { waitUntil: 'load' })
    await leaf.waitForSelector('[data-node-surface]')
    await leaf.waitForFunction(() => document.body.innerText.includes('master'))
    await new Promise(resolve => setTimeout(resolve, 100))
    const reads = requests.slice(start)
    assert.ok(reads.some(url => url === '/api/nodes'))
    assert.ok(reads.some(url => url.includes('/onboarding/pending')))
    assert.ok(!reads.some(url => /session-list|\/agents|onboarding\/commands/.test(url)), reads.join('\n'))
    await leaf.evaluate(() => window.unmountFixture())
    const pendingCount = requests.filter(url => url.includes('/onboarding/pending')).length
    await new Promise(resolve => setTimeout(resolve, 5200))
    assert.equal(requests.filter(url => url.includes('/onboarding/pending')).length, pendingCount)
  } finally { await leaf.close() }
})
