// Retained pre-Node authority on the normal host and unchanged original App.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const options = { env: {} }
const fixture = await createHostFixture('legacy-node-projection', options)
options.cwd = fixture.root
options.publicRoot = fixture.origin + '/preview/#session/legacy-absent'
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `url: ${fixture.origin}/preview\nbot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n`)
const sessions = join(fixture.data, 'state/sessions')
await mkdir(sessions, { recursive: true })
const variants = [['legacy-absent', {}], ['legacy-null', { currentNode: null }], ['explicit-remote', { currentNode: 'retained-remote' }]]
const originals = new Map(), rows = {}
for (const [id, placement] of variants) {
  const raw = {
    sessionStateVersion: 1, id, agent: 'main', busy: false, history: [
      { role: 'user', parts: [{ text: 'Retained historical input' }], __meta: { seq: 1, timestamp: 100 } },
      { role: 'model', parts: [{ text: 'Retained historical reply' }], __meta: { seq: 2, timestamp: 200 } },
    ], queue: [], nextMessageSeq: 3, nextBlockId: 1, historyVersion: 0,
    stats: { totalCachedTokens: 4, totalInputTokens: 17, totalOutputTokens: 6 },
    meta: { messageCount: 2, lastMessageTime: 200 }, cwd: fixture.work,
    model: null, effort: 'high', verbose: false,
    promptCacheKey: '00000000000000000000000000000001', persistentMemorySnapshot: 'Retained snapshot',
    ...placement,
  }
  const bytes = JSON.stringify(raw)
  originals.set(id, bytes)
  await writeFile(join(sessions, id + '.json'), bytes)
  rows[id] = { id, agent: 'main', aliases: id === 'legacy-absent' ? ['legacy-alias'] : [], busy: false, queueLength: 0, meta: raw.meta, stats: raw.stats, cwd: raw.cwd, ...placement }
}
await writeFile(join(fixture.data, 'state/sessions.json'), JSON.stringify({ sessions: rows }))
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(sessions, id + '.json'), 'utf8')
async function assertRetained(id) {
  const original = JSON.parse(originals.get(id)), actual = JSON.parse(await saved(id))
  // Normal shutdown serializes lifecycle defaults; it must not manufacture a Node or change retained values.
  assert.equal(Object.hasOwn(actual, 'currentNode'), Object.hasOwn(original, 'currentNode'))
  for (const [key, value] of Object.entries(original)) assert.deepEqual(actual[key], value, 'Retained ' + id + ' field: ' + key)
}
const frames = [], observations = []
let socket
async function observe(page, id, expected, revision) {
  const history = await fixture.api('GET', route(id) + '/history')
  assert.equal(history.status, 200, JSON.stringify(history.body))
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision, sessionListActive: true, sessionIds: [id], sessionListIds: [id] }))
  await until(() => frames.find(frame => frame.type === 'subscriptions-applied' && frame.revision === revision), 'realtime subscription ' + revision)
  const realtime = frames.filter(frame => frame.type === 'session-state' && frame.sessionId === id).at(-1)
  assert(realtime)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await waitForWebUiReady(page)
  await page.waitForSelector('.foxwarm-node-picker-trigger')
  await page.waitForFunction(() => document.body.innerText.includes('Retained historical reply'))
  await page.click('.foxwarm-node-picker-trigger')
  await page.waitForSelector('[data-node-option="master"]')
  const trigger = await page.$eval('.foxwarm-node-picker-trigger', el => el.getAttribute('aria-label'))
  const masterPressed = await page.$eval('[data-node-option="master"]', el => el.getAttribute('aria-pressed'))
  await page.keyboard.press('Escape')
  observations.push({ id, revision, historyNode: history.body.session.currentNode, realtimeNode: realtime.session.currentNode, trigger, masterPressed })
  console.log(JSON.stringify(observations.at(-1)))
  assert.equal(history.body.session.currentNode, expected)
  assert.equal(realtime.session.currentNode, expected)
  assert.equal(trigger, 'Execution node: ' + expected)
  assert.equal(masterPressed, expected === 'master' ? 'true' : 'false')
  assert.equal(history.body.session.cwd, fixture.work)
  assert.equal(realtime.session.cwd, fixture.work)
  assert.deepEqual(history.body.messages, JSON.parse(originals.get(id)).history)
  const list = await fixture.api('POST', '/api/session-list/by-id', { ids: [id] })
  assert.equal(list.body.results[0].session.currentNode, expected)
  assert.equal(await saved(id), originals.get(id), 'Observation must not write authority')
}
try {
  await fixture.start()
  // No synthetic legacy main Session is needed to admit these actual catalog members.
  const cold = await fixture.api('POST', '/api/session-list/by-id', { ids: ['legacy-alias'] })
  assert.equal(cold.body.results[0].session.id, 'legacy-absent')
  assert.equal(cold.body.results[0].session.currentNode, 'master')
  socket = new WebSocket(fixture.origin.replace(/^http/, 'ws') + '/api/webui/stream', { headers: { authorization: 'Bearer ' + fixture.token } })
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())))
  await once(socket, 'open')
  const page = await fixture.openApp()
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  let revision = 0
  for (const [id] of variants) {
    await observe(page, id, id === 'explicit-remote' ? 'retained-remote' : 'master', ++revision)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
    await observe(page, id, id === 'explicit-remote' ? 'retained-remote' : 'master', ++revision)
  }
  // A missing built root chunk is a browser deployment fault, not a backend mode.
  const recovery = await page.browser().newPage()
  try {
    await recovery.setCacheEnabled(false)
    await recovery.setRequestInterception(true)
    let fail = true, blocked = ''
    recovery.on('request', request => {
      if (fail && /\/assets\/App-[^/]+\.js$/.test(new URL(request.url()).pathname)) {
        blocked = new URL(request.url()).pathname
        void request.respond({ status: 404, contentType: 'text/plain', body: 'Missing deployment chunk' })
      } else void request.continue()
    })
    await recovery.goto(options.publicRoot, { waitUntil: 'domcontentloaded' })
    await recovery.waitForSelector('#foxwarm-boot[data-state="error"]')
    assert(blocked.startsWith('/preview/assets/'), blocked)
    assert.match(await recovery.$eval('#foxwarm-boot-error', node => node.textContent), /import|fetch|load/i)
    fail = false
    await Promise.all([recovery.waitForNavigation({ waitUntil: 'domcontentloaded' }), recovery.click('#foxwarm-boot-reload')])
    await waitForWebUiReady(recovery)
    await recovery.waitForFunction(() => document.body.innerText.includes('Retained historical reply'))
    assert.equal(await recovery.evaluate(() => document.querySelector('meta[name="foxwarm-host"]')?.content), 'dotnet')
  } finally { await recovery.close() }
  socket.terminate(); socket = undefined
  await fixture.stop()
  for (const [id] of variants) await assertRetained(id)
  await fixture.start()
  for (const [id] of variants) {
    const history = await fixture.api('GET', route(id) + '/history')
    assert.equal(history.body.session.currentNode, id === 'explicit-remote' ? 'retained-remote' : 'master')
    await assertRetained(id)
  }
  await fixture.stop()
  console.log('Normal startup, retained authority, original picker, reload/realtime and cold restart passed without Node selection or provider calls.')
} finally {
  socket?.terminate()
  await fixture.cleanup()
}
