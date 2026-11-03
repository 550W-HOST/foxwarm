// Saved prompt history through authenticated routes and the original App. The timeline does not
// show the memory snapshot in any view; the Session debug view exposes the persisted snapshot.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const options = { env: {}, onPage: async page => {
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('foxwarm_timeline_view_v1', 'detailed')
    const originalStringify = JSON.stringify
    window.fixtureDebugCaptures = []
    JSON.stringify = function(value, ...args) {
      const text = originalStringify.call(this, value, ...args)
      if (value?.sessionId && value?.sessionPayload && value?.clientState) window.fixtureDebugCaptures.push(text)
      return text
    }
    const OriginalWebSocket = window.WebSocket
    window.fixtureSockets = []
    window.fixtureSubscriptionAcks = 0
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) { super(...args); window.fixtureSockets.push(this); this.addEventListener('message', event => { if (JSON.parse(event.data).type === 'subscriptions-applied') window.fixtureSubscriptionAcks++ }) }
    }
  })
} }
const fixture = await createHostFixture('prompt-snapshot', options)
options.cwd = fixture.work
options.publicRoot = fixture.origin + '/preview/#session/saved-prompt'
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `url: ${fixture.origin}/preview\nbot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n`)
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
const stored = '  SAVED_PROMPT_FIRST_LINE\r\nExact <literal> & "quotes" \\ café 🦊\nLast saved line.\n\n'
const diskMarker = 'CHANGED_MEMORY_NOT_YET_REFRESHED'
const sessionDir = join(fixture.data, 'state/sessions')
await mkdir(sessionDir, { recursive: true })
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/CURRENT.md'), diskMarker)
const rows = {}
for (const [id, snapshot] of [['saved-prompt', stored], ['empty-prompt', '']]) {
  const history = Array.from({ length: 104 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text: 'Retained row ' + (i + 1) }], __meta: { seq: i + 1, timestamp: 100 + i } }))
  const authority = { sessionStateVersion: 1, id, agent: 'main', busy: false, history, queue: [], nextMessageSeq: 105, nextBlockId: 1, historyVersion: 0, meta: { messageCount: 104, lastMessageTime: 203 }, stats: {}, cwd: fixture.work, model: null, effort: 'high', promptCacheKey: '00000000000000000000000000000001', persistentMemorySnapshot: snapshot }
  await writeFile(join(sessionDir, id + '.json'), JSON.stringify(authority))
  rows[id] = { id, agent: 'main', busy: false, queueLength: 0, meta: authority.meta, stats: {}, cwd: fixture.work }
}
await writeFile(join(fixture.data, 'state/sessions.json'), JSON.stringify({ sessions: rows }))
const route = '/api/sessions/saved-prompt/history'
const snapshotCard = '[data-system-message-kind="snapshot"]'
let page
const requests = [], errors = []
async function waitChat() {
  await waitForWebUiReady(page)
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.waitForFunction(() => document.body.innerText.includes('Retained row 104'))
}
async function view(name) {
  await page.click('[aria-label="Open session options"]')
  await page.waitForSelector('[role="radiogroup"][aria-label="Timeline view"]')
  await page.evaluate(name => {
    const button = [...document.querySelectorAll('[role="radiogroup"][aria-label="Timeline view"] [role="radio"]')].find(el => el.textContent.trim().toLowerCase() === name)
    if (!button) throw new Error('Missing Timeline mode ' + name)
    button.click()
  }, name)
  await page.waitForFunction(name => [...document.querySelectorAll('[role="radiogroup"][aria-label="Timeline view"] [role="radio"]')].some(el => el.textContent.trim().toLowerCase() === name && el.getAttribute('aria-checked') === 'true'), {}, name)
  await page.click('[aria-label="Open session options"]')
}
// The persisted snapshot as the Session debug view reports it.
async function debugSnapshot(sessionId) {
  const before = await page.evaluate(() => window.fixtureDebugCaptures.length)
  await page.click('[aria-label="Open session options"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'debug info'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info')?.click())
  await page.waitForFunction((count, id) => window.fixtureDebugCaptures.slice(count).some(text => JSON.parse(text).sessionId === id && JSON.parse(text).resolvedSessionFilePath), {}, before, sessionId)
  const capture = await page.evaluate((count, id) => window.fixtureDebugCaptures.slice(count).map(text => JSON.parse(text)).filter(value => value.sessionId === id && value.resolvedSessionFilePath).at(-1), before, sessionId)
  await page.click('[data-json-inspector-dialog] button[title="Close"]')
  await page.waitForFunction(() => !document.querySelector('[data-json-inspector-dialog]'))
  return capture.sessionPayload.persistentMemorySnapshot
}
// Wait until the view has rendered its rows (continuous Conversation renders its Archive window,
// which this seeded fixture leaves empty), then check that no snapshot row is present.
async function assertNoSnapshotRow(label, continuous = false) {
  if (continuous) await page.waitForSelector('[data-continuous-history]')
  else await page.waitForFunction(() => document.body.innerText.includes('Retained row 104'))
  assert.equal(await page.$(snapshotCard), null, label)
}

try {
  await fixture.start()
  assert.equal((await fetch(fixture.origin + route)).status, 401)
  for (const query of ['', '?tail=100', '?prefixLength=4&historyVersion=0', '?afterSeq=100&historyVersion=0']) {
    const history = await fixture.api('GET', route + query)
    assert.equal(history.status, 200)
    assert.equal(history.body.persistentMemorySnapshot, stored)
    assert.equal(Object.hasOwn(history.body.session, 'persistentMemorySnapshot'), false)
  }
  assert.equal((await fixture.api('GET', '/api/sessions/empty-prompt/history')).body.persistentMemorySnapshot, '')
  page = await fixture.openApp()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.url().includes('/saved-prompt/history')) requests.push(new URL(response.url()).search) })
  await page.evaluate(() => window.foxwarmTest.switchToSession('saved-prompt'))
  await waitChat()
  await assertNoSnapshotRow('detailed timeline omits the memory snapshot')
  assert.equal(await debugSnapshot('saved-prompt'), stored)
  const firstReconnect = await page.evaluate(() => window.fixtureSubscriptionAcks)
  await page.evaluate(() => { for (const socket of window.fixtureSockets) socket.close() })
  await page.waitForFunction(previous => window.fixtureSubscriptionAcks > previous, {}, firstReconnect)
  await assertNoSnapshotRow('reconnect does not restore a snapshot row')
  await page.evaluate(() => window.foxwarmTest.switchToSession('empty-prompt'))
  await waitChat()
  await assertNoSnapshotRow('empty snapshot has no row')
  assert.equal(await debugSnapshot('empty-prompt'), '')
  await page.evaluate(() => window.foxwarmTest.switchToSession('saved-prompt'))
  await waitChat()
  for (const name of ['grouped', 'conversation', 'detailed']) {
    await view(name)
    await assertNoSnapshotRow(name + ' timeline omits the memory snapshot', name === 'conversation')
  }
  // Explicit refresh persists a new prompt; ordinary App reload rereads that authority.
  const refresh = await fixture.api('POST', '/api/sessions/saved-prompt/refresh-memory', {})
  assert.equal(refresh.status, 200)
  const refreshed = (await fixture.api('GET', route)).body.persistentMemorySnapshot
  assert(refreshed.includes(diskMarker))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitChat()
  await assertNoSnapshotRow('reload keeps the snapshot out of the timeline')
  assert.equal(await debugSnapshot('saved-prompt'), refreshed)
  assert.equal(JSON.parse(await readFile(join(sessionDir, 'saved-prompt.json'), 'utf8')).persistentMemorySnapshot, refreshed)
  console.log(JSON.stringify({ exactSavedText: true, emptySnapshot: true, timelineRowsOmitted: true, reconnect: true, refreshedSnapshotAfterReload: true, historyRequests: requests, errors }))
  assert.deepEqual(errors, [])
  await fixture.stop()
} catch (error) {
  console.error('Original App diagnostic:', await page?.evaluate(() => ({ hash: location.hash, text: document.body.innerText.slice(-14000) })))
  console.error({ requests, sockets: await page?.evaluate(() => window.fixtureSockets?.map(socket => ({ url: socket.url, state: socket.readyState }))) }); console.error(fixture.output)
  throw error
} finally { await fixture.cleanup() }
