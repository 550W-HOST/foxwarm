import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

// Two visual smoke examples, not the complete Conversation boundary matrix.
const base = 1700000000000
const usage = { cachedTokens: 18000, inputTokens: 1200, outputTokens: 400 }
const timing = (start, end) => ({ startedAt: base + start, completedAt: base + end, durationMs: end - start })
const user = (text, seq, at) => ({ role: 'user', parts: [{ text }], __meta: { seq, timestamp: base + at } })
const model = (parts, seq, at, request, extra = {}) => ({ role: 'model', parts, __meta: { seq, timestamp: base + at, llmRequestId: request, ...extra } })
const call = (id, name, args) => ({ functionCall: { id, name, args } })
const result = (id, name, output, seq, start, end) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name, response: { output }, executionTiming: timing(start, end) } }], __meta: { seq, timestamp: base + end } })
const long = [
  user('Check the implementation with a child session, then give me the result.', 1, 0),
  model([{ text: 'I will ask a child to inspect the change.', phase: 'commentary' }], 2, 3000, 'request-a', { llmSegment: { outputStart: 0, outputEndExclusive: 1, complete: false } }),
  model([call('child', 'create_child_session', { suffix: 'inspection' })], 3, 5000, 'request-a', { llmSegment: { outputStart: 1, outputEndExclusive: 2, complete: true }, usage, llmRequestTiming: timing(1000, 5000) }),
  result('child', 'create_child_session', 'Child session created: `fixture/inspection`. Initial message sent.', 4, 5000, 5500),
  model([{ text: 'The child is working. I will wait for its report.', phase: 'commentary' }, call('wait', 'wait', { waitAnySessions: ['fixture/inspection'] })], 5, 8500, 'request-b', { usage, llmRequestTiming: timing(5500, 8500) }),
  result('wait', 'wait', 'Waiting for the child report.', 6, 8500, 8600),
  { role: 'user', parts: [{ system: '<foxwarm-message type="inter-agent" sourceSessionId="fixture/inspection">\nThe inspection found no issue in the supported path.\n</foxwarm-message>' }], __meta: { seq: 7, timestamp: base + 128600 } },
  model([{ text: 'I will check the relevant file before reporting.' }, call('read', 'read', { filePath: 'src/example.ts' })], 8, 132000, 'request-c', { usage, llmRequestTiming: timing(129000, 132000) }),
  result('read', 'read', 'TOOL_OUTPUT_VISIBLE_ONLY_AFTER_OPEN', 9, 132000, 132300),
  model([{ text: '## Result\n\nThe implementation is consistent with the inspected path.\n\n- Child inspection completed.\n- The final file check agreed.\n\n```ts\nconst result = "ready for your review"\n```', phase: 'final_answer' }], 10, 140000, 'request-d', { usage, llmRequestTiming: timing(133000, 140000) }),
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
    import { initializeThemeRuntime } from './src/theme'
    initializeThemeRuntime()
    Date.now = () => ${base + 208000}
    import { projectSessionSearchFields, findSessionSearchMatches } from './src/components/chatSessionSearch'
    const original = ${JSON.stringify(long)}
    function Fixture() {
      const [messages, setMessages] = React.useState(original)
      const [runtime, setRuntime] = React.useState({ state:'idle', busy:false, queueLength:0 })
      window.fixture = { setMessages, setRuntime, original, matches: text => findSessionSearchMatches(projectSessionSearchFields(messages, 'conversation'), text) }
      return <main className="foxwarm-chat-root"><div className="text-xs text-fw-text-muted mb-4">Mock preview · Conversation first phase</div><ChatTimeline sessionId="fixture/main" messages={messages} historyMessages={messages.filter(message => !message.__meta?.temporary)} runtimeState={runtime} isMobile={false} timelineView="conversation" showUsageBadge /></main>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'conversation-presentation-preview.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><html><head><style>${css}</style><style>body{padding:32px;margin:0;font-family:system-ui}main{max-width:1050px;margin:auto}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 820 })
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('[data-timeline-activity]')
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
const screenshot = async name => {
  if (process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/${name}.png`, fullPage: true })
}

test('a completed coordination sequence has one process, aggregate usage and lightweight steps', async () => {
  assert.equal(await page.$$eval('[data-timeline-activity]', elements => elements.length), 1)
  assert.equal(await page.$$eval('[data-usage-badge-anchor]', elements => elements.length), 0)
  assert.equal(await page.evaluate(() => window.fixture.matches('I will ask').length), 0)
  assert.equal(await page.evaluate(() => window.fixture.matches('implementation is consistent').length), 1)
  assert.equal(await page.$eval('.foxwarm-conversation-reply', element => getComputedStyle(element).borderTopWidth), '0px')
  await screenshot('completed-collapsed')
  await page.click('[aria-label="Expand activity"]')
  await page.waitForSelector('[data-conversation-step]')
  assert.equal(await page.$$eval('[data-conversation-step-details]', elements => elements.length), 0)
  assert.ok(!(await page.$eval('main', element => element.textContent)).includes('TOOL_OUTPUT_VISIBLE_ONLY_AFTER_OPEN'))
  await page.waitForFunction(() => !document.querySelector('[data-timeline-activity]').style.height)
  await screenshot('completed-steps')
  await page.$$eval('[data-conversation-step] > div > button', buttons => buttons.find(button => button.textContent.includes('read')).click())
  await page.waitForFunction(() => document.querySelector('[data-conversation-step-details]')?.textContent.includes('TOOL_OUTPUT_VISIBLE_ONLY_AFTER_OPEN'))
  await page.click('[data-conversation-usage] > button')
  const usage = await page.$eval('[data-conversation-usage-details]', element => element.textContent)
  assert.ok(usage.includes('Requests4'))
  assert.ok(!usage.includes('partial') && !usage.includes('pending'))
})

test('undecided streaming text begins in the process and completion keeps manual disclosure', async () => {
  const input = user('Inspect this change and report the result.', 20, 200000)
  const draft = { role: 'model', parts: [{ text: 'I am checking the implementation now.' }], __meta: { streaming: true, temporary: true, llmRequestId: 'live-request', synthetic: 'streamingAssistantDraft' } }
  await page.evaluate((input, draft) => { window.fixture.setMessages([input, draft]); window.fixture.setRuntime({ state:'requesting-model', busy:true, since:Date.now() - 2000, queueLength:0 }) }, input, draft)
  await page.waitForSelector('[data-conversation-preview]')
  assert.equal(await page.$$eval('.foxwarm-conversation-reply:not([data-conversation-preview] *)', elements => elements.length), 0)
  await screenshot('live-preview')
  await page.click('[aria-label="Expand activity"]')
  const committed = model([{ text: 'I am checking the implementation now.' }, call('live-read', 'read', { filePath: 'src/example.ts' })], 21, 202000, 'live-request', { usage, llmRequestTiming: timing(200000, 202000) })
  const final = model([{ text: 'The check is complete.', phase: 'final_answer' }], 23, 205000, 'final-request', { usage, llmRequestTiming: timing(203000, 205000) })
  await page.evaluate(messages => { window.fixture.setMessages(messages); window.fixture.setRuntime({ state:'idle', busy:false, queueLength:0 }) }, [input, committed, result('live-read', 'read', 'Inspected.', 22, 202000, 202100), final])
  await page.waitForFunction(() => document.querySelector('.foxwarm-conversation-reply')?.textContent.includes('The check is complete.'))
  assert.equal(await page.$$eval('[data-timeline-activity]', elements => elements.length), 1)
  assert.equal(await page.$eval('[data-timeline-activity]', element => element.dataset.activityExpanded), 'true')
  assert.equal(await page.$$eval('[data-conversation-preview]', elements => elements.length), 0)
})
