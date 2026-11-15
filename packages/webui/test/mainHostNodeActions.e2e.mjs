// Production System Nodes with administrator HTTP, official clients and disposable state.
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const options = {}
const fixture = await createHostFixture('node-actions', options)
const prefix = '/node-actions-proof', host = fixture.origin + prefix
options.publicRoot = host
const target = join(fixture.root, 'provider'); await mkdir(target)
await writeFile(join(fixture.data, 'state/config.yaml'), JSON.stringify({ url: host, bot: { httpPort: fixture.port, enableTrigger: false }, vector: false,
  nodeProviders: { fixture: { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), target], timeoutSeconds: 3 } } }))
await writeFile(fixture.modelPath, 'default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n')
const api = (method, path, body) => fixture.api(method, prefix + path, body)
const nodes = async () => (await api('GET', '/api/nodes')).body.nodes
const clients = [], requests = [], errors = []
let page, holdReissue = false, held
async function click(text, selector = '[data-node-actions]') {
  await page.waitForFunction((text, selector) => [...document.querySelectorAll(`${selector} button`)].some(button => (button.textContent.trim() === text || button.getAttribute('aria-label') === text) && !button.disabled), {}, text, selector)
  const button = await page.evaluateHandle((text, selector) => [...document.querySelectorAll(`${selector} button`)].find(button => (button.textContent.trim() === text || button.getAttribute('aria-label') === text) && !button.disabled), text, selector)
  await button.asElement().click(); await button.dispose()
}
async function open(id, action = 'Start command') { await click(action, `[data-system-node-id="${id}"]`); await page.waitForFunction(() => document.querySelector('[data-node-actions]')?.open && !document.querySelector('[data-node-actions] [role="status"]')) }
async function close() { await click('Close Node actions'); await page.waitForSelector('[data-node-actions]', { hidden: true }) }
async function create(id, parentNode) { const result = await api('POST', '/api/nodes/onboarding/create', { nodeId: id, baseUrl: host, parentNode }); assert.equal(result.status, 200); return result.body.authToken }
async function client(id, auth, native) {
  const root = join(fixture.root, id); await mkdir(root)
  const command = native ? join(process.env.DOTNET_ROOT, 'dotnet') : process.execPath
  const entry = resolve(native ? 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll' : 'packages/cli-node/dist/client.js')
  const child = spawn(command, [entry, '--host', host, '--id', id, '--auth-token', auth, '--credentials-file', join(root, 'credentials.json'), '--no-local-trigger'], {
    cwd: root, env: { ...testEnvironment.isolatedApplicationEnv(root), FOXWARM_NODE_LAUNCH_METHOD: 'bareMetalBackground', FOXWARM_NODE_LAUNCH_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes }); clients.push(child)
  await until(async () => { if (child.exitCode !== null) throw new Error(output); return (await nodes()).find(node => node.id === id && node.online && node.launchInfo?.installDir === root) }, id + ' reports launch facts')
  return root
}
try {
  await fixture.start()
  await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'node-actions' })
  const oldToken = await create('saved-cli'), shellToken = await create('shell'), nativeToken = await create('native-cli')
  await create('parent'); await create('child', 'parent'); await create('offline')
  const installDir = await client('saved-cli', oldToken, false)
  await client('native-cli', nativeToken, true)
  const shell = await fetch(host + '/node/shell/register', { method: 'POST', headers: { authorization: 'Bearer ' + shellToken, 'X-Foxwarm-Node': 'shell', 'X-Foxwarm-Shell-Dialect': 'powershell', 'Content-Type': 'application/octet-stream' }, body: 'C:\\Node' })
  assert.equal(shell.status, 204)
  page = await fixture.openApp()
  await page.setViewport({ width: 1100, height: 900 })
  await page.evaluate(() => {
    window.copiedText = ''; window.failCopy = false
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if (window.failCopy) throw new Error('Copy denied'); window.copiedText = text } } })
    location.hash = 'nodes'
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }))
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (holdReissue && request.url().endsWith('/reissue-token')) {
      holdReissue = false
      void fetch(request.url(), { method: 'POST', headers: { authorization: 'Bearer ' + fixture.token, 'content-type': 'application/json' }, body: request.postData() })
        .then(async response => { held = { request, status: response.status, body: await response.text() } })
    } else void request.continue()
  })
  await page.waitForSelector('[data-system-node-id="saved-cli"]')
  assert.equal(await page.$('[data-system-node-id="master"] button:not([data-system-node-session])'), null)
  assert.equal(await page.$('[data-system-node-id="fixture/target"] button'), null)
  assert.equal(requests.filter(request => request.url.includes('restart-command') || request.url.includes('reissue-token')).length, 0)
  await open('saved-cli')
  assert.equal(await page.$eval('[aria-label="Installation directory"]', input => input.value), installDir)
  assert.equal(await page.$eval('[aria-label="Launch method"]', input => input.value), 'bareMetalBackground')
  let command = await page.$eval('[data-node-start-command]', element => element.textContent)
  assert(command.includes(host)); assert(command.includes(installDir)); assert(command.endsWith(' -d'))
  assert(!command.includes(oldToken)); assert(!command.includes('--pairing')); assert(!command.includes('--auth-token'))
  await click('Copy command'); assert.equal(await page.evaluate(() => window.copiedText), command)
  await page.evaluate(() => { window.failCopy = true }); await click('Copied')
  await page.waitForSelector('[data-node-actions] [role="alert"]')
  await page.evaluate(() => { window.failCopy = false })
  await click('Reissue token'); await click('Cancel')
  assert.equal(requests.filter(request => request.url.endsWith('/reissue-token')).length, 0)
  await click('Reissue token'); await click('Reissue and show command')
  await page.waitForSelector('[aria-label="New Node token"]')
  const newToken = await page.$eval('[aria-label="New Node token"]', input => input.value)
  assert.notEqual(newToken, oldToken)
  command = await page.$eval('[data-node-start-command]', element => element.textContent)
  assert(command.includes(newToken))
  await click('Copy token'); assert.equal(await page.evaluate(() => window.copiedText), newToken)
  assert.equal(await page.$eval('[aria-label="Launch method"]', element => element.matches(':disabled')), true)
  await close(); await open('saved-cli')
  assert.equal(await page.$('[aria-label="New Node token"]'), null)
  assert(!(await page.$eval('[data-node-start-command]', element => element.textContent)).includes(newToken))
  await close()
  await open('shell')
  assert.equal(await page.$eval('[aria-label="Launch method"]', input => input.value), 'windowsShell')
  assert.equal(await page.$('[data-node-start-command]'), null)
  await click('Reissue token'); await click('Reissue and show command')
  await page.waitForSelector('[aria-label="New Node token"]')
  assert((await page.$eval('[data-node-start-command]', element => element.textContent)).includes('run-shell.ps1'))
  const shellReplacement = await page.$eval('[aria-label="New Node token"]', input => input.value)
  for (const [credential, status] of [[shellToken, 401], [shellReplacement, 204]]) {
    const registration = await fetch(host + '/node/shell/register', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'X-Foxwarm-Node': 'shell', 'X-Foxwarm-Shell-Dialect': 'powershell', 'Content-Type': 'application/octet-stream' }, body: 'C:\\Node' })
    assert.equal(registration.status, status)
  }
  await close()
  await open('offline')
  await page.$eval('[aria-label="Installation directory"]', element => { element.focus(); element.select() })
  await page.keyboard.type('/srv/edited-node')
  assert.equal(await page.$('[data-node-start-command]'), null)
  await click('Update command'); await page.waitForSelector('[data-node-start-command]')
  assert((await page.$eval('[data-node-start-command]', element => element.textContent)).includes('/srv/edited-node'))
  await click('Reissue token'); holdReissue = true; await click('Reissue and show command')
  await until(() => held, 'accepted reissue response held')
  await close(); await held.request.respond({ status: held.status, contentType: 'application/json', body: held.body }).catch(() => {})
  await open('offline'); assert.equal(await page.$('[aria-label="New Node token"]'), null)
  await close()
  await open('parent', 'Delete')
  assert.equal(await page.$$eval('[data-node-actions] button', elements => elements.find(element => element.textContent.trim() === 'Delete Node').disabled), true)
  assert((await page.$eval('[data-node-actions]', element => element.textContent)).includes('child'))
  await page.click('[data-node-actions] input[type="checkbox"]'); await click('Delete Node')
  await page.waitForSelector('[data-system-node-id="parent"]', { hidden: true })
  assert(!(await nodes()).some(node => node.id === 'child'))
  await open('offline', 'Delete'); await click('Cancel'); assert((await nodes()).some(node => node.id === 'offline'))
  await open('offline', 'Delete'); await click('Delete Node'); await page.waitForSelector('[data-system-node-id="offline"]', { hidden: true })
  // Native dialog cancellation discards command state.
  await open('saved-cli')
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-node-actions]', { hidden: true })
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  assert(!stored.includes(newToken)); assert(!requests.some(request => request.url.includes(newToken)))
  const persisted = await readFile(join(fixture.data, 'state/nodes.json'), 'utf8')
  assert(!persisted.includes(newToken)); assert(!persisted.includes(oldToken))
  assert.deepEqual(errors, [])
  console.log('System Nodes: real client launch facts, credential-free copy, reissue/disconnect lifecycle, modal secret disposal, delete/cascade, Provider exclusion passed.')
} finally {
  for (const child of clients) if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped }
  await fixture.cleanup()
}
