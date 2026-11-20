import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { startChatFixture } from './chatFixture.mjs'

let browser
let fixtureUrl
let fixture

before(async () => {
  fixture = await startChatFixture()
  ;({ browser, fixtureUrl } = fixture)
})

after(() => fixture?.close())

// Send window: a slow server turn start (claim -> canonical append) must not show the input twice,
// flash inactive states, attribute its own queued item to the footer, or restart/recompute timers.
async function openSendWindowChat(t, view, scenario) {
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.setViewport({ width: 1000, height: 760 })
  // Kept drafts are per-origin; each send-window case starts from an empty composer.
  await page.evaluateOnNewDocument(() => localStorage.removeItem('composer_draft_v1_fixture/main'))
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  const seq = await page.evaluate(({ view, scenario }) => {
    window.fixtureTimelineView = view
    window.renderFixtureChats()
    const now = Date.now()
    const timing = (start, end) => ({ startedAt: start, completedAt: end, durationMs: end - start })
    const history = scenario === 'waiting' ? [
      { role: 'user', parts: [{ text: 'Please wait for me' }], __meta: { seq: 1, timestamp: now - 400 } },
      { role: 'model', parts: [{ functionCall: { id: 'wait-1', name: 'wait', args: { waitForInput: true } } }], __meta: { seq: 2, timestamp: now - 330, llmRequestId: 'wait-request', llmRequestTiming: timing(now - 380, now - 330) } },
      { role: 'tool', parts: [{ functionResponse: { name: 'wait', tool_use_id: 'wait-1', response: { output: 'Waiting.' }, executionTiming: timing(now - 330, now - 300) } }], __meta: { seq: 3, timestamp: now - 300 } },
    ] : [
      { role: 'user', parts: [{ text: 'Earlier question' }], __meta: { seq: 1, timestamp: now - 9000 } },
      { role: 'model', parts: [{ text: 'Earlier answer' }], __meta: { seq: 2, timestamp: now - 8000, llmRequestId: 'earlier', llmRequestTiming: timing(now - 8900, now - 8000) } },
    ]
    const runtimeState = scenario === 'waiting' ? { state: 'waiting', waiting: { waitingFor: 'input', waitForInput: true } }
      : scenario === 'busy' ? { state: 'requesting-model', busy: true, since: now - 500, active: { phase: 'normal-turn' } } : { state: 'idle' }
    window.resolveFixtureHistory(0, history, 0, { busy: scenario === 'busy', busyStartedAt: scenario === 'busy' ? now - 500 : undefined, runtimeState })
    window.sendWindowState = (extra) => window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', historyVersion: 0, modelKey: 'fixture/model', messageCount: history.length, ...extra } })
    window.startSendWindowSampler = marker => {
      window.sendWindowFrames = []
      const tick = () => {
        const root = document.querySelector('.foxwarm-chat-root')
        const committed = root.querySelector('[data-chat-timeline="committed"]')
        const queued = root.querySelector('[data-queued-preview]')
        const count = element => element ? element.innerText.split(marker).length - 1 : 0
        const committedText = committed?.innerText || ''
        const status = root.querySelector('[data-processing-status-slot] [role="status"][aria-label]')
        const markerRows = [...root.querySelectorAll('[data-search-row]')].filter(row => !row.parentElement.closest('[data-search-row]') && row.innerText.includes(marker))
        window.sendWindowFrames.push({
          time: Date.now(),
          committed: count(committed),
          queued: count(queued),
          status: status?.getAttribute('aria-label') || '',
          continueButton: [...root.querySelectorAll('[data-processing-status-slot] button')].some(button => button.textContent === 'Continue'),
          footer: root.querySelector('[data-processing-queue-footer]')?.getAttribute('data-alignment') || null,
          footerText: root.querySelector('[data-processing-queue-footer]')?.innerText || null,
          rowKeys: markerRows.map(row => row.dataset.searchRow),
          marked: markerRows.some(row => row.dataset.sendWindowMark === '1'),
          after: committedText.includes(marker) ? committedText.split(marker).at(-1).trim() : null,
          before: committedText.includes('Please wait for me') ? committedText.split('Please wait for me').at(-1).split(marker)[0].trim() : null,
        })
        if (!window.stopSendWindowSampler) requestAnimationFrame(tick)
      }
      window.stopSendWindowSampler = false
      tick()
    }
    return history.length
  }, { view, scenario })
  await page.waitForFunction(text => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes(text), {}, scenario === 'waiting' ? 'Please wait for me' : 'Earlier answer')
  if (scenario === 'busy') await page.evaluate(() => window.sendWindowState({ busy: true, busyStartedAt: Date.now() - 500, queueLength: 0, runtimeState: { state: 'requesting-model', busy: true, since: Date.now() - 500, active: { phase: 'normal-turn' } } }))
  await new Promise(resolve => setTimeout(resolve, 100))
  return { page, seq }
}

async function runSendWindow(t, view, scenario) {
  const { page, seq } = await openSendWindowChat(t, view, scenario)
  const marker = `Send window ${scenario} ${view}`
  await page.evaluate(marker => window.startSendWindowSampler(marker), marker)
  await page.type('[role="textbox"][aria-label="Message"]', marker)
  const clicked = await page.evaluate(() => Date.now())
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  const clientMessageId = await page.evaluate(() => window.fixtureMessageBodies[0].clientMessageId)
  const key = `client-${clientMessageId}`
  if (scenario === 'busy') {
    // The input is visible in the queue lane before the server answers.
    await page.waitForFunction(marker => document.querySelector('[data-queued-preview]')?.innerText.includes(marker), {}, marker)
    await page.evaluate(key => { document.querySelector(`[data-queued-preview] [data-search-row="${key}"]`).dataset.sendWindowMark = '1' }, key)
  }
  const unknown = since => ({ state: 'requesting-model', busy: true, since, active: { phase: 'unknown' } })
  // Admission: the input is queued; a waiting Session is released to idle before the busy claim.
  await page.evaluate(({ scenario }) => {
    if (scenario === 'busy') window.sendWindowState({ busy: true, busyStartedAt: Date.now() - 600, queueLength: 1, runtimeState: { state: 'requesting-model', busy: true, since: Date.now() - 600, active: { phase: 'normal-turn' } } })
    else window.sendWindowState({ busy: false, queueLength: 1, runtimeState: { state: 'idle' } })
    window.resolveFixtureMessages()
  }, { scenario })
  await new Promise(resolve => setTimeout(resolve, 60))
  const claimed = await page.evaluate(() => Date.now())
  if (scenario !== 'busy') await page.evaluate(({ claimed, runtimeState }) => window.sendWindowState({ busy: true, busyStartedAt: claimed, queueLength: 1, runtimeState }), { claimed, runtimeState: unknown(claimed) })
  // The queue increase triggers a reconcile that observes the queued item before the append.
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(({ seq, marker, clientMessageId, claimed, runtimeState, busy }) => window.resolveFixtureHistory(1, [], 0, {
    busy: true, busyStartedAt: busy ? Date.now() - 700 : claimed, latestSeq: seq, messageCount: seq, runtimeState,
    queuedMessages: [{ role: 'user', parts: [{ text: marker }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-0-user', queueIndex: 0, queueType: 'user', clientMessageId } }],
  }), { seq, marker, clientMessageId, claimed, busy: scenario === 'busy', runtimeState: scenario === 'busy' ? { state: 'requesting-model', busy: true, since: Date.now() - 700, active: { phase: 'normal-turn' } } : unknown(claimed) })
  // A slow turn start keeps this state on screen.
  await new Promise(resolve => setTimeout(resolve, 450))
  if (scenario === 'busy') assert.equal(await page.evaluate(() => window.sendWindowFrames.at(-1).marked), true, 'the server preview takes over the same row')
  await page.evaluate(({ seq, marker, clientMessageId, claimed, busy }) => {
    const canonical = { role: 'user', parts: [{ text: marker }], __meta: { seq: seq + 1, timestamp: Date.now(), clientMessageId } }
    const since = busy ? Date.now() - 800 : claimed
    window.sendWindowState({ busy: true, busyStartedAt: since, queueLength: 0, messageCount: seq + 1, runtimeState: { state: 'requesting-model', busy: true, since, active: { phase: 'unknown' } } })
    window.emitFixtureEvent({ type: 'history-append', messages: [canonical], queuedMessages: [], queueLength: 0, messageCount: seq + 1, historyVersion: 0 })
  }, { seq, marker, clientMessageId, claimed, busy: scenario === 'busy' })
  const appended = await page.evaluate(() => Date.now())
  await new Promise(resolve => setTimeout(resolve, 30))
  await page.evaluate(({ seq }) => {
    const since = Date.now()
    window.sendWindowState({ busy: true, busyStartedAt: since - 100, queueLength: 0, messageCount: seq + 1, runtimeState: { state: 'requesting-model', busy: true, since, active: { phase: 'normal-turn' } } })
  }, { seq })
  await new Promise(resolve => setTimeout(resolve, 1300))
  const frames = (await page.evaluate(() => { window.stopSendWindowSampler = true; return window.sendWindowFrames })).filter(frame => frame.time >= clicked)
  const shown = frames.filter(frame => frame.committed + frame.queued > 0)
  assert.ok(shown.length > 20)
  return { frames, shown, key, appended, marker }
}

const dedupe = values => values.filter((value, index) => index === 0 || value !== values[index - 1])
const parseWorked = text => {
  const match = text?.match(/Worked (\d+(?:\.\d+)?)(ms|s)\b/)
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : undefined
}

for (const view of ['detailed', 'conversation']) {
  for (const scenario of ['idle', 'waiting']) {
    test(`${view}: a ${scenario} send keeps one pending row and one send status through a slow turn start`, async t => {
      const { frames, shown, key, appended } = await runSendWindow(t, view, scenario)
      const firstShown = frames.indexOf(shown[0])
      assert.ok(frames.slice(firstShown).every(frame => frame.committed + frame.queued > 0), 'the input never disappears')
      for (const frame of shown) {
        assert.equal(frame.committed, 1, `exactly one committed-lane row: ${JSON.stringify(frame)}`)
        assert.equal(frame.queued, 0, `no queue preview duplicate: ${JSON.stringify(frame)}`)
        assert.deepEqual(frame.rowKeys, [key], 'the pending row identity is handed to the canonical row')
        assert.equal(frame.footer, null, 'its own queued item never shows a queue footer')
        assert.equal(frame.continueButton, false)
      }
      const statuses = dedupe(shown.map(frame => frame.status))
      assert.deepEqual(statuses, ['Sending…', 'Requesting model…'], `status sequence: ${JSON.stringify(statuses)}`)
      if (view === 'conversation') {
        const pending = shown.filter(frame => frame.time < appended)
        assert.ok(pending.every(frame => parseWorked(frame.after) === undefined), 'no live clock before the canonical row')
        const live = shown.filter(frame => frame.time > appended + 50).map(frame => parseWorked(frame.after)).filter(value => value !== undefined)
        assert.ok(live.length > 0, 'the live clock starts with the canonical row')
        assert.ok(live.every((value, index) => index === 0 || value >= live[index - 1]), `the live clock never restarts: ${live}`)
        assert.ok(live[0] < 500, `the live clock starts at the canonical input: ${live[0]}`)
      }
      if (view === 'conversation' && scenario === 'waiting') {
        const summaries = dedupe(shown.map(frame => frame.before))
        assert.equal(summaries.length, 1, `the previous activity summary is not recomputed: ${JSON.stringify(summaries)}`)
        assert.match(summaries[0], /^Worked \d+ms · 1 call/)
      }
    })
  }

  test(`${view}: a busy send keeps one queued row from the browser through the server preview into history`, async t => {
    const { shown, key, appended } = await runSendWindow(t, view, 'busy')
    for (const frame of shown) {
      assert.equal(frame.committed + frame.queued, 1, `exactly one row: ${JSON.stringify(frame)}`)
      assert.deepEqual(frame.rowKeys, [key])
      assert.notEqual(frame.footer, 'left', 'the queue footer is never attached to the committed lane')
    }
    const queuedFrames = shown.filter(frame => frame.time < appended)
    assert.ok(queuedFrames.every(frame => frame.queued === 1), 'below the status until it is committed')
    assert.ok(queuedFrames.some(frame => frame.footer === 'right'), 'its real queue footer belongs under the queued row')
    assert.ok(shown.filter(frame => frame.time > appended + 50).every(frame => frame.committed === 1 && frame.footer === null))
  })
}

test('an older server preview without client identity keeps showing the queued item', async t => {
  const { page, seq } = await openSendWindowChat(t, 'detailed', 'idle')
  await page.type('[role="textbox"][aria-label="Message"]', 'Legacy preview input')
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.fixtureMessageBodies.length === 1)
  await page.evaluate(() => { window.sendWindowState({ busy: false, queueLength: 1, runtimeState: { state: 'idle' } }); window.resolveFixtureMessages() })
  await page.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
  await page.evaluate(seq => window.resolveFixtureHistory(1, [], 0, { busy: true, latestSeq: seq, messageCount: seq,
    queuedMessages: [{ role: 'user', parts: [{ text: 'Legacy preview input' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-0-user', queueIndex: 0, queueType: 'user' } }] }), seq)
  await page.waitForFunction(() => document.querySelector('[data-queued-preview]')?.innerText.includes('Legacy preview input'))
  assert.ok(await page.$('[data-processing-queue-footer]'))
})

for (const scenario of ['idle', 'busy']) {
  test(`a failed ${scenario} send removes its pending row and keeps the draft`, async t => {
    const { page } = await openSendWindowChat(t, 'detailed', scenario)
    const text = `Unconfirmed ${scenario} input`
    await page.type('[role="textbox"][aria-label="Message"]', text)
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(text => document.querySelector('.foxwarm-chat-root').innerText.split(text).length === 3, {}, text)
    await page.evaluate(() => window.rejectNextFixtureMessage())
    await page.waitForFunction(() => document.body.textContent.includes('Message not confirmed'))
    await page.waitForFunction(text => !document.querySelector('[data-chat-timeline="committed"]').innerText.includes(text) && !document.querySelector('[data-queued-preview]'), {}, text)
    assert.equal(await page.$eval('[role="textbox"][aria-label="Message"]', node => node.textContent), text)
    assert.equal(await page.$('[data-processing-status-slot] [aria-label="Sending…"]'), null)
  })
}
