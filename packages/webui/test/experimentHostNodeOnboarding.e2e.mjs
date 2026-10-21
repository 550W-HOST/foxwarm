// Original production App, managed Main and unchanged official CLI, all with owned data.
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { waitForWebUiReady } from './webuiReadiness.mjs'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const env = { FOXWARM_BIND_ADDRESS: '127.0.0.1', FOXWARM_SYNC_FILE_LOG: '0' }
const options = { normalStartup: true, env }
const fixture = await createHostFixture('node-onboarding', options)
const prefix = '/onboarding-proof', host = fixture.origin + prefix
env.FOXWARM_PUBLIC_BASE_URL = host
env.FOXWARM_AGENTS_DIR = join(fixture.data, 'agents')
await writeFile(join(fixture.data, 'state/config.yaml'), `bot: {httpPort: ${fixture.port}, enableTrigger: false}\nvector: {enabled: false}\n`)
await writeFile(fixture.modelPath, 'default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n')
const requests = [], created = [], clients = [], errors = []
let page, browser
const api = (method, path, body) => fixture.api(method, prefix + path, body)
const nodes = async () => (await api('GET', '/api/nodes')).body.nodes
const approved = async () => Object.keys(JSON.parse(await readFile(join(fixture.data, 'state/nodes.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"approvedNodes":{}}'; throw error })).approvedNodes)
async function click(text) {
  const button = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text || button.getAttribute('aria-label') === text), text)
  assert(button.asElement(), 'Button: ' + text); await button.asElement().click(); await button.dispose()
}
async function replace(label, value) {
  await page.$eval(`input[aria-label="${label}"]`, input => { input.focus(); input.select() })
  await page.keyboard.type(value)
}
const command = () => page.$eval('[data-node-command]', element => element.textContent)
async function readyCommand(fragment) {
  await page.waitForFunction(fragment => document.querySelector('[data-node-command]')?.textContent.includes(fragment), {}, fragment)
}
async function cli(name, args) {
  const root = join(fixture.root, name); await mkdir(join(root, 'agents'), { recursive: true })
  const child = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', host, '--credentials-file', join(root, 'credentials.json'), '--no-local-trigger', ...args], {
    cwd: root, env: { ...testEnvironment.isolatedApplicationEnv(root), FOXWARM_AGENTS_DIR: join(root, 'agents') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const handle = { child, output: '' }; clients.push(handle)
  child.stdout.on('data', bytes => { handle.output += bytes }); child.stderr.on('data', bytes => { handle.output += bytes })
  return handle
}
try {
  await fixture.start()
  assert.equal((await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'onboarding' })).status, 200)
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(fixture.root, 'browser') })
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(host + '/', { waitUntil: 'networkidle0' })
  await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', fixture.token); await page.click('button[type="submit"]')
  await page.waitForSelector('[data-workbench-status-bar]'); await waitForWebUiReady(page)
  page.on('request', request => requests.push({ url: request.url(), body: request.postData() || '' }))
  page.on('response', async response => {
    if (response.url().endsWith('/api/nodes/onboarding/create') && response.status() === 200) created.push(await response.json())
  })
  // Navigate through the real workbench status bar, not a replacement component fixture.
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.waitForSelector('[data-workbench-status-popup] [aria-label="Node directory"]')
  await click('Open Nodes'); await page.waitForSelector('[data-node-surface]')
  assert.equal(requests.filter(request => request.url.includes('/onboarding/commands')).length, 0)
  await click('New nodes'); await readyCommand('--pairing=')
  assert.equal(await page.$eval('[aria-label="Reachable address"]', input => input.value), host)
  const pairingToken = (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()
  assert((await command()).includes(pairingToken))
  assert.deepEqual(await approved(), [])
  // The default mode still runs the actual shared-token request/approve/register lifecycle.
  await cli('pairing-cli', ['--token', pairingToken, '--id', 'paired-browser'])
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Approve'))
  await click('Approve')
  await until(async () => (await nodes()).some(node => node.id === 'paired-browser' && node.online && node.executable), 'original pairing CLI registered')
  await page.click('input[type="radio"][name="node-authentication"]:not(:checked)')
  assert.equal(await page.$('[data-node-command]'), null)
  assert.deepEqual(await approved(), ['paired-browser'])
  await replace('Node name', 'browser-direct')
  await click('Create'); await readyCommand("--node-id='browser-direct'")
  await until(() => created.length === 1, 'explicit creation response')
  const credential = created[0], token = credential.authToken
  assert.equal(credential.baseUrl, host)
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.deepEqual((await approved()).sort(), ['browser-direct', 'paired-browser'])
  await click('Linux CLI'); await page.click('[role="dialog"] input[type="checkbox"]'); await readyCommand('--install')
  await replace('Installation directory', "/opt/browser node's directory")
  assert.equal(await page.$('[data-node-command]'), null)
  await click('Update command'); await readyCommand("--dir='/opt/browser node'\"'\"'s directory'")
  assert((await command()).includes(token))
  const regeneration = requests.filter(request => request.url.includes('/onboarding/commands')).at(-1)
  assert.equal(JSON.parse(regeneration.body).authToken, token)
  assert.equal(requests.filter(request => request.url.endsWith('/onboarding/create')).length, 1)
  // The original Node client consumes exactly the returned direct credential and reconnects after Main restart.
  await cli('direct-cli', ['--auth-token', token, '--id', 'browser-direct'])
  await until(async () => (await nodes()).some(node => node.id === 'browser-direct' && node.online && node.executable), 'original direct-auth CLI registered')
  const disk = await readFile(join(fixture.data, 'state/nodes.json'), 'utf8'); assert(!disk.includes(token))
  const summaries = JSON.stringify((await api('GET', '/api/nodes')).body) + JSON.stringify((await api('GET', '/api/nodes/onboarding/pending')).body)
  assert(!summaries.includes(token)); assert(!summaries.includes('tokenHash'))
  assert(!fixture.output.includes(token)); assert(!fixture.output.includes(pairingToken))
  const log = await readFile(join(fixture.data, 'state/logs/foxwarm.log'), 'utf8')
  assert(!log.includes(token)); assert(!log.includes(pairingToken))
  await click('Close New nodes')
  await fixture.stop(); await fixture.start()
  await until(async () => (await nodes()).filter(node => node.id === 'browser-direct' && node.online && node.executable).length === 1, 'direct credential survives cold Main restart')
  assert.deepEqual((await approved()).sort(), ['browser-direct', 'paired-browser'])
  assert.deepEqual(errors, [])
  console.log('Original App onboarding: default pairing and approval, explicit token creation, regeneration without rotation, secret-free summaries/logs and original CLI authentication across Main restart passed.')
} catch (error) {
  console.error(fixture.output)
  throw error
} finally {
  for (const { child } of clients) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  await browser?.close()
  await fixture.cleanup()
}
