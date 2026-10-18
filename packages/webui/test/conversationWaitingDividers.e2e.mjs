import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const morning = Date.UTC(2026, 9, 12, 7, 15, 23, 456)
const previous = morning - (11 * 60 + 16) * 60000
const interval = (start, end) => ({ startedAt: start, completedAt: end, durationMs: end - start })
const stamp = (seq, time, role, parts, extra = {}) => ({ role, parts, __meta: { seq, timestamp: time, ...extra } })
const evening = previousTime => [
  stamp(201, previousTime - 2000, 'user', [{ text: 'Earlier request' }]),
  stamp(202, previousTime, 'model', [{ text: 'The earlier check is complete.' }], { llmRequestId: 'evening', llmRequestTiming: interval(previousTime - 2000, previousTime) }),
]
const recordsFor = (type = 'task', gap = 1999, previousTime = previous) => [
  ...evening(previousTime),
  stamp(203, morning, 'user', [{ system: `<foxwarm-message type="${type}" event="assigned" sourceSessionId="fixture/worker">\nInspect the implementation.\n</foxwarm-message>` }]),
  stamp(204, morning + gap + 100000, 'model', [{ thinking: 'Checking the implementation.' }, { functionCall: { id: 'morning-exec', name: 'exec', args: { command: 'printf example' } } }], { llmRequestId: 'morning-first', llmRequestTiming: interval(morning + gap, morning + gap + 100000), usage: { cachedTokens: 10, inputTokens: 20, outputTokens: 30 } }),
  stamp(205, morning + gap + 200000, 'tool', [{ functionResponse: { name: 'exec', tool_use_id: 'morning-exec', response: { output: 'Inspected.' }, executionTiming: interval(morning + gap + 100000, morning + gap + 200000) } }]),
  stamp(206, morning + gap + 397001, 'model', [{ thinking: 'Preparing the result.' }, { text: 'The morning check is complete.', phase: 'final_answer' }], { llmRequestId: 'morning-final', llmRequestTiming: interval(morning + gap + 230000, morning + gap + 397001), usage: { cachedTokens: 5, inputTokens: 40, outputTokens: 50 } }),
]
let browser, page, server
before(async () => {
  const webui = new URL('..', import.meta.url).pathname
  const cssName = (await readdir(new URL('../dist/assets/', import.meta.url))).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(`../dist/assets/${cssName}`, import.meta.url), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from './src/components/ChatTimeline'
    import { buildTimelineRows } from './src/components/timelineRows'
    import { initializeThemeRuntime } from './src/theme'
    initializeThemeRuntime()
    window.fixture = { now: ${morning + 500000} }
    Date.now = () => window.fixture.now
    window.fixture.derive = (messages, showTimeDividers = true, timing = {}) => buildTimelineRows({ messages, historyMessages:messages, timelineView:'conversation', isMobile:false, showUsageBadge:true, showTimeDividers, nestedDepth:0, expandedGroupKeys:new Set(), timing:{ runtimeState:{state:'idle',busy:false,queueLength:0}, ...timing } },null).rows
    function Fixture() {
      const [messages,setMessages] = React.useState([])
      const [runtime,setRuntime] = React.useState({state:'idle',busy:false,queueLength:0})
      window.fixture.setMessages = setMessages
      window.fixture.setRuntime = setRuntime
      return <main className="foxwarm-chat-root"><ChatTimeline sessionId="fixture/main" messages={messages} historyMessages={messages} runtimeState={runtime} isMobile={false} timelineView="conversation" showUsageBadge /></main>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'conversation-wait-divider-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><html><head><style>${css}</style><style>body{padding:32px;margin:0;font-family:system-ui}main{max-width:1050px;margin:auto}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 820 })
  await page.emulateTimezone('UTC')
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.fixture?.setMessages)
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
const headers = () => page.$$eval('[data-timeline-activity] [data-activity-toggle="top"]', buttons => buttons.map(button => button.textContent))
const derive = (records, showTimeDividers = true, timing = {}) => page.evaluate((records, showTimeDividers, timing) => window.fixture.derive(records, showTimeDividers, timing), records, showTimeDividers, timing)
const activities = rows => rows.filter(row => row.activity)
const show = async (records, runtime = { state: 'idle', busy: false, queueLength: 0 }) => {
  await page.evaluate((records, runtime) => { window.fixture.setMessages(records); window.fixture.setRuntime(runtime) }, records, runtime)
}

// This uses the actual marker + timing derivation and the rendered Conversation, not a helper-injected marker.
test('The 07:15 divider excludes overnight idle, retains real waits and leaves work, counts and usage unchanged', async () => {
  for (const type of ['task', 'inter-agent']) {
    const records = recordsFor(type)
    const markedRows = await derive(records)
    const [marked] = activities(markedRows)
    const [unmarked] = activities(await derive(records, false))
    const morningRow = markedRows.find(row => row.timeMarker?.timestamp === morning)
    assert.ok(morningRow, 'the real divider retains seconds and milliseconds')
    const summary = type === 'task' ? 'Worked 6m7s · Waited 30s · 1 call · 1 received' : 'Worked 6m7s · Waited 30s · 1 call'
    assert.equal(marked.activity.summary, summary)
    if (type === 'task') {
      assert.equal(morningRow, marked)
      assert.equal(unmarked.activity.summary, 'Worked 6m7s · Waited 11h16m · 1 call · 1 received', 'disabling dividers preserves the original leading idle')
    } else {
      assert.equal(morningRow.communication.direction, 'received')
      assert.equal(morningRow.communication.message, 'Inspect the implementation.')
      assert.equal(marked.timeMarker, null, 'the process does not duplicate the standalone communication divider')
      assert.equal(unmarked.activity.summary, summary, 'the standalone communication bounds the process even without dividers')
    }
    const withoutWait = ({ summary, ...facts }) => ({ ...facts, summary: summary.replace(/ · Waited [^·]+/, '').trim() })
    assert.deepEqual(withoutWait(marked.activity), withoutWait(unmarked.activity), 'Worked, counts and logical request usage do not change')
    assert.equal(marked.activity.usage.callCount, 2)
    assert.deepEqual(marked.activity.usage.usage, { cachedTokens: 15, inputTokens: 60, outputTokens: 80 })
    await show(records)
    await page.waitForFunction(received => document.querySelectorAll('[data-session-communication="received"]').length === received, {}, type === 'inter-agent' ? 1 : 0)
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('The morning check is complete.'))
    assert.deepEqual(await page.$$eval('[data-timeline-time-separator] time', times => times.map(time => time.dateTime)), [previous - 2000, morning].map(value => new Date(value).toISOString()))
    assert.deepEqual(await headers(), [summary])
    assert.equal(await page.$eval('main', node => node.textContent.includes('11h16m')), false)
    if (type === 'task' && process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_E2E_SCREENSHOT_PATH, fullPage: true })
    await page.click('[aria-label="Expand activity"]')
    await page.waitForSelector('[data-activity-details]')
    assert.deepEqual(await headers(), [summary])
    await page.click('[data-activity-toggle="top"][aria-label="Collapse activity"]')
    await page.waitForFunction(() => !document.querySelector('[data-activity-details]'))
  }
  const [exactCutoff] = activities(await derive(recordsFor('task', 2000)))
  assert.equal(exactCutoff.activity.summary, 'Worked 6m7s · Waited 32s · 1 call · 1 received', 'clip each continuous gap before applying the two-second cutoff')
  const [noMarker] = activities(await derive(recordsFor('task', 1999, morning - 30000)))
  assert.equal(noMarker.timeMarker, null)
  assert.equal(noMarker.activity.summary, 'Worked 6m7s · Waited 1m1s · 1 call · 1 received', 'a naturally absent divider retains leading idle')
})

test('A divider clips waiting only, including when a measured request began before it', async () => {
  const records = recordsFor()
  records[3].__meta.llmRequestTiming = interval(morning - 5000, records[3].__meta.timestamp)
  const [row] = activities(await derive(records))
  assert.equal(row.timeMarker.timestamp, morning)
  assert.equal(row.activity.summary, 'Worked 6m14s · Waited 30s · 1 call · 1 received', 'busy work before the divider is still counted')
})

test('Runtime-only first response and committed completion share the same waiting floor', async () => {
  const records = evening(previous)
  const timing = { runtimeState: { state: 'requesting-model', busy: true, since: morning, queueLength: 0 }, now: morning + 10000 }
  const [live] = activities(await derive(records, true, timing))
  assert.equal(live.activity.runtimeOnly, true)
  assert.equal(live.timeMarker.timestamp, morning)
  assert.equal(live.activity.summary, 'Worked 10s')
  const [unmarked] = activities(await derive(records, false, timing))
  assert.equal(unmarked.activity.summary, 'Worked 10s · Waited 11h16m')
  const completed = stamp(203, morning + 10000, 'model', [{ thinking: 'Checked.' }, { text: 'The current check is complete.', phase: 'final_answer' }], { llmRequestId: 'morning', llmRequestTiming: interval(morning, morning + 10000) })
  const [committed] = activities(await derive([...records, completed]))
  assert.equal(committed.timeMarker.timestamp, morning)
  assert.equal(committed.activity.summary, live.activity.summary)
})

test('Missing evidence and CTX remain conservative; maintenance alone stays untimed', async () => {
  const records = recordsFor()
  delete records[3].__meta.llmRequestTiming
  const [marked] = activities(await derive(records))
  const [unmarked] = activities(await derive(records, false))
  assert.match(marked.activity.summary, /^Elapsed /)
  assert.equal(marked.activity.summary, unmarked.activity.summary, 'a divider must not hide missing execution evidence or shorten Elapsed')
  const complete = recordsFor()
  const block = stamp(207, morning - 1000, 'model', [{ text: '[CTX-BLOCK L1 B#7 raw#1-#2] Earlier summary' }], { contextBlock: { id: 7, level: 1, rawStartSeq: 1, rawEndSeq: 2, sourceKind: 'message', rawStartTimestamp: previous } })
  const afterContext = [...complete.slice(0, 2), block, ...complete.slice(2)]
  afterContext[1] = { ...afterContext[1], __meta: { ...afterContext[1].__meta, llmRequestId: 'morning-first' } }
  // The first request has only a suffix after CTX; its earlier timing cannot be borrowed through the summary.
  afterContext[4] = { ...afterContext[4], __meta: { ...afterContext[4].__meta, llmSegment: { outputStart: 1, outputEndExclusive: 3, complete: true } } }
  delete afterContext[4].__meta.llmRequestTiming
  assert.match(activities(await derive(afterContext))[0].activity.summary, /^Elapsed /)
  const maintenance = stamp(203, morning, 'user', [{ system: '<foxwarm-system kind="session-boundary" event="compact-completed" />' }])
  const [maintenanceRow] = activities(await derive([...evening(previous), maintenance], true, { runtimeState: { state: 'waiting', busy: false, since: morning, queueLength: 0 }, now: morning + 10000 }))
  assert.doesNotMatch(maintenanceRow.activity.summary, /Worked|Waited|Elapsed/)
})
