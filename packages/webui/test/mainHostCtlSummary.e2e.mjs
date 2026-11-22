// A ctl call's `summary` through the real host, original App and loopback model: the owner
// publishes it as the live activity, Chat shows it as the caption while the call runs, and a
// summary of the tool the command runs (Node exec) takes precedence over it.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const fixture = await createHostFixture('ctl-summary'), failures = [], rounds = new Map()
const screenshotDir = process.env.FOXWARM_E2E_SCREENSHOT_DIR
const route = id => '/api/sessions/' + encodeURIComponent(id)
const marks = join(fixture.work, 'marks')
const exists = path => access(path).then(() => true, () => false)
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const hold = key => `mkdir -p marks; touch marks/start-${key}; while [ ! -f marks/release-${key} ]; do sleep 0.05; done; echo released-${key}`
const ctl = (id, args) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name: 'ctl', arguments: JSON.stringify(args) })
const exec = (key, own) => ({ command: 'tool call node:master/exec --args @args', values: { args: { command: hold(key), timeout: 60, ...(own ? { summary: own } : {}) } } })
const cases = {
  'ctl-only': { call: { ...exec('ctl-only'), summary: 'Wait for the release marker' }, caption: 'Wait for the release marker' },
  both: { call: { ...exec('both', 'Hold until released'), summary: 'Outer ctl summary' }, caption: 'Hold until released' },
  none: { call: exec('none'), caption: undefined },
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), user = JSON.stringify(body.input.filter(item => item.role === 'user').at(-1) || {})
    const key = [...user.matchAll(/CTL-SUMMARY:([a-z-]+)/g)].at(-1)?.[1] || 'ordinary', n = rounds.get(key) || 0
    rounds.set(key, n + 1)
    const output = n === 0 && cases[key] ? [ctl('call-' + key, cases[key].call)] : [text('DONE-' + key)]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: `summary-${key}-${n}`, output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const state = async () => (await fixture.api('GET', route('main') + '/state')).body.session
const caption = page => page.$eval('[data-workbench-content-tab="chat:main"] [data-runtime-caption]', element => element.textContent.trim()).catch(() => undefined)
const shot = async (page, name) => { if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, name) }) } }
try {
  await fixture.start(); await mkdir(marks, { recursive: true })
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  const page = await fixture.openApp(); await page.setViewport({ width: 1280, height: 900 })
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('[data-workbench-content-tab="chat:main"] .foxwarm-chat-root[data-chat-connection-state="connected"]', { visible: true })
  const observed = {}
  for (const [key, { caption: expected }] of Object.entries(cases)) {
    assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'CTL-SUMMARY:' + key })).status, 202)
    await until(() => exists(join(marks, 'start-' + key)), 'the ctl-run exec started: ' + key)
    await until(async () => (await state()).runtimeState?.state === 'running-tool', 'running tool: ' + key)
    const runtime = (await state()).runtimeState
    assert.equal(runtime.activity?.tool, expected, key)
    if (expected) await until(async () => await caption(page) === expected, 'caption ' + expected)
    else await until(async () => /^Executing exec/.test(await caption(page) || ''), 'caption without a summary')
    observed[key] = { activity: runtime.activity ?? null, caption: await caption(page), argsPreview: runtime.tool?.argsPreview }
    // Only one summary is shown: the outer ctl summary appears nowhere in the live presentation.
    if (key === 'both') assert(!(await page.evaluate(() => document.body.innerText)).includes('Outer ctl summary'))
    await shot(page, `caption-${key}.png`)
    await writeFile(join(marks, 'release-' + key), '')
    await until(async () => { const session = await state(); return !session.busy && (await page.evaluate(() => document.body.innerText)).includes('DONE-' + key) }, 'done ' + key)
  }
  // The finished calls in Conversation (summary headers) and Detailed (argument headers).
  const chat = '[data-workbench-content-tab="chat:main"]'
  for (const button of await page.$$(`${chat} [aria-label="Expand activity"]`)) await button.click()
  await until(async () => (await page.$$(`${chat} .foxwarm-tool-card`)).length === 3, 'three Conversation cards')
  await new Promise(resolve => setTimeout(resolve, 800))
  const headers = () => page.$$eval(`${chat} .foxwarm-tool-call-summary`, elements => elements.map(element => element.textContent.replace(/\s+/g, ' ').trim()))
  observed.conversation = await headers()
  assert.deepEqual(observed.conversation.slice(0, 2), ['Wait for the release marker', 'Hold until released'])
  await shot(page, 'cards-conversation.png')
  await page.evaluate(() => localStorage.setItem('foxwarm_timeline_view_v1', 'detailed')); await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await until(async () => (await page.$$(`${chat} .foxwarm-tool-card`)).length === 3, 'three Detailed cards')
  await new Promise(resolve => setTimeout(resolve, 800))
  observed.detailed = await headers()
  assert(observed.detailed.every(header => header.includes('mkdir -p marks')), JSON.stringify(observed.detailed))
  await shot(page, 'cards-detailed.png')
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(JSON.stringify({ ok: true, observed, hostPids: fixture.hostPids }))
} finally {
  for (const key of Object.keys(cases)) await writeFile(join(marks, 'release-' + key), '').catch(() => {})
  peer.closeAllConnections(); await new Promise(done => peer.close(done)); await fixture.cleanup()
}
