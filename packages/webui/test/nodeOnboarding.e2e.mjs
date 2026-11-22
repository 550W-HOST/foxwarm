import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { createMainHostProxy } from './mainHostProxy.mjs'

// SystemView runs against an owned managed Main behind a recording proxy at a deployment prefix.
// Pending pairings come from the official CLI Node client using the shared pairing token.
let fixture, proxy, browser, page, baseUrl, fixtureUrl
const clients = []
const errors = []
let delayCommands = false
let failNextCreate = false
let delayCreateResponse = false
const createdResponses = []
const delayed = []
const exchanges = () => proxy.requests.map(record => ({ ...record, url: record.url.replace(/^\/deployment/, '') }))
const requests = { filter: check => exchanges().map(record => record.url).filter(check), join: separator => exchanges().map(record => record.url).join(separator), slice: start => exchanges().slice(start).map(record => record.url), get length() { return proxy.requests.length } }
const counter = route => () => exchanges().filter(record => record.path === route).length
const commandReadCount = counter('/api/nodes/onboarding/commands'), createCallCount = counter('/api/nodes/onboarding/create')
const nodesFile = async () => JSON.parse(await fs.readFile(path.join(fixture.data, 'state/nodes.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"approvedNodes":{},"pendingPairings":{}}'; throw error }))
const registry = {
  listApprovedNodes: async () => Object.keys((await nodesFile()).approvedNodes || {}),
  listPendingPairings: async () => (await fixture.api('GET', '/deployment/api/nodes/onboarding/pending')).body.items,
  rejectPendingPairing: async pendingId => assert.equal((await fixture.api('POST', '/deployment/api/nodes/onboarding/reject', { pendingId })).status, 200),
  authenticates: async (nodeId, token) => (await nodesFile()).approvedNodes?.[nodeId]?.tokenHash === createHash('sha256').update(token).digest('hex'),
  async createPendingPairing(id) {
    const before = (await this.listPendingPairings()).length
    const home = path.join(fixture.root, id); await fs.ensureDir(path.join(home, 'agents'))
    const child = spawn(process.execPath, [path.resolve('packages/cli-node/dist/client.js'), '--host', fixture.origin + '/deployment', '--credentials-file', path.join(home, 'credentials.json'), '--no-local-trigger', '--token', 'synthetic-pairing-credential', '--id', id], {
      cwd: home, env: { ...testEnvironment.isolatedApplicationEnv(home), FOXWARM_AGENTS_DIR: path.join(home, 'agents') }, stdio: 'ignore',
    })
    clients.push(child)
    await until(async () => (await this.listPendingPairings()).length > before, 'pending pairing from ' + id)
    return child
  },
}
const component = fileURLToPath(new URL('../src/components/SystemView.tsx', import.meta.url))
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
  fixture = await createHostFixture('node-onboarding-ui')
  await fs.writeFile(path.join(fixture.data, 'state/node_token'), 'synthetic-pairing-credential')
  const bundle = await build({ absWorkingDir: packageRoot, stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import SystemView from ${JSON.stringify(component)}; import {initializeThemeRuntime} from ${JSON.stringify(theme)}; initializeThemeRuntime();
      window.fixtureClipboard=''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text}}});
      const root=createRoot(document.getElementById('root')); function Fixture(){ const [section,setSection]=React.useState('sessions'); window.fixtureShowSessions=()=>setSection('sessions'); return React.createElement(SystemView,{currentSession:'main/browser-fixture',onSelectSession:()=>{},section,onSectionChange:setSection}); } root.render(React.createElement(Fixture));`,
    loader: 'tsx', resolveDir: packageRoot, sourcefile: 'node-onboarding-fixture.tsx',
  }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, alias: webuiReactAliases,
  define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  const assets = await fs.readdir(new URL('../dist/assets/', import.meta.url))
  const css = await fs.readFile(new URL(`../dist/assets/${assets.find(name => /^index-.*\.css$/.test(name))}`, import.meta.url), 'utf8')
  proxy = await createMainHostProxy({ target: fixture.origin, prefix: '/deployment', page: () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`, intercept: async (record, { send, respond }) => {
    if (record.path === '/api/nodes/onboarding/create') {
      if (failNextCreate) { failNextCreate = false; respond({ status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not create this Node.' }) }); return true }
      // The actual route persists trust before its one-time response is held back.
      if (delayCreateResponse) { const result = await send({ buffered: true }); createdResponses.push(() => respond(result)); return true }
    }
    if (delayCommands && record.path === '/api/nodes/onboarding/commands') { await new Promise(resolve => delayed.push(resolve)); return false }
    return false
  } })
  baseUrl = proxy.origin
  fixtureUrl = `${baseUrl}/deployment/`
  await fs.writeFile(path.join(fixture.data, 'state/config.yaml'), JSON.stringify({ url: baseUrl + '/deployment', bot: { httpPort: fixture.port, enableTrigger: false }, vector: { enabled: false }, dbWorkers: false }))
  await fixture.start()
  assert.equal((await fixture.api('POST', '/deployment/api/sessions', { agentId: 'main', sessionId: 'browser-fixture' })).status, 200)
  assert.equal((await fixture.api('POST', '/deployment/api/nodes/onboarding/create', { nodeId: 'offline-example' })).status, 200)
  await registry.createPendingPairing('synthetic-laptop')
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 1280, height: 900 })
  await page.setCookie({ name: 'foxwarm_token', value: fixture.token, url: baseUrl, httpOnly: true })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('[data-system-session-list]')
})

after(async () => {
  await browser?.close()
  for (const child of clients) child.kill('SIGKILL')
  await proxy?.close()
  await fixture?.cleanup()
})

test('Nodes is a real independent surface; pending approval, inline copy and explicit Shell creation use authenticated APIs', { timeout: 45_000 }, async () => {
  assert.equal(commandReadCount(), 0, 'ordinary System loading never requests credentials')
  await page.waitForFunction(() => /[1-9]\d* of [1-9]\d* loaded sessions/.test(document.body.innerText))
  const positions = []
  for (const section of ['Agents', 'Sessions', 'Nodes']) {
    await page.click(`[data-system-tab="${section.toLowerCase()}"]`)
    await page.waitForFunction(name => [...document.querySelectorAll('.foxwarm-system-tab')].some(button => button.textContent === name && button.getAttribute('aria-selected') === 'true'), {}, section)
    positions.push(await page.$eval('.foxwarm-system-tab', button => button.parentElement.getBoundingClientRect().left))
    // Each section shows only its own summary.
    assert.deepEqual(await page.$$eval('[data-system-summary]', items => items.map(item => item.getAttribute('data-system-summary'))), [section.toLowerCase()])
  }
  assert.ok(Math.max(...positions) - Math.min(...positions) < 1, 'the section switch retains its horizontal position')
  await page.waitForSelector('[data-node-surface]')
  await page.waitForFunction(() => document.body.innerText.includes('1 pending approvals'))
  const nodeText = await page.$eval('[data-node-surface]', element => element.textContent)
  assert.ok(nodeText.includes('master') && nodeText.includes('offline-example') && nodeText.includes('Offline'))
  assert.equal(await page.$('input[aria-label="Search sessions, models, tools"]'), null)
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('loaded of'))
  assert.equal(commandReadCount(), 0)
  await screenshot('nodes-surface.png')
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForSelector('.mobile-system-page [data-node-surface]')
  await screenshot('nodes-surface-narrow.png')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewport({ width: 1280, height: 900 })
  await page.waitForSelector('.mobile-system-page', { hidden: true })
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
  const readCount = commandReadCount()
  const second = await registry.createPendingPairing('synthetic-second-laptop')
  await page.waitForFunction(() => document.body.innerText.includes('2 pending approvals'), { timeout: 8000 })
  assert.equal(commandReadCount(), readCount, 'pending refresh does not reload pairing credentials')
  await click('Approve')
  await page.waitForFunction(() => document.body.innerText.includes('1 pending approvals'))
  assert.equal((await registry.listApprovedNodes()).length, 2)
  // Stop the remaining client first so it cannot request pairing again after rejection.
  second.kill('SIGKILL'); await once(second, 'exit')
  const [stale] = await registry.listPendingPairings()
  await registry.rejectPendingPairing(stale.id)
  await click('Approve')
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(element => element.textContent.includes('Pending pairing not found')))
  await page.click('button[aria-label="Refresh pending approvals"]')
  await page.waitForFunction(() => !document.querySelector('[role=alert]'))

  await click('Linux Shell')
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
  await page.evaluate(() => window.fixtureShowSessions())
  await page.waitForSelector('input[aria-label="Search sessions, models, tools"]')
  await page.click('[data-system-tab="nodes"]')
  await page.waitForSelector('[data-node-surface]')
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await click('Linux Shell')
  assert.equal(await page.$('[data-node-command]'), null, 'closed credentials are not reused on reopening')
  assert.equal((await registry.listApprovedNodes()).length, 3)
  await click('Close New nodes')
  delayCommands = true
  const beforeDelayed = commandReadCount()
  await click('New nodes')
  await page.waitForFunction(() => document.querySelector('[role=dialog]'))
  while (commandReadCount() === beforeDelayed) await new Promise(resolve => setTimeout(resolve, 20))
  await click('Close New nodes')
  delayCommands = false; delayed.splice(0).forEach(resume => resume())
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
  const callsBefore = createCallCount()
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await idle()
  for (const method of ['Linux CLI', 'Interactive CLI', 'Docker', 'Windows CLI']) {
    await click(method)
    assert.ok((await command()).includes('synthetic-pairing-credential'), method)
    await choose('Pre-created token')
    assert.equal(await page.$('[data-node-command]'), null, method)
    assert.ok(await page.$('input[aria-label="Node name"]:enabled'))
    await choose('Pairing approval')
    assert.ok((await command()).includes('synthetic-pairing-credential'), method)
  }
  assert.equal(createCallCount(), callsBefore, 'method and authentication switches never call create')
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
  await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('Node id already exists'))
  await idle()
  assert.equal(await page.$('[data-node-command]'), null)
  assert.equal((await registry.listApprovedNodes()).length, baseline)
  await replace('Node name', 'browser-token')
  const address = "https://token.example.invalid/deploy'path/$literal"
  await replace('Reachable address', address)
  await replace('Installation directory', "/opt/node's directory/$literal")
  failNextCreate = true
  const failedCall = createCallCount()
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent === 'Could not create this Node.')
  await idle()
  assert.equal(createCallCount(), failedCall + 1, 'failure is not retried automatically')
  assert.equal((await registry.listApprovedNodes()).length, baseline)
  assert.equal(await page.$('[data-node-command]'), null)
  await click('Create')
  await page.waitForFunction(() => document.querySelector('[data-node-command]')?.textContent.includes('--auth-token='))
  await idle()
  const token = /--auth-token='([a-f0-9]{64})'/.exec(await command())[1]
  assert.equal(await registry.authenticates('browser-token', token), true)
  assert.equal((await registry.listApprovedNodes()).length, baseline + 1)
  const callsAfterCreate = createCallCount()
  for (const method of ['Linux CLI', 'Interactive CLI', 'Docker', 'Windows CLI', 'Linux Shell']) {
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
  assert.equal(createCallCount(), callsAfterCreate, 'reusing a token across methods never creates another identity')
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
  assert.equal(createCallCount(), callsAfterCreate)
  assert.equal((await registry.listApprovedNodes()).length, baseline + 1)
  await screenshot('new-nodes-precreated-token.png')
  // Crossing the phone breakpoint restyles System without remounting the open modal.
  const modalInput = await page.$('input[aria-label="Node name"]')
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForSelector('.mobile-system-page')
  assert.ok(await modalInput.evaluate(element => element.isConnected), 'the phone frame keeps the open modal')
  await screenshot('new-nodes-precreated-token-narrow.png')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewport({ width: 1280, height: 900 })
  await page.waitForSelector('.mobile-system-page', { hidden: true })
  assert.equal(await modalInput.evaluate(element => element.isConnected && element.value), 'browser-token')
  await modalInput.dispose()
  assert.ok((await command()).includes(token), 'the created token command survives the layout change')
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
  assert.equal(createCallCount(), callsAfterCreate + 1, 'closing never retries creation')
  await click('Close New nodes')
  assert.deepEqual(errors, [])
})


test('System opened on Nodes never loads setup credentials, and unmount cancels pending polling', async () => {
  const bundle = await build({ absWorkingDir: packageRoot, stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import SystemView from ${JSON.stringify(component)}; const root=createRoot(document.getElementById('root')); window.unmountFixture=()=>root.unmount(); root.render(React.createElement(SystemView,{section:'nodes',onSelectSession:()=>{}}));`,
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
    assert.ok(!reads.some(url => /onboarding\/commands/.test(url)), reads.join('\n'))
    await leaf.evaluate(() => window.unmountFixture())
    const pendingCount = requests.filter(url => url.includes('/onboarding/pending')).length
    await new Promise(resolve => setTimeout(resolve, 5200))
    assert.equal(requests.filter(url => url.includes('/onboarding/pending')).length, pendingCount)
  } finally { await leaf.close() }
})
