// Session sequence view over real C# deliveries: columns, exact pairing highlight, live append and navigation.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const options = { env: {} }
const fixture = await createHostFixture('session-sequence', options)
options.cwd = process.cwd()
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeFile(join(fixture.work, 'NOTES.md'), 'Build notes\n')
const failures = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const text = (value, phase) => ({ type: 'message', role: 'assistant', ...(phase ? { phase } : {}), content: [{ type: 'output_text', text: value }] })
const contentText = item => typeof item.content === 'string' ? item.content : (item.content || []).map(part => part.text || '').join('\n')

// A coordinator and two workers: delegation, tool runs, commentary, reports back and a final answer.
function respond(input) {
  const answered = id => input.some(item => item.type === 'function_call_output' && item.call_id === id)
  const lastUser = contentText(input.findLast(item => item.role === 'user') || {})
  if (lastUser.includes('build passes') || lastUser.includes('docs updated')) return [text('Thanks, merging both changes.', 'final_answer')]
  if (lastUser.includes('second note')) return [text('Noted.', 'final_answer')]
  if (lastUser.includes('SEQ-AGAIN') && !answered('again')) return [call('again', 'send_to_session', { sessionId: 'worker', message: 'second note' })]
  if (lastUser.includes('SEQ-START') && !answered('p1')) return [
    text('Splitting the work between two sessions.', 'commentary'),
    call('p1', 'send_to_session', { sessionId: 'worker', message: 'please check the build and run the tests' }),
    call('p2', 'create_child_session', { suffix: 'helper', message: 'help with the docs for the release' }),
  ]
  if (lastUser.includes('SEQ-START')) return [text('Waiting for both reports.', 'final_answer')]
  if (lastUser.includes('please check the build')) {
    if (!answered('w1')) return [call('w1', 'exec', { command: 'echo build' }), call('w2', 'exec', { command: 'echo test' })]
    if (!answered('w3')) return [call('w3', 'read', { filePath: 'NOTES.md' }), call('w4', 'read', { filePath: 'missing.md' })]
    if (!answered('w5')) return [text('Build and tests are green; reporting back.', 'commentary'), call('w5', 'send_to_session', { sessionId: 'lead', message: 'build passes, 42 tests ok' })]
    return [text('Reported the build result.', 'final_answer')]
  }
  if (lastUser.includes('help with the docs')) {
    if (!answered('h1')) return [call('h1', 'read', { filePath: 'NOTES.md' })]
    if (!answered('h2')) return [call('h2', 'send_to_session', { sessionId: '<parent>', message: 'docs updated for the release' })]
    return [text('Docs are done.', 'final_answer')]
  }
  return [text('DONE')]
}

const peer = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const output = respond(JSON.parse(raw).input)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'seq-' + Date.now(), output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port + '/r', models: ['wire'], contextLimit: 20000 } } })

function denseSequence(now) {
  const t = now - 40 * 60_000
  const ids = ['team/coordinator', 'team/worker-a', 'team/worker-b', 'team/reviewer']
  const sessions = ids.map((id, index) => ({ id, agent: 'team', parentSessionId: index ? ids[0] : undefined, firstAt: t + index * 60_000, startedAt: index ? t + 60_000 * index : undefined }))
  sessions[1].runtimeState = { state: 'running-tool', busy: true, queueLength: 0, tool: { name: 'exec', startedAt: now - 20_000, argsPreview: 'npm test -- --shard 2' } }
  sessions[0].runtimeState = { state: 'waiting', busy: false, queueLength: 0 }
  const llm = (sessionId, seq, at, preview, phase, calls = 0) => ({ sessionId, seq, kind: 'llm', start: at - 2_000, end: at, preview, phase, calls })
  const tool = (sessionId, seq, callSeq, call, name, at, preview, status = 'ok') => ({ sessionId, seq, kind: 'tool', name, start: at, end: at + 900, callSeq, call, status, preview, ...(status === 'error' ? { error: 'exit 1' } : {}) })
  const link = (key, kind, from, to, sentAt, consumedAt, preview, extra = {}) => ({ key, kind, from, to, sentAt, consumedAt, preview, pairing: 'exact', ...extra })
  const m = minutes => t + minutes * 60_000
  return {
    since: now - 3_600_000, generatedAt: now, sessions, peers: [], cursors: {},
    tasks: { task_1: { title: 'Fix flaky upload test', status: 'completed' } },
    events: [
      llm(ids[0], 11, m(0) + 5_000, 'I will split the release checks between two workers and ask for a review afterwards.', 'commentary', 2),
      tool(ids[1], 3, 2, 1, 'exec', m(1) + 12_000, 'npm run build'), tool(ids[1], 3, 2, 2, 'exec', m(1) + 14_000, 'npm test'),
      tool(ids[1], 5, 4, 1, 'read', m(1) + 30_000, 'test/upload.test.ts'), tool(ids[1], 5, 4, 2, 'exec', m(1) + 40_000, 'npm test -- upload', 'error'),
      llm(ids[1], 6, m(2) + 5_000, 'The upload test races on the temp directory; patching the fixture.', 'commentary', 1),
      tool(ids[1], 7, 6, 1, 'edit', m(2) + 9_000, 'test/upload.test.ts'),
      tool(ids[2], 3, 2, 1, 'read', m(2) + 20_000, 'docs/release.md'), tool(ids[2], 3, 2, 2, 'read', m(2) + 21_000, 'CHANGELOG.md'), tool(ids[2], 5, 4, 1, 'edit', m(2) + 40_000, 'CHANGELOG.md'),
      llm(ids[2], 6, m(3) + 3_000, 'Release notes updated with the new upload limits.', 'commentary', 1),
      llm(ids[3], 3, m(17) + 20_000, 'Two small issues: missing changelog link and an unused import.', 'final_answer'),
      tool(ids[1], 9, 8, 1, 'exec', m(16) + 2_000, 'npm test', 'ok'),
      llm(ids[0], 20, m(18) + 5_000, 'Both workers reported back; the review found two small issues. Release is ready once they are fixed.', 'final_answer'),
    ],
    links: [
      link('r|coord|1', 'user', { lane: 'user', at: m(0) }, { sessionId: ids[0], seq: 10, at: m(0) + 1_000 }, m(0), m(0) + 1_000, 'Prepare the 1.4 release'),
      link('d|team/coordinator|12.1|team/worker-a', 'task', { lane: 'session', sessionId: ids[0], seq: 12, call: 1, at: m(0) + 7_000 }, { sessionId: ids[1], seq: 2, at: m(1) + 10_000 }, m(0) + 7_000, m(1) + 10_000, 'Fix the flaky upload test and run the full suite.', { taskId: 'task_1', taskEvent: 'assigned', deliverySeq: '12.1' }),
      link('d|team/coordinator|12.2|team/worker-b', 'message', { lane: 'session', sessionId: ids[0], seq: 12, call: 2, at: m(0) + 7_100 }, { sessionId: ids[2], seq: 2, at: m(2) + 15_000 }, m(0) + 7_100, m(2) + 15_000, 'Update the release notes and changelog for 1.4.', { deliverySeq: '12.2' }),
      link('d|team/worker-a|8|team/coordinator', 'task', { lane: 'session', sessionId: ids[1], seq: 8, call: 1, at: m(16) + 30_000 }, { sessionId: ids[0], seq: 15, at: m(16) + 31_000 }, m(16) + 30_000, m(16) + 31_000, 'Upload test fixed (temp dir race); full suite green.', { taskId: 'task_1', taskEvent: 'completed', deliverySeq: '8' }),
      link('d|team/worker-b|7|team/coordinator', 'message', { lane: 'session', sessionId: ids[2], seq: 7, call: 1, at: m(3) + 10_000 }, { sessionId: ids[0], seq: 14, at: m(3) + 11_000 }, m(3) + 10_000, m(3) + 11_000, 'Release notes and changelog updated.', { deliverySeq: '7' }),
      link('c|team/reviewer', 'spawn', { lane: 'session', sessionId: ids[0], seq: 16, call: 1, at: m(17) }, { sessionId: ids[3], seq: 1, at: m(17) }, m(17), m(17), '', { mode: 'new-child' }),
      link('d|team/coordinator|16.1|team/reviewer', 'message', { lane: 'session', sessionId: ids[0], seq: 16, call: 1, at: m(17) + 500 }, { sessionId: ids[3], seq: 2, at: m(17) + 2_000 }, m(17) + 500, m(17) + 2_000, 'Review the release branch diff against main.', { deliverySeq: '16.1' }),
      link('d|team/reviewer|4|team/coordinator', 'message', { lane: 'session', sessionId: ids[3], seq: 4, call: 1, at: m(17) + 25_000 }, { sessionId: ids[0], seq: 18, at: m(18) }, m(17) + 25_000, m(18), 'Found 2 small issues: changelog link, unused import in upload.ts.', { deliverySeq: '4' }),
      link('d|team/coordinator|21.1|team/worker-b', 'message', { lane: 'session', sessionId: ids[0], seq: 21, call: 1, at: m(18) + 8_000 }, { sessionId: ids[2] }, m(18) + 8_000, undefined, 'Please fix the changelog link the reviewer found.', { deliverySeq: '21.1', state: 'queued' }),
      link('r|timer|1', 'timer', { lane: 'timer', at: m(16) }, { sessionId: ids[1], seq: 9, at: m(16) }, m(16), m(16), 'Re-run the test suite'),
    ],
  }
}

const history = async id => (await fixture.api('GET', '/api/sessions/' + encodeURIComponent(id) + '/history?tail=80')).body
const settled = async (id, marker) => {
  const value = await history(id)
  return value.session && !value.session.busy && !(value.session.queueLength > 0) && JSON.stringify(value.messages).includes(marker)
}
try {
  await fixture.start()
  for (const id of ['lead', 'worker']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  assert.equal((await fixture.api('POST', '/api/sessions/lead/message', { text: 'SEQ-START' })).status, 202)
  await until(async () => await settled('worker', 'Reported the build result') && await settled('lead', 'Thanks, merging'), 'Coordinator and workers finish', 40000)
  const children = (await fixture.api('GET', '/api/sessions')).body.sessions.map(session => session.id).filter(id => id.endsWith('helper'))
  assert.equal(children.length, 1)
  await until(() => settled(children[0], 'Docs are done'), 'Helper finishes')
  assert.match(JSON.stringify((await history('worker')).messages), /deliverySeq=\\"\d+\.1\\"/)

  const projected = (await fixture.api('POST', '/api/session-sequence', { since: Date.now() - 600_000 })).body
  const toWorker = projected.links.find(link => link.to.sessionId === 'worker' && link.kind === 'message')
  assert.equal(toWorker.pairing, 'exact')
  assert.ok(projected.events.some(event => event.kind === 'llm' && event.phase === 'commentary'))

  const page = globalThis.sequencePage = await fixture.openApp()
  await page.setViewport({ width: 1600, height: 1000 })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => { location.hash = 'architecture' })
  await page.waitForSelector('.foxwarm-architecture-surface-tab')
  await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Sequence').click())
  await page.waitForSelector('[data-sequence-grid]')
  const columns = await page.$$eval('[data-sequence-column]', items => items.map(item => item.getAttribute('data-sequence-column')))
  assert.deepEqual(columns.slice(0, 2), ['lead', children[0]], columns.join(','))
  assert.ok(columns.includes('worker') && !columns.some(id => id.startsWith('@')), columns.join(','))
  // Input from you sits in the receiving column as a bubble.
  assert.ok(await page.$('[data-sequence-cell="lead"] .foxwarm-user-message-bubble'))
  // Both halves of the exact delivery, tool groups and commentary/final text.
  assert.equal((await page.$$(`[data-sequence-link="${toWorker.key}"]`)).length, 2)
  assert.ok(await page.$('[data-sequence-cell="worker"] [data-tool-group-card]'))
  assert.ok(await page.$('[data-sequence-cell="worker"] [data-tool-tag-tone="error"]'))
  assert.ok(await page.$('[data-sequence-phase="commentary"]') && await page.$('[data-sequence-phase="final"]'))
  assert.ok((await page.$$('[data-timeline-time-separator]')).length >= 1)

  // Hovering the sent card highlights the received card in the peer column.
  await page.hover(`[data-sequence-cell="lead"] [data-sequence-link="${toWorker.key}"] p`)
  await page.waitForSelector(`[data-sequence-cell="worker"] [data-sequence-link="${toWorker.key}"] [data-highlighted]`)
  assert.match(await page.$eval(`[data-sequence-cell="worker"] [data-sequence-link="${toWorker.key}"]`, element => element.textContent), /Read (after|immediately)/)
  if (process.env.FOXWARM_SEQUENCE_SCREENSHOT) await page.screenshot({ path: process.env.FOXWARM_SEQUENCE_SCREENSHOT })

  // Live: a later delivery appears without reloading the view.
  const before = (await page.$$('[data-sequence-card]')).length
  assert.equal((await fixture.api('POST', '/api/sessions/lead/message', { text: 'SEQ-AGAIN' })).status, 202)
  await until(async () => (await page.$$('[data-sequence-card]')).length >= before + 2, 'Live delivery appears in both columns', 20000)

  // Clicking the received card opens the receiver at that message.
  await page.mouse.move(0, 0)
  await page.click(`[data-sequence-cell="worker"] [data-sequence-link="${toWorker.key}"] p`)
  await page.waitForSelector('.foxwarm-chat-root')
  await until(async () => page.evaluate(() => document.body.textContent.includes('please check the build')), 'Receiver conversation opens')
  // Denser synthetic window: several buckets, Tasks, a timer, a waiting delivery and running work.
  await page.setRequestInterception(true)
  page.on('request', request => request.url().endsWith('/api/session-sequence')
    ? request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(denseSequence(Date.now())) })
    : request.continue())
  await page.evaluate(() => { location.hash = 'architecture' })
  await page.waitForSelector('.foxwarm-architecture-surface-tab')
  await page.evaluate(() => [...document.querySelectorAll('.foxwarm-architecture-surface-tab')].find(button => button.textContent.trim() === 'Sequence').click())
  await page.waitForSelector('[data-sequence-column="team/coordinator"]')
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Sessions shown"] button')].find(button => button.textContent === 'All active').click())
  await until(async () => (await page.$$('[data-sequence-row]')).length >= 5, 'Dense rows render')
  assert.ok(await page.$('[data-sequence-running]'))
  assert.match((await page.$$eval('[data-sequence-cell="team/worker-b"]', cells => cells.map(cell => cell.textContent).join(' '))), /Not read yet/)
  if (process.env.FOXWARM_SEQUENCE_DENSE_SCREENSHOT) {
    await page.setViewport({ width: 1600, height: 1500 })
    await page.evaluate(() => { document.querySelector('[data-sequence-scroll]').scrollTop = 0 })
    await page.hover('[data-sequence-cell="team/coordinator"] [data-sequence-link="d|team/coordinator|12.1|team/worker-a"] p')
    await page.screenshot({ path: process.env.FOXWARM_SEQUENCE_DENSE_SCREENSHOT })
  }
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(failures, [])
  console.log('session sequence e2e passed')
} catch (error) {
  if (process.env.FOXWARM_SEQUENCE_FAILURE_SCREENSHOT) await globalThis.sequencePage?.screenshot({ path: process.env.FOXWARM_SEQUENCE_FAILURE_SCREENSHOT }).catch(() => {})
  throw error
} finally {
  await fixture.cleanup()
  peer.close()
}
