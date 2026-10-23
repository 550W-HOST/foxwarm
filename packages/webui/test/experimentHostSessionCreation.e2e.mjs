// Unchanged original creation dialogs against an owned normal Main, not mocked callbacks.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: {} }
const fixture = await createHostFixture('session-creation', options)
options.cwd = fixture.work
options.publicRoot = fixture.origin + '/#session/browser%2Fmain'
options.onPage = opened => { page = opened }
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, `bot: {httpPort: ${fixture.port}}\nvector: false\n`)
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
const roots = async () => (await fixture.api('GET', '/api/session-list/sidebar?limit=50')).body.sessions.map(row => row.id)
const saved = async id => JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
let page
async function openDialog() {
  await page.click('button[aria-label="New session"]')
  await page.waitForSelector('[role="dialog"] input[placeholder^="Random ID"]')
}
async function submit(path) {
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path)
  await page.click('[role="dialog"] button[type="submit"]')
  const actual = await response, body = await actual.json()
  assert.equal(actual.status(), path === '/api/agents' ? 201 : 200, JSON.stringify(body))
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  await until(async () => (await roots())[0] === body.sessionId, 'created root first')
  return body.sessionId
}
try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'browser' })).status, 201)
  const opening = fixture.openApp()
  await until(() => page, 'owned browser page')
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(() => window.foxwarmTest.switchToSession('browser/main'))
  page = await opening
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  await openDialog()
  await page.click('[role="dialog"] button[title="main"]')
  const ordinary = await submit('/api/sessions')
  assert.match(ordinary, /^\d{4}_[a-z0-9]{5}$/)
  await openDialog()
  await page.click('[role="dialog"] button[title="browser"]')
  const scoped = await submit('/api/sessions')
  assert.match(scoped, /^browser\/\d{4}_[a-z0-9]{5}$/)
  await openDialog()
  await page.click('[role="dialog"] button[title="browser"]')
  await page.type('[role="dialog"] input[placeholder^="Random ID"]', 'Explicit_ID')
  assert.equal(await submit('/api/sessions'), 'browser/Explicit_ID')
  await openDialog()
  await page.click('[role="dialog"] button[aria-label="New agent"]')
  await page.type('[role="dialog"] input[placeholder="my-agent"]', 'frontend-agent')
  assert.equal(await submit('/api/agents'), 'frontend-agent/main')
  assert.deepEqual((await roots()).slice(0, 4), ['frontend-agent/main', 'browser/Explicit_ID', scoped, ordinary])
  for (const id of [ordinary, scoped, 'browser/Explicit_ID', 'frontend-agent/main']) {
    const state = await saved(id)
    const history = await fixture.api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history')
    assert.equal(history.status, 200); assert.equal(history.body.session.id, id)
    assert.equal(state.parentSessionId, undefined)
    assert.equal(state.displayName, undefined); assert.equal(state.cwd, undefined)
    assert.equal(state.currentNode, 'master'); assert.equal(state.history.length, 0)
    assert.equal(state.queue.length, 0); assert.equal(state.busy, false)
    assert(state.persistentMemorySnapshot.includes('local/wire'))
  }
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.foxwarm-chat-root')
  assert.deepEqual((await roots()).slice(0, 4), ['frontend-agent/main', 'browser/Explicit_ID', scoped, ordinary])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ originalApp: true, ordinary, scoped, explicit: 'browser/Explicit_ID', agentMain: 'frontend-agent/main', rootOrderAndReload: true }))
  await fixture.stop()
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 3000) })).catch(() => null))
  throw error
} finally { await fixture.cleanup() }
