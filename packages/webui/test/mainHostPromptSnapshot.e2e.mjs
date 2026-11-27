// Saved prompt history through authenticated routes and the original App. Technical views
// show the exact serialized snapshot without synthetic wrapper markers, Conversation omits it,
// and Session debug exposes the persisted bytes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { WebSocketServer } from 'ws'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'
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
const repoRoot = resolve(import.meta.dirname, '../../..')
const claudePeerDir = join(fixture.root, 'claude-peer')
const claudeConfigDir = join(fixture.root, 'claude-config')
await mkdir(claudePeerDir, { recursive: true })
await mkdir(claudeConfigDir, { recursive: true })
options.env.CLAUDE_CONFIG_DIR = claudeConfigDir
const claudeLauncher = join(fixture.root, 'claude-peer-launcher')
await writeFile(
  claudeLauncher,
  `#!/bin/sh\nexport FOXWARM_CLAUDE_PEER_DIRECTORY='${claudePeerDir}'\nexport FOXWARM_REPO_ROOT='${repoRoot}'\nexec ${JSON.stringify(process.execPath)} '${join(repoRoot, 'dotnet/Foxwarm.Tests/Mcp/Fixtures/claude-runtime-peer.mjs')}' "$@"\n`
)
await chmod(claudeLauncher, 0o755)
await writeFile(join(claudePeerDir, 'peer.json'), JSON.stringify({ answer: 'WIRE-DONE-claude', exitAfterResult: true }))

const wireRequests = {}
const peer = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let bytes = Buffer.concat(chunks)
  if (request.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes)
  if (request.headers['content-encoding'] === 'br') bytes = brotliDecompressSync(bytes)
  const body = JSON.parse(bytes.toString('utf8'))
  const protocol = request.url.includes('/a/') ? 'anthropic'
    : request.url.includes('/c/') ? 'completions'
    : 'responses'
  wireRequests[protocol] = body
  if (protocol === 'anthropic') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'snap-anthropic', type: 'message', role: 'assistant', model: 'wire', content: [{ type: 'text', text: 'WIRE-DONE-anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 3 } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (protocol === 'responses') {
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'snap-responses', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WIRE-DONE-responses' }] }], usage: { input_tokens: 40, output_tokens: 3 } } }) + '\n\n')
    return
  }
  response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'WIRE-DONE-completions' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n')
})
const wsServer = new WebSocketServer({ noServer: true })
peer.on('upgrade', (request, socket, head) => wsServer.handleUpgrade(request, socket, head, ws => wsServer.emit('connection', ws)))
wsServer.on('connection', ws => {
  ws.on('message', raw => {
    wireRequests.ws = JSON.parse(raw.toString('utf8'))
    ws.send(JSON.stringify({ type: 'response.completed', response: { id: 'snap-ws', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WIRE-DONE-ws' }] }], usage: { input_tokens: 40, output_tokens: 3 } } }))
  })
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
const peerBase = 'http://127.0.0.1:' + peer.address().port

options.cwd = fixture.work
options.publicRoot = fixture.origin + '/preview/#session/saved-prompt'
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `url: ${fixture.origin}/preview\nbot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\nclaudeCode:\n  executable: ${claudeLauncher}\n  credentialLifetimeSeconds: 5\n`)
await writeModelFixture(fixture.data, {
  default: 'r',
  providers: {
    r: { providerType: 'openai-responses', baseUrl: peerBase + '/r', models: ['wire'], contextLimit: 20000 },
    w: { providerType: 'openai-ws', baseUrl: peerBase + '/w', models: ['wire'], contextLimit: 20000 },
    c: { providerType: 'openai-completions', baseUrl: peerBase + '/c', models: ['wire'], contextLimit: 20000 },
    a: { providerType: 'anthropic', extraFields: { stream: false }, baseUrl: peerBase + '/a', models: ['wire'], contextLimit: 20000 },
  },
})
const stored = '  SAVED_PROMPT_FIRST_LINE\r\nExact <literal> & "quotes" \\ café 🦊\nLast saved line.\n\n'
const diskMarker = 'CHANGED_MEMORY_NOT_YET_REFRESHED'
const sessionDir = join(fixture.data, 'state/sessions')
await mkdir(sessionDir, { recursive: true })
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/CURRENT.md'), `${diskMarker}\n<foxwarm-system kind="event" type="literal-memory-line">\nLiteral memory body\n</foxwarm-system>\n`)
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
// The Session's rows have rendered: its latest row, or the saved reading position it returns to.
async function waitChat(sessionId) {
  await waitForWebUiReady(page)
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.waitForFunction(id => document.querySelector('.foxwarm-chat-root')?.dataset.chatSessionId === id
    && /Retained row \d+/.test(document.querySelector('[data-chat-timeline="committed"]')?.innerText || ''), {}, sessionId)
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
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Debug info'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Debug info')?.click())
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

// The snapshot is the first row of the timeline, and the timeline mounts rows as the reader
// approaches them: read upward with the wheel until it is mounted.
async function readUpToSnapshot() {
  const box = await (await page.$('.foxwarm-chat-messages')).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let step = 0; step < 60 && !await page.$(snapshotCard); step++) {
    await page.mouse.wheel({ deltaY: -1500 })
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function readExpandedSnapshotBody() {
  await page.waitForSelector(snapshotCard)
  // This checks saved content, not pointer geometry. Viewport restoration can move
  // the top card between Puppeteer's scroll/coordinate lookup and mouse dispatch.
  // Resolve and activate the disclosure in one browser turn so the click reaches it.
  await page.$eval(snapshotCard, card => card.querySelector('[aria-label="Expand snapshot message"]')?.click())
  await page.waitForSelector(snapshotCard + ' .foxwarm-system-message-body')
  return page.$eval(snapshotCard + ' .foxwarm-system-message-body', element => element.textContent)
}

async function assertSnapshotRow(expected) {
  await page.waitForFunction(() => /Retained row \d+/.test(document.querySelector('[data-chat-timeline="committed"]')?.innerText || ''))
  await readUpToSnapshot()
  const body = await readExpandedSnapshotBody()
  assert.equal(body, expected, 'snapshot row displays exact saved prompt text')
  assert.equal(body.includes('<foxwarm-system kind="snapshot"'), false, 'snapshot row omits any synthetic snapshot marker')
}

async function waitTurnDone(sessionId, replyText) {
  await until(async () => {
    const value = JSON.parse(await readFile(join(sessionDir, sessionId + '.json'), 'utf8'))
    return !value.busy && value.history.some(row => row.parts?.some(part => part.text === replyText))
  }, sessionId + ' -> ' + replyText)
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
  await waitChat('saved-prompt')
  await assertSnapshotRow(stored)
  assert.equal(await debugSnapshot('saved-prompt'), stored)
  const firstReconnect = await page.evaluate(() => window.fixtureSubscriptionAcks)
  await page.evaluate(() => { for (const socket of window.fixtureSockets) socket.close() })
  await page.waitForFunction(previous => window.fixtureSubscriptionAcks > previous, {}, firstReconnect)
  await assertSnapshotRow(stored)
  await page.evaluate(() => window.foxwarmTest.switchToSession('empty-prompt'))
  await waitChat('empty-prompt')
  await assertNoSnapshotRow('empty snapshot has no row')
  assert.equal(await debugSnapshot('empty-prompt'), '')
  await page.evaluate(() => window.foxwarmTest.switchToSession('saved-prompt'))
  await waitChat('saved-prompt')
  for (const name of ['grouped', 'conversation', 'detailed']) {
    await view(name)
    if (name === 'conversation') await assertNoSnapshotRow('Conversation omits the memory snapshot', true)
    else await assertSnapshotRow(stored)
  }
  // Explicit refresh persists a new prompt; ordinary App reload rereads that authority.
  const refresh = await fixture.api('POST', '/api/sessions/saved-prompt/refresh-memory', {})
  assert.equal(refresh.status, 200)
  const refreshed = (await fixture.api('GET', route)).body.persistentMemorySnapshot
  assert(refreshed.includes(diskMarker))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitChat('saved-prompt')
  await assertSnapshotRow(refreshed)
  assert.equal(await debugSnapshot('saved-prompt'), refreshed)
  assert.equal(JSON.parse(await readFile(join(sessionDir, 'saved-prompt.json'), 'utf8')).persistentMemorySnapshot, refreshed)

  // Pin exact equality between the displayed snapshot card and the serialized request text
  // across every provider path (Anthropic, Responses HTTP/WS, Chat Completions) plus Claude Code.
  const providerCases = [
    { key: 'anthropic', sessionId: 'wire-anthropic', model: 'a/wire', reply: 'WIRE-DONE-anthropic', extract: () => wireRequests.anthropic.system },
    { key: 'responses', sessionId: 'wire-responses', model: 'r/wire', reply: 'WIRE-DONE-responses', extract: () => { assert.equal(wireRequests.responses.input[0].role, 'developer'); return wireRequests.responses.input[0].content[0].text } },
    { key: 'ws', sessionId: 'wire-ws', model: 'w/wire', reply: 'WIRE-DONE-ws', extract: () => { assert.equal(wireRequests.ws.input[0].role, 'developer'); return wireRequests.ws.input[0].content[0].text } },
    { key: 'completions', sessionId: 'wire-completions', model: 'c/wire', reply: 'WIRE-DONE-completions', extract: () => { assert.equal(wireRequests.completions.messages[0].role, 'system'); return wireRequests.completions.messages[0].content } },
  ]
  for (const item of providerCases) {
    assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: item.sessionId })).status, 200)
    assert.equal((await fixture.api('POST', `/api/sessions/${item.sessionId}/model`, { model: item.model })).status, 200)
    assert.equal((await fixture.api('POST', `/api/sessions/${item.sessionId}/message`, { text: 'PING-' + item.key })).status, 202)
    await waitTurnDone(item.sessionId, item.reply)
    const serialized = item.extract()
    assert.equal(serialized.includes('<foxwarm-system kind="snapshot"'), false, item.key + ' wire request must not include snapshot marker')
    assert.equal(serialized.includes('Literal memory body'), true, item.key + ' wire request preserves literal memory tags')
    assert.equal((await fixture.api('GET', `/api/sessions/${item.sessionId}/history`)).body.persistentMemorySnapshot, serialized)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), item.sessionId)
    await waitForWebUiReady(page)
    await page.waitForFunction(id => document.querySelector('.foxwarm-chat-root')?.dataset.chatSessionId === id, {}, item.sessionId)
    assert.equal(await readExpandedSnapshotBody(), serialized, item.key + ' displayed snapshot equals serialized request text')
  }

  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'wire-claude', runtime: 'claude-code' })).status, 200)
  assert.equal((await fixture.api('POST', '/api/sessions/wire-claude/message', { text: 'PING-claude' })).status, 202)
  await waitTurnDone('wire-claude', 'WIRE-DONE-claude')
  const claudePrompt = JSON.parse((await readFile(join(claudePeerDir, 'inputs.jsonl'), 'utf8')).trim().split('\n')[0]).prompt
  assert.equal(claudePrompt.includes('<foxwarm-system kind="snapshot"'), false, 'Claude Code prompt file must not include snapshot marker')
  assert.equal(claudePrompt.includes('Literal memory body'), true, 'Claude Code prompt file preserves literal memory tags')
  assert.equal((await fixture.api('GET', '/api/sessions/wire-claude/history')).body.persistentMemorySnapshot, claudePrompt)
  await page.evaluate(() => window.foxwarmTest.switchToSession('wire-claude'))
  await waitForWebUiReady(page)
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.dataset.chatSessionId === 'wire-claude')
  assert.equal(await readExpandedSnapshotBody(), claudePrompt, 'Claude Code displayed snapshot equals prompt file text')

  console.log(JSON.stringify({ exactSavedText: true, wireEquality: [...providerCases.map(item => item.key), 'claude'], emptySnapshot: true, modeAwareSnapshotRows: true, reconnect: true, refreshedSnapshotAfterReload: true, historyRequests: requests, errors }))
  assert.deepEqual(errors, [])
  await fixture.stop()
} catch (error) {
  console.error('Original App diagnostic:', await page?.evaluate(() => ({ hash: location.hash, text: document.body.innerText.slice(-14000) })))
  console.error({ requests, sockets: await page?.evaluate(() => window.fixtureSockets?.map(socket => ({ url: socket.url, state: socket.readyState }))) }); console.error(fixture.output)
  throw error
} finally {
  peer.close()
  await fixture.cleanup()
}
