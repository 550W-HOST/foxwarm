import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

async function waitForProvider(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await providerState()
    if (predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for scripted provider state')
}

async function waitForAuthority(sessionId, predicate, timeout = 20_000) {
  const authorityPath = path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const authority = JSON.parse(await fs.readFile(authorityPath, 'utf8'))
    if (predicate(authority)) return authority
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${sessionId} authority`)
}

function assertCommittedCompaction(authority, before, summary) {
  const blockMessage = authority.history[0]
  assert.equal(blockMessage.role, 'model')
  assert.match(blockMessage.parts?.[0]?.text || '', new RegExp(`^\\[CTX-BLOCK L1 B#1 raw#1-#4 time .+\\] ${summary}$`))
  assert.deepEqual({
    level: blockMessage.__meta?.contextBlock?.level,
    sourceKind: blockMessage.__meta?.contextBlock?.sourceKind,
    sourceStart: blockMessage.__meta?.contextBlock?.sourceStart,
    sourceEnd: blockMessage.__meta?.contextBlock?.sourceEnd,
    rawStartSeq: blockMessage.__meta?.contextBlock?.rawStartSeq,
    rawEndSeq: blockMessage.__meta?.contextBlock?.rawEndSeq,
  }, { level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 4, rawStartSeq: 1, rawEndSeq: 4 })
  assert.equal(authority.history.some(message => Number.isInteger(message.__meta?.seq) && message.__meta.seq <= 4), false)
  assert.deepEqual(authority.history.slice(1, -1), before.history.slice(4))
  assert.match(authority.history.at(-1)?.parts?.[0]?.system || '', /kind="session-boundary" event="compact-completed"/)
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
  if (process.env.FOXWARM_APP_E2E_INTERRUPT_HOLD === '1') {
    console.log('APP_E2E_INTERRUPT_READY')
    await new Promise(resolve => setTimeout(resolve, 300_000))
  }
  const release = await fetch(`${providerUrl}/__control/release-incremental`, { method: 'POST' })
  assert.equal(release.status, 204)
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
  const authority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  const calls = authority.history.flatMap(message => message.parts || []).map(part => part.functionCall).filter(Boolean)
  const results = authority.history.flatMap(message => message.parts || []).map(part => part.functionResponse).filter(Boolean)
  assert.deepEqual(calls.map(call => [call.id, call.name]), [['call_app_write', 'write'], ['call_app_read', 'read']])
  assert.deepEqual(results.map(result => [result.tool_use_id, result.name]), [['call_app_write', 'write'], ['call_app_read', 'read']])
  assert.match(results[1].response.output, /app e2e tool payload/)
  assert.equal(authority.history.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'tool roundtrip complete')).length, 1)
}))

test('Stop aborts a held stream and later input can run as a new turn', async () => scenario('stop', async () => {
  const sessionId = await createSession('core-stop')
  await openSession(sessionId)
  await sendMessage('APP_E2E_STOP')
  await page.waitForFunction(() => document.body.textContent?.includes('held stream'), { timeout: 15_000 })
  await page.click('button::-p-text(Stop)')
  await waitForIdle(sessionId)
  await waitForProvider(state => state.stopAborted === true)
  await sendMessage('APP_E2E_AFTER_STOP')
  await page.waitForFunction(() => document.body.textContent?.includes('after stop complete'), { timeout: 20_000 })
  await waitForIdle(sessionId)
  const authority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  assert.ok(authority.history.some(message => message.role === 'user' && JSON.stringify(message.parts).includes('APP_E2E_STOP')))
  assert.equal(authority.history.some(message => message.role === 'model' && message.parts?.some(part => part.text?.includes('held stream'))), false)
  assert.equal(authority.history.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'after stop complete')).length, 1)
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
  const authority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  const call = authority.history.flatMap(message => message.parts || []).map(part => part.functionCall).find(Boolean)
  const result = authority.history.flatMap(message => message.parts || []).map(part => part.functionResponse).find(Boolean)
  assert.deepEqual([call.id, call.name], ['call_chat_write', 'write'])
  assert.deepEqual([result.tool_use_id, result.name], ['call_chat_write', 'write'])
  assert.match(result.response.output, /File written successfully/)
  assert.equal(authority.history.filter(message => message.role === 'model' && message.parts?.some(part => part.text === 'chat tool complete')).length, 1)
  const state = await providerState()
  assert.ok(state.requests.filter(entry => entry.marker === 'CHAT').every(entry => entry.protocol === 'chat'))
}))

test('Responses WebSocket reuses one completed prefix, reconnects with full replay, and forks an independent chain', async () => scenario('ws-fork', async () => {
  const sessionId = await createSession('core-ws')
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { method: 'POST', body: JSON.stringify({ model: 'ws/mock-ws', effort: 'none' }) })
  await openSession(sessionId)

  await sendMessage('APP_E2E_WS_ONE')
  await page.waitForFunction(() => document.body.textContent?.includes('ws answer one'), { timeout: 15_000 })
  await waitForIdle(sessionId)
  const afterOne = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  const storedPromptCacheKey = afterOne.promptCacheKey
  assert.equal(typeof storedPromptCacheKey, 'string')

  await sendMessage('APP_E2E_WS_TWO')
  await page.waitForFunction(() => document.body.textContent?.includes('ws answer two'), { timeout: 15_000 })
  await waitForIdle(sessionId)
  const closeResponse = await fetch(`${providerUrl}/__control/close-ws`, { method: 'POST' })
  assert.equal(closeResponse.status, 204)

  await sendMessage('APP_E2E_WS_THREE')
  await page.waitForFunction(() => document.body.textContent?.includes('ws answer three'), { timeout: 15_000 })
  await waitForIdle(sessionId)
  const parentAuthority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${sessionId}.json`), 'utf8'))
  assert.equal(parentAuthority.promptCacheKey, storedPromptCacheKey)

  const fork = await api(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: 'POST', body: JSON.stringify({ suffix: 'child' }) })
  const childId = fork.newSessionId
  await openSession(childId)
  await sendMessage('APP_E2E_FORK_CHILD')
  await page.waitForFunction(() => document.body.textContent?.includes('fork child answer'), { timeout: 15_000 })
  await waitForIdle(childId)

  const childAuthority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${childId}.json`), 'utf8'))
  assert.equal(childAuthority.parentSessionId, sessionId)
  assert.ok(childAuthority.history.some(message => message.parts?.some(part => part.text === 'ws answer three')))
  assert.equal(childAuthority.history.filter(message => message.parts?.some(part => part.text === 'fork child answer')).length, 1)

  const wsRequests = (await providerState()).wsRequests
  const one = wsRequests.find(entry => entry.marker === 'WS_ONE')
  const two = wsRequests.find(entry => entry.marker === 'WS_TWO')
  const three = wsRequests.find(entry => entry.marker === 'WS_THREE')
  const child = wsRequests.find(entry => entry.marker === 'FORK_CHILD')
  const semanticInput = item => ({
    type: item.type,
    role: item.role,
    text: Array.isArray(item.content) ? item.content.map(part => part.text || '').join('') : '',
  })
  assert.equal(one.connectionId, two.connectionId)
  assert.notEqual(two.connectionId, three.connectionId)
  assert.equal(two.body.previous_response_id, 'ws-resp-one')
  assert.equal(two.body.input.length, 1)
  const secondInput = semanticInput(two.body.input[0])
  assert.equal(secondInput.type, 'message')
  assert.equal(secondInput.role, 'user')
  assert.match(secondInput.text, /APP_E2E_WS_TWO/)
  assert.doesNotMatch(JSON.stringify(two.body.input), /APP_E2E_WS_ONE|ws answer one/)
  assert.equal(three.body.previous_response_id, undefined)
  assert.equal(three.body.input.length, 5)
  const replay = three.body.input.map(semanticInput)
  assert.match(replay[0].text, /APP_E2E_WS_ONE/)
  assert.deepEqual(replay[1], { type: 'message', role: 'assistant', text: 'ws answer one' })
  assert.match(replay[2].text, /APP_E2E_WS_TWO/)
  assert.deepEqual(replay[3], { type: 'message', role: 'assistant', text: 'ws answer two' })
  assert.match(replay[4].text, /APP_E2E_WS_THREE/)
  assert.equal(child.body.previous_response_id, undefined)
  assert.equal(one.body.prompt_cache_key, crypto.createHash('sha256').update(sessionId).digest('hex'))
  assert.equal(child.body.prompt_cache_key, crypto.createHash('sha256').update(childId).digest('hex'))
  assert.notEqual(one.body.prompt_cache_key, child.body.prompt_cache_key)
}))

test('browser attachment upload and long pasted text reach the provider, persist canonically, and clear accepted drafts', async () => scenario('attachment-longpaste', async () => {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nEAAAAAASUVORK5CYII='
  const attachmentSession = await createSession('core-attachment')
  await openSession(attachmentSession)
  await page.type('[role="textbox"][aria-label="Message"]', 'APP_E2E_ATTACHMENT ')
  await page.$eval('#file-upload', (input, encodedPng) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['synthetic attachment body'], 'fixture-note.txt', { type: 'text/plain' }))
    const png = Uint8Array.from(atob(encodedPng), character => character.charCodeAt(0))
    transfer.items.add(new File([png], 'fixture-pixel.png', { type: 'image/png' }))
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, pngBase64)
  await page.waitForSelector('.foxwarm-composer-attachment-chip')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => document.body.textContent?.includes('attachment accepted'), { timeout: 20_000 })
  await waitForIdle(attachmentSession)
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 0)
  assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', node => node.textContent), '')
  assert.equal(await page.evaluate(id => localStorage.getItem(`composer_draft_v1_${id}`), attachmentSession), null)
  const attachmentAuthority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${attachmentSession}.json`), 'utf8'))
  const attachmentWire = JSON.stringify(attachmentAuthority.history)
  assert.match(attachmentWire, /fixture-note\.txt/)
  assert.match(attachmentWire, /fixture-pixel\.png/)
  assert.match(attachmentWire, /attachment-ref|foxwarm-attachment/)
  const imageParts = attachmentAuthority.history.flatMap(message => message.parts || []).filter(part => part.inlineDataRef)
  assert.equal(imageParts.length, 1)
  const imageRef = imageParts[0].inlineDataRef
  assert.deepEqual({ format: imageRef.format, mimeType: imageRef.mimeType, byteLength: imageRef.byteLength }, { format: 'png', mimeType: 'image/png', byteLength: 68 })
  assert.equal(attachmentWire.includes('"inlineData":'), false)
  assert.equal(attachmentWire.includes(pngBase64), false)
  const blob = await fs.readFile(path.join(dataRoot, 'state', 'image-blobs', imageRef.blobId.slice(0, 2), imageRef.blobId))
  assert.deepEqual(blob, Buffer.from(pngBase64, 'base64'))
  assert.equal(crypto.createHash('sha256').update(blob).digest('hex'), imageRef.sha256)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('attachment accepted'), { timeout: 15_000 })

  const pasteSession = await createSession('core-longpaste')
  await openSession(pasteSession)
  await page.type('[role="textbox"][aria-label="Message"]', 'APP_E2E_LONGPASTE ')
  const pasted = `${'synthetic long paste '.repeat(180)}\nlong paste exact tail`
  await page.$eval('[role="textbox"][aria-label="Message"]', (editor, text) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', text)
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  }, pasted)
  await page.waitForSelector('.foxwarm-composer-pasted-text-chip')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => document.body.textContent?.includes('long paste accepted'), { timeout: 20_000 })
  await waitForIdle(pasteSession)
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-pasted-text-chip').length === 0)
  assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', node => node.textContent), '')
  assert.equal(await page.evaluate(id => localStorage.getItem(`composer_draft_v1_${id}`), pasteSession), null)
  const pasteAuthority = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${pasteSession}.json`), 'utf8'))
  assert.match(JSON.stringify(pasteAuthority.history), /<pasted-text>[\s\S]*long paste exact tail/)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('long paste accepted'), { timeout: 15_000 })
}))

test('WS compact planning and BTW use purpose-scoped request keys without replacing persisted cache identity', async () => scenario('compact-btw', async () => {
  const syncId = 'core-compact-sync'
  const syncBefore = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${syncId}.json`), 'utf8'))
  await openSession(syncId)
  await sendMessage('/compact 20')
  await waitForProvider(state => state.wsRequests.some(entry => entry.marker === 'COMPACT_SYNC'))
  const syncAuthority = await waitForAuthority(syncId, authority => JSON.stringify(authority.history).includes('compact_sync summary'))
  const syncStoredKey = syncAuthority.promptCacheKey
  assert.equal(syncStoredKey, syncBefore.promptCacheKey)
  assertCommittedCompaction(syncAuthority, syncBefore, 'compact_sync summary')

  const backgroundId = 'core-compact-background'
  const backgroundBefore = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${backgroundId}.json`), 'utf8'))
  await openSession(backgroundId)
  await sendMessage('/compact 20')
  await waitForProvider(state => state.wsRequests.some(entry => entry.marker === 'COMPACT_BACKGROUND'))
  const backgroundAuthority = await waitForAuthority(backgroundId, authority => JSON.stringify(authority.history).includes('compact_background summary'))
  const backgroundStoredKey = backgroundAuthority.promptCacheKey
  assert.equal(backgroundStoredKey, backgroundBefore.promptCacheKey)
  assertCommittedCompaction(backgroundAuthority, backgroundBefore, 'compact_background summary')

  const btwId = 'core-btw'
  const btwBefore = JSON.parse(await fs.readFile(path.join(dataRoot, 'state', 'sessions', `${btwId}.json`), 'utf8')).promptCacheKey
  await openSession(btwId)
  await sendMessage('/btw APP_E2E_BTW')
  await page.waitForFunction(() => document.body.textContent?.includes('btw side answer'), { timeout: 20_000 })
  const btwAuthority = await waitForAuthority(btwId, authority => JSON.stringify(authority.history).includes('btw side answer'))
  const btwStoredKey = btwAuthority.promptCacheKey
  assert.equal(btwStoredKey, btwBefore)
  assert.match(syncStoredKey, /^[0-9a-f-]{36}$/)
  assert.match(backgroundStoredKey, /^[0-9a-f-]{36}$/)
  assert.match(btwStoredKey, /^[0-9a-f-]{36}$/)

  const state = await providerState()
  const sync = state.wsRequests.find(entry => entry.marker === 'COMPACT_SYNC')
  const background = state.wsRequests.find(entry => entry.marker === 'COMPACT_BACKGROUND')
  const btw = state.wsRequests.find(entry => entry.marker === 'BTW')
  assert.equal(sync.body.prompt_cache_key, crypto.createHash('sha256').update(syncId).digest('hex'))
  assert.equal(background.body.prompt_cache_key, crypto.createHash('sha256').update(`${backgroundId}--compact-plan`).digest('hex'))
  assert.equal(btw.body.prompt_cache_key, crypto.createHash('sha256').update(`${btwId}--btw`).digest('hex'))
}))
