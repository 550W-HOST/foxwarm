import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE
const dataRoot = process.env.FOXWARM_E2E_DATA_DIR
const providerUrl = process.env.FOXWARM_E2E_PROVIDER_URL
const toolFile = process.env.FOXWARM_E2E_TOOL_FILE
const artifactDir = process.env.FOXWARM_E2E_ARTIFACT_DIR
const chromium = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
assert.ok(baseUrl && tokenFile && dataRoot && providerUrl && toolFile && artifactDir)
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
let browser
let page
const browserConsole = []

async function api(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${init.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function createSession(name) {
  const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId: 'main', sessionId: name }) })
  return result.sessionId
}

async function openSession(sessionId) {
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), sessionId)
  await page.waitForFunction(id => (document.querySelector('.foxwarm-chat-root')?.textContent || '').includes(`session ${id}`), { timeout: 15_000 }, sessionId)
  await page.waitForSelector('[role="textbox"][aria-label="Message"]', { timeout: 15_000 })
}

async function sendMessage(text) {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.click(editor)
  await page.type(editor, text)
  await page.click('button[aria-label="Send message"]')
}

async function history(sessionId) {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/history`)
}

async function waitForIdle(sessionId, timeout = 20_000) {
  await page.waitForFunction(async id => {
    const response = await fetch(`./api/sessions/${encodeURIComponent(id)}/state`)
    if (!response.ok) return false
    const value = await response.json()
    return value.session?.runtimeState === 'idle' || value.runtimeState === 'idle' || value.session?.busy === false
  }, { timeout }, sessionId)
}

async function providerState() {
  return fetch(`${providerUrl}/__control/state`).then(response => response.json())
}

async function scenario(name, run) {
  try { await run() }
  catch (error) {
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', `core-${name}.png`), fullPage: true }).catch(() => {})
    throw error
  }
}

before(async () => {
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('console', message => browserConsole.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', error => browserConsole.push(`pageerror: ${error.stack || error.message}`))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.foxwarmTest, { timeout: 15_000 })
})

after(async () => {
  await fs.writeFile(path.join(artifactDir, 'logs', 'core-browser-console.log'), browserConsole.join('\n'))
  await browser?.close()
})

test('browser send streams incrementally, commits exactly once, and survives reload', async () => scenario('incremental', async () => {
  const sessionId = await createSession('core-incremental')
  await openSession(sessionId)
  await sendMessage('APP_E2E_INCREMENTAL')
  await page.waitForFunction(() => document.body.textContent?.includes('streamed '), { timeout: 15_000 })
  assert.equal(await page.evaluate(() => document.body.textContent?.includes('streamed answer')), false)
  await page.waitForFunction(() => document.body.textContent?.includes('streamed answer'), { timeout: 15_000 })
  await waitForIdle(sessionId)
  const canonical = await history(sessionId)
  const committed = canonical.messages.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'streamed answer'))
  assert.equal(committed.length, 1)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('streamed answer'), { timeout: 15_000 })
  assert.equal(await page.$$eval('[data-chat-timeline="committed"]', roots => roots.flatMap(root => [...root.querySelectorAll('*')]).filter(node => node.textContent === 'streamed answer').length > 0), true)
  const state = await providerState()
  const request = state.requests.find(entry => entry.marker === 'INCREMENTAL')
  assert.equal(request.protocol, 'responses')
  assert.equal(request.body.stream, true)
}))

test('Responses tool loop writes and reads a safe file before the final model answer', async () => scenario('responses-tool', async () => {
  const sessionId = await createSession('core-responses-tool')
  await openSession(sessionId)
  await sendMessage('APP_E2E_TOOL')
  await page.waitForFunction(() => document.body.textContent?.includes('tool roundtrip complete'), { timeout: 20_000 })
  await waitForIdle(sessionId)
  assert.equal(await fs.readFile(toolFile, 'utf8'), 'app e2e tool payload')
  const canonical = await history(sessionId)
  const wire = JSON.stringify(canonical.messages)
  assert.match(wire, /call_app_write/)
  assert.match(wire, /call_app_read/)
  assert.match(wire, /app e2e tool payload/)
  assert.equal(canonical.messages.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'tool roundtrip complete')).length, 1)
}))

test('Stop aborts a held stream and later input can run as a new turn', async () => scenario('stop', async () => {
  const sessionId = await createSession('core-stop')
  await openSession(sessionId)
  await sendMessage('APP_E2E_STOP')
  await page.waitForFunction(() => document.body.textContent?.includes('held stream'), { timeout: 15_000 })
  const stopped = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === 'Stop')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click(); return true
  })
  assert.equal(stopped, true)
  await waitForIdle(sessionId)
  await sendMessage('APP_E2E_AFTER_STOP')
  await page.waitForFunction(() => document.body.textContent?.includes('after stop complete'), { timeout: 20_000 })
  await waitForIdle(sessionId)
  const canonical = await history(sessionId)
  assert.equal(canonical.messages.some(message => message.parts?.some(part => part.text === 'held stream should stop')), false)
  assert.equal(canonical.messages.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'after stop complete')).length, 1)
}))

test('empty Responses output_text completes without another provider request', async () => scenario('empty', async () => {
  const beforeCount = (await providerState()).requests.filter(entry => entry.marker === 'EMPTY').length
  const sessionId = await createSession('core-empty')
  await openSession(sessionId)
  await sendMessage('APP_E2E_EMPTY')
  await page.waitForFunction(async id => {
    const response = await fetch(`./api/sessions/${encodeURIComponent(id)}/history`)
    if (!response.ok) return false
    const payload = await response.json()
    return payload.messages?.some(message => message.role === 'model')
  }, { timeout: 15_000 }, sessionId)
  await waitForIdle(sessionId)
  const authority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  assert.ok(authority.history.some(message => message.role === 'model' && message.parts?.some(part => part.text === '')))
  const afterCount = (await providerState()).requests.filter(entry => entry.marker === 'EMPTY').length
  assert.equal(afterCount - beforeCount, 1)
}))

test('Chat Completions streaming tool call uses the same real tool and persistence loop', async () => scenario('chat-tool', async () => {
  const sessionId = await createSession('core-chat-tool')
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { method: 'POST', body: JSON.stringify({ model: 'chat/mock-chat', effort: 'none' }) })
  await openSession(sessionId)
  await sendMessage('APP_E2E_CHAT')
  await page.waitForFunction(() => document.body.textContent?.includes('chat tool complete'), { timeout: 20_000 })
  await waitForIdle(sessionId)
  assert.equal(await fs.readFile(`${toolFile}.chat`, 'utf8'), 'chat tool payload')
  const canonical = await history(sessionId)
  const wire = JSON.stringify(canonical.messages)
  assert.match(wire, /call_chat_write/)
  assert.equal(canonical.messages.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'chat tool complete')).length, 1)
  const state = await providerState()
  assert.ok(state.requests.filter(entry => entry.marker === 'CHAT').every(entry => entry.protocol === 'chat'))
}))
