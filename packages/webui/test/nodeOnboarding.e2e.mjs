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
const delayed = []
const component = fileURLToPath(new URL('../src/components/ArchitectureView.tsx', import.meta.url))
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
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import ArchitectureView from ${JSON.stringify(component)}; import {initializeThemeRuntime} from ${JSON.stringify(theme)}; initializeThemeRuntime();
      window.fixtureClipboard=''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text}}});
      createRoot(document.getElementById('root')).render(React.createElement(ArchitectureView,{currentSession:'main/browser-fixture',onSelectSession:()=>{}}));`,
    loader: 'tsx', resolveDir: packageRoot, sourcefile: 'node-onboarding-fixture.tsx',
  }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, alias: webuiReactAliases,
  define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  const assets = await fs.readdir(new URL('../dist/assets/', import.meta.url))
  const css = await fs.readFile(new URL(`../dist/assets/${assets.find(name => /^index-.*\.css$/.test(name))}`, import.meta.url), 'utf8')
  server = new HttpServer(0, 'synthetic-browser-auth')
  server.app.use((req, _res, next) => {
    if (req.url.startsWith('/deployment/')) req.url = req.url.slice('/deployment'.length)
    requests.push(req.url)
    if (req.path === '/api/nodes/onboarding/commands') commandReads++
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
  for (const surface of ['Topology', 'Agents', 'Nodes']) {
    await click(surface)
    await page.waitForFunction(name => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].some(button => button.textContent === name && button.getAttribute('aria-pressed') === 'true'), {}, surface)
    positions.push(await page.$eval('.foxwarm-architecture-surface-tab', button => button.parentElement.getBoundingClientRect().left))
    assert.ok(!(await page.$eval('header', header => header.innerText)).includes('loaded of'))
    if (surface !== 'Nodes') assert.deepEqual(await sessionCard(), counts, 'summary-card values and loaded counts are retained')
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
  await click('Topology')
  await page.waitForSelector('input[aria-label="Search sessions, models, tools"]')
  assert.ok((await page.evaluate(() => document.body.innerText)).includes('Execution topology'))
  await click('Nodes')
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
