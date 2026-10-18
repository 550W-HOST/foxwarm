import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const webui = new URL('..', import.meta.url).pathname
let browser, page, server, url
const image = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
const call = id => ({ functionCall: { id, name: 'exec', args: { command: `echo TECHNICAL_${id}` } } })
const ctx = (id, level = 1) => ({ role: 'model', parts: [{ text: `[CTX-BLOCK L${level} B#${id} raw#1-#2] SUMMARY_${id}` }], __meta: { contextBlock: { id, level, rawStartSeq: 1, rawEndSeq: 2, sourceKind: level > 1 ? 'block' : 'message' } } })
const quoted = '<foxwarm-system kind="event">\nQUOTED_USER_BODY\n</foxwarm-system>'
const messages = [
  { role: 'user', parts: [{ system: '<foxwarm-system kind="event" type="fixture">\nINTERNAL_EVENT\n</foxwarm-system>' }], __meta: { seq: 1 } },
  { role: 'user', parts: [{ system: '<foxwarm-message type="channel">' }, { text: quoted + '\n<pasted-text><foxwarm-message type="timer">PASTED_USER_BODY</foxwarm-message></pasted-text>' }, image, { system: '</foxwarm-message>' }], __meta: { seq: 2 } },
  { role: 'model', parts: [{ thinking: 'SECRET_REASONING' }, { text: 'COMMENTARY_BODY' }, image, { text: 'MIDDLE_BODY' }, call('mixed'), { text: 'AFTER_CALL_BODY' }], __meta: { seq: 3, usage: { inputTokens: 10, outputTokens: 20 } } },
  { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'mixed', response: { output: 'INTERNAL_TOOL_RESULT' } } }, { ...image, toolUseId: 'mixed' }], __meta: { seq: 4 } },
  { role: 'user', parts: [{ system: '<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\nINTERNAL_HANDOFF\n</foxwarm-message>' }], __meta: { seq: 5 } },
  ctx(40, 2),
  { role: 'model', parts: [{ thinking: 'AFTER_CTX_REASONING' }], __meta: { seq: 7 } },
  { role: 'model', parts: [{ text: 'FINAL_BODY' }], __meta: { seq: 8 } },
  { role: 'model', parts: [call('tail')], __meta: { seq: 9 } },
]

before(async () => {
  const cssName = (await readdir(new URL('../dist/assets/', import.meta.url))).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(`../dist/assets/${cssName}`, import.meta.url), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from './src/components/ChatTimeline'
    import ProcessingStatus, {QueuedMessageStatus} from './src/components/ProcessingStatus'
    import SessionUiSettingsMenu from './src/components/SessionUiSettingsMenu'
    import { useChatPreferences } from './src/chatPreferences'
    import { projectSessionSearchFields, findSessionSearchMatches } from './src/components/chatSessionSearch'
    const original = ${JSON.stringify(messages)}
    const queued = [
      { role:'user', parts:[{text:'QUEUED_USER'}], __meta:{queuedPreview:true,queueType:'user',temporary:true,synthetic:'queue-user'} },
      { role:'user', parts:[{system:'<foxwarm-message type="timer">\\nQUEUED_INTERNAL\\n</foxwarm-message>'}], __meta:{queuedPreview:true,queueType:'background',temporary:true,synthetic:'queue-timer'} },
    ]
    window.fixture = { fetches:[], controls:[], now:Date.now() }
    Date.now = () => window.fixture.now
    window.fixture.setNow = value => { window.fixture.now = value }
    window.fetch = async input => {
      window.fixture.fetches.push(String(input))
      const parent = String(input).includes('/40/expand')
      return new Response(JSON.stringify({sessionId:'fixture/main',blockId:parent?40:41,expansionKind:parent?'child-blocks':'messages',messages:parent?[${JSON.stringify(ctx(41))}]:[
        {role:'user',parts:[{text:'ARCHIVE_USER'}],__meta:{seq:1}},
        {role:'model',parts:[${JSON.stringify(call('archive'))}],__meta:{seq:2}},
        {role:'tool',parts:[{functionResponse:{name:'exec',tool_use_id:'archive',response:{output:'ARCHIVE_TOOL'}}}],__meta:{seq:3}},
        {role:'model',parts:[{text:'ARCHIVE_BODY'}],__meta:{seq:4}},
        {role:'model',parts:[{text:'⚠️ LLM Error: ARCHIVE_RETRY'}],__meta:{seq:5,noticeType:'llm-retry'}},
      ]}),{status:200,headers:{'Content-Type':'application/json'}})
    }
    function Fixture() {
      const prefs = useChatPreferences()
      const [messages,setMessages] = React.useState(original)
      const [slice,setSlice] = React.useState([0,undefined])
      const [currentHistory,setCurrentHistory] = React.useState(undefined)
      const [draft,setDraft] = React.useState(null)
      const [runtime,setRuntime] = React.useState({state:'running-tool',tool:{name:'exec',startedAt:1700000000000},since:1700000000000,busy:true,queueLength:2})
      window.fixture.prefs=prefs
      window.fixture.setMessages=setMessages
      window.fixture.setSlice=setSlice
      window.fixture.setCurrentHistory=setCurrentHistory
      window.fixture.setDraft=setDraft
      window.fixture.setRuntime=setRuntime
      window.fixture.runtime=runtime
      window.fixture.original=original
      window.fixture.matches = term => findSessionSearchMatches(projectSessionSearchFields(messages,prefs.timelineView,currentHistory ?? messages),term)
      return <div className="foxwarm-chat-root">
        <SessionUiSettingsMenu {...prefs} onSendKeyModeChange={prefs.setSendKeyMode} onTimelineViewChange={prefs.setTimelineView} onShowUsageBadgeChange={prefs.setShowUsageBadge} onShowUserMessageMetadataChange={prefs.setShowUserMessageMetadata} onOpenDebugInfo={()=>{}} />
        <div id="timeline"><ChatTimeline sessionId="fixture/main" messages={[...messages.slice(...slice),...(draft?[draft]:[])]} historyMessages={messages} currentHistoryMessages={currentHistory} runtimeState={runtime} isRunningTool={runtime.state==='running-tool'} isMobile={false} timelineView={prefs.timelineView} showUsageBadge={prefs.showUsageBadge} showUserMessageMetadata={prefs.showUserMessageMetadata} /></div>
        <div id="status"><ProcessingStatus timelineView={prefs.timelineView} runtimeState={runtime} sessionBusy={runtime.busy} sessionQueueLength={2} turnIncomplete={runtime.state==='idle'} loading={false} isMobile={false} onContinue={()=>window.fixture.controls.push('continue')} onRunQueued={()=>window.fixture.controls.push('queued')} /></div>
        <div id="queue"><ChatTimeline sessionId="fixture/main" messages={queued} isMobile={false} timelineView={prefs.timelineView} showUsageBadge={false} showTimeDividers={false} renderMessageFooter={alignment=><QueuedMessageStatus count={2} alignment={alignment} isMobile={false} onRunQueued={()=>window.fixture.controls.push('queued')} />} /></div>
      </div>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'conversation-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><style>${css}</style><style>body{margin:0;padding:16px}#root{max-width:900px}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.fixture?.prefs)
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
const mode = async value => {
  await page.evaluate(value => window.fixture.prefs.setTimelineView(value), value)
  await page.waitForFunction(value => window.fixture.prefs.timelineView === value, {}, value)
}
const countMatches = term => page.evaluate(term => window.fixture.matches(term).length, term)

test('browser preferences read old values, prioritize the new mode, and write only the new key', async () => {
  for (const [old, expected] of [['false', 'detailed'], ['true', 'grouped']]) {
    await page.evaluate(old => { localStorage.clear(); localStorage.setItem('foxwarm_group_tools_v1', old) }, old)
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(expected => window.fixture?.prefs.timelineView === expected, {}, expected)
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_timeline_view_v1')), null)
  }
  await page.evaluate(() => localStorage.setItem('foxwarm_group_tools_v1', 'false'))
  await page.click('[aria-label="Open session options"]')
  await page.waitForSelector('[data-session-ui-settings-menu] [role="radio"]')
  await page.$eval('[data-session-ui-settings-menu]', menu => [...menu.querySelectorAll('[role="radio"]')].find(button => button.textContent.trim() === 'Conversation').click())
  await page.waitForFunction(() => window.fixture.prefs.timelineView === 'conversation')
  assert.deepEqual(await page.evaluate(() => ({ old: localStorage.getItem('foxwarm_group_tools_v1'), mode: localStorage.getItem('foxwarm_timeline_view_v1') })), { old: 'false', mode: 'conversation' })
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.fixture?.prefs.timelineView === 'conversation')
})

test('Conversation retains ordered commentary, final text, images and literal user quotes; activity never duplicates them', async () => {
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-timeline-activity]').length), 6)
  assert.equal(await page.$eval('#timeline [data-timeline-activity] [aria-label$="activity"] span:last-child', span => span.textContent), 'Activity', 'records without supported counts retain the neutral fallback')
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-activity-details]').length), 0)
  assert.deepEqual(await page.$eval('#timeline', root => [...root.querySelectorAll('.foxwarm-assistant-message-card, img')].map(el => el.tagName === 'IMG' ? 'image' : el.textContent.trim())), ['image', 'COMMENTARY_BODY', 'image', 'MIDDLE_BODY', 'AFTER_CALL_BODY', 'FINAL_BODY'])
  const body = await page.$eval('#timeline', root => root.textContent)
  for (const text of ['QUOTED_USER_BODY', 'PASTED_USER_BODY', 'SUMMARY_40', '</foxwarm-system>']) assert.ok(body.includes(text), text)
  for (const text of ['TECHNICAL_', 'SECRET_REASONING', 'INTERNAL_EVENT', 'INTERNAL_TOOL_RESULT']) assert.ok(!body.includes(text), text)
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[aria-label="Show process usage"]').length), 1)
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_E2E_SCREENSHOT_PATH, fullPage: true })
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Expand activity"]')].forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-activity-details]').length === 6)
  for (const text of ['COMMENTARY_BODY', 'MIDDLE_BODY', 'AFTER_CALL_BODY', 'FINAL_BODY']) {
    assert.equal(await page.$eval('#timeline', (root, text) => [...root.querySelectorAll('.foxwarm-assistant-message-card')].filter(card => card.textContent.includes(text)).length, text), 1)
  }
  assert.ok(!(await page.$eval('#timeline', root => root.textContent)).includes('INTERNAL_TOOL_RESULT'), 'opening a process leaves native tool bodies collapsed')
  await page.$$eval('#timeline [data-activity-details] [aria-label="Expand exec tool"]', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('INTERNAL_TOOL_RESULT'))
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('img:not([data-activity-details] img)').length), 2)
  assert.equal(await countMatches('TECHNICAL_mixed'), 0)
  assert.equal(await countMatches('INTERNAL_HANDOFF'), 1)
  assert.equal(await countMatches('SECRET_REASONING'), 0)
  assert.equal(await countMatches('COMMENTARY_BODY'), 1)
  assert.equal(await countMatches('foxwarm-system kind="event"'), 1, 'the direct user quote is searchable, not the internal event')
  assert.equal(await countMatches('SUMMARY_40'), 1)
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Collapse activity"]')].forEach(button => button.click()))
})

test('CTX stays visible and one-layer lazy in every mode, including already expanded nested cards', async () => {
  assert.equal(await page.evaluate(() => window.fixture.fetches.length), 0)
  for (const value of ['detailed', 'grouped', 'conversation']) {
    await mode(value)
    assert.ok(await page.$('[aria-label="Expand CTX-BLOCK B#40"]'))
  }
  assert.equal(await page.evaluate(() => window.fixture.fetches.length), 0)
  await page.click('[aria-label="Expand CTX-BLOCK B#40"]')
  await page.waitForSelector('[aria-label="Expand CTX-BLOCK B#41"]')
  assert.equal(await page.evaluate(() => window.fixture.fetches.length), 1)
  await page.waitForFunction(() => !document.querySelector('.foxwarm-context-block-card')?.style.height)
  await page.click('[aria-label="Expand CTX-BLOCK B#41"]')
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('ARCHIVE_BODY'))
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-activity-details]').length), 0)
  for (const value of ['grouped', 'detailed', 'conversation']) {
    await mode(value)
    assert.ok((await page.$eval('#timeline', root => root.textContent)).includes('ARCHIVE_BODY'))
    assert.equal(await page.evaluate(() => window.fixture.fetches.length), 2)
  }
  assert.equal(await countMatches('ARCHIVE_BODY'), 0, 'expanded children are not the top-level search corpus')
  await page.click('[aria-label="Collapse CTX-BLOCK B#40"]')
  await page.click('[aria-label="Expand CTX-BLOCK B#40"]')
  assert.equal(await page.evaluate(() => window.fixture.fetches.length), 2)
})

test('live status names the actual tool; pending internal inputs do not become activity or completed work, and controls survive', async () => {
  assert.ok((await page.$eval('#status', root => root.textContent)).includes('Executing exec'))
  assert.equal(await page.$eval('#root', root => (root.textContent.match(/Executing exec/g) || []).length), 1)
  assert.equal(await page.$eval('#queue', root => root.querySelectorAll('[data-timeline-activity]').length), 0)
  assert.equal((await page.$eval('#queue .foxwarm-user-message-text', root => root.textContent)).trim(), 'QUEUED_USER')
  assert.equal(await page.$('#status button::-p-text(Stop)'), null)
  await page.evaluate(() => window.fixture.setRuntime({ state: 'waiting', busy: false, queueLength: 2, waiting: { waitingFor: 'input', reason: 'Please choose a target' } }))
  await page.waitForSelector('#status [data-processing-runtime-state="waiting"]')
  assert.equal(await page.$eval('#status [data-processing-runtime-state="waiting"] [title]', label => label.textContent), 'Waiting for input')
  assert.equal(await page.$eval('#status', root => [...root.querySelectorAll('button')].some(button => button.textContent === 'Stop')), false)
  await page.evaluate(() => window.fixture.setRuntime({ state: 'waiting', busy: false, queueLength: 2, waiting: { waitingFor: 'input' } }))
  await page.waitForFunction(() => !window.fixture.runtime.waiting.reason)
  assert.equal(await page.$eval('#status [data-processing-runtime-state="waiting"] [title]', label => label.textContent), 'Waiting for input')
  await page.evaluate(() => window.fixture.setRuntime({ state: 'idle', busy: false, queueLength: 2 }))
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Interrupted'))
  await page.$eval('#status', root => [...root.querySelectorAll('button')].forEach(button => button.click()))
  await page.click('#queue button::-p-text(Run queued)')
  assert.deepEqual(await page.evaluate(() => window.fixture.controls), ['continue', 'queued'])
})

test('stream text stays visible and retains its DOM on canonical commit while the untouched tool tail stays collapsed', async () => {
  await page.evaluate(() => window.fixture.setMessages([...window.fixture.original, { role: 'model', parts: [{ thinking: 'STREAM_REASONING' }, { text: 'STREAM_BODY' }], __meta: { temporary: true, synthetic: 'draft', llmRequestId: 'stream-one' } }]))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('STREAM_BODY'))
  await page.evaluate(() => { window.streamNode = [...document.querySelectorAll('#timeline .foxwarm-assistant-message-markdown')].find(el => el.textContent.includes('STREAM_BODY')); window.fixture.setMessages([...window.fixture.original, { role: 'model', parts: [{ thinking: 'STREAM_REASONING' }, { text: 'STREAM_BODY' }], __meta: { seq: 10, llmRequestId: 'stream-one' } }]) })
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-10"]')
  assert.equal(await page.evaluate(() => window.streamNode.isConnected && window.streamNode === [...document.querySelectorAll('#timeline .foxwarm-assistant-message-markdown')].find(el => el.textContent.includes('STREAM_BODY'))), true)
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-activity-details]').length), 0)
  const anchors = await page.$eval('#timeline', root => [...root.querySelectorAll('[data-chat-message-anchor-key]')].map(el => el.dataset.chatMessageAnchorKey))
  assert.equal(new Set(anchors).size, anchors.length)
})

test('Activity detail rows are compact without changing CTX nested row spacing', async () => {
  await page.evaluate(() => { window.fixture.setMessages(window.fixture.original); window.fixture.setSlice([0,undefined]); window.fixture.setDraft(null) })
  await page.waitForSelector('#timeline [aria-label="Expand activity"]')
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Expand activity"]')].forEach(button => button.click()))
  await page.waitForSelector('#timeline [data-activity-details] [data-search-row]')
  const margins = await page.$$eval('#timeline [data-activity-details] [data-search-row]', rows => rows.map(row => getComputedStyle(row).marginTop))
  assert.ok(margins.length >= 5)
  assert.ok(margins.every(margin => margin === '0px'), margins.join(', '))
  if (await page.$('[aria-label="Expand CTX-BLOCK B#41"]')) {
    await page.waitForFunction(() => !document.querySelector('.foxwarm-context-block-card')?.style.height)
    await page.click('[aria-label="Expand CTX-BLOCK B#41"]')
  }
  await page.waitForFunction(() => document.querySelector('#timeline .foxwarm-context-block-nested')?.textContent.includes('ARCHIVE_BODY'))
  assert.equal(await page.$eval('#timeline .foxwarm-context-block-nested', root => [...root.querySelectorAll('[data-search-row]')].find(row => row.textContent.includes('ARCHIVE_BODY'))?.classList.contains('mt-2')), true)
  assert.equal(await page.$eval('#timeline .foxwarm-context-block-nested', root => root.querySelector('[data-system-message-kind="llm error"]') === null), true, 'nested archive tail is not the current history tail')
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Collapse activity"]')].forEach(button => button.click()))
})

test('only the full committed history tail LLM error is external; drafts, clipped slices and later CTX/input do not redefine it', async () => {
  await mode('conversation')
  await page.evaluate(() => {
    const earlier = { role: 'model', modelVisible: false, parts: [{ text: 'EARLIER_RETRY' }], __meta: { seq: 200, noticeType: 'llm-retry', retry: { final: true } } }
    const ordinary = Array.from({ length: 110 }, (_, index) => ({ role: 'model', parts: [{ text: 'BODY_' + index }], __meta: { seq: 201 + index } }))
    const tail = { role: 'model', modelVisible: false, parts: [{ text: 'TAIL_RETRY attempt one\nTAIL_RETRY attempt two' }], __meta: { seq: 400, noticeType: 'llm-retry', retry: { final: true } } }
    window.fixture.tailScenario = [earlier, ...ordinary, tail]
    window.fixture.setCurrentHistory(undefined)
    window.fixture.setRuntime({ state: 'idle', busy: false, queueLength: 0 })
    window.fixture.setMessages(window.fixture.tailScenario)
    window.fixture.setSlice([12, undefined])
    window.fixture.setDraft(null)
  })
  await page.waitForSelector('#timeline [data-system-event]')
  assert.deepEqual(await page.$$eval('#timeline [data-system-event]', cards => cards.map(card => ({ severity: card.dataset.eventSeverity, inside: !!card.closest('[data-activity-details]') }))), [{ severity: 'error', inside: false }])
  assert.equal(await countMatches('EARLIER_RETRY'), 0)
  assert.equal(await countMatches('TAIL_RETRY attempt two'), 1)
  await page.click('#timeline [data-event-details] summary')
  assert.equal(await page.$eval('#timeline [data-event-details] pre', node => node.textContent), 'TAIL_RETRY attempt one\nTAIL_RETRY attempt two')
  await page.evaluate(() => window.fixture.setDraft({ role: 'model', parts: [{ text: 'UNCOMMITTED_STREAM' }], __meta: { temporary: true, synthetic: 'tail-draft' } }))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('UNCOMMITTED_STREAM'))
  assert.equal(await page.$$eval('#timeline [data-system-event]', cards => cards.length), 1)
  await page.evaluate(() => {
    window.fixture.setDraft(null)
    window.fixture.setMessages([...window.fixture.tailScenario, { role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#42 raw#1-#2] CTX_BOUNDARY' }], __meta: { contextBlock: { id: 42, level: 1, rawStartSeq: 1, rawEndSeq: 2 } } }])
  })
  await page.waitForSelector('[aria-label="Expand CTX-BLOCK B#42"]')
  assert.equal(await page.$('#timeline [data-system-event]'), null)
  assert.equal(await countMatches('TAIL_RETRY'), 0)
  await page.evaluate(() => window.fixture.setSlice([0, 1]))
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.equal(await page.$('#timeline [data-system-event]'), null, 'a clipped old retry is not the active history tail')
  await page.evaluate(() => { window.fixture.setSlice([0, undefined]); window.fixture.setMessages([...window.fixture.tailScenario, { role: 'user', parts: [{ text: 'REAL_USER_APPEND' }], __meta: { seq: 401 } }]) })
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('REAL_USER_APPEND'))
  assert.equal(await page.$('#timeline [data-system-event]'), null)
  assert.equal(await countMatches('TAIL_RETRY'), 0)
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Expand activity"]')].at(-1).click())
  await page.waitForSelector('#timeline [data-activity-details] [data-system-event]')
  await page.click('#timeline [data-activity-details] [data-event-details] summary')
  assert.equal(await page.$eval('#timeline [data-activity-details] [data-event-details] pre', node => node.textContent), 'TAIL_RETRY attempt one\nTAIL_RETRY attempt two')
  assert.equal(await countMatches('TAIL_RETRY'), 0)
  assert.equal(await page.$('#queue [data-system-event]'), null)
})

test('nonfinal tail retries are external until a later record folds them into Activity with full Details', async () => {
  await mode('conversation')
  await page.evaluate(() => {
    const base = 1700000000000
    window.fixture.retryScenario = [
      { role: 'user', parts: [{ text: 'Retry this request' }], __meta: { seq: 500, timestamp: base } },
      { role: 'model', parts: [{ thinking: 'Work before retry' }], __meta: { seq: 501, timestamp: base + 1000 } },
      { role: 'model', modelVisible: false, parts: [{ text: 'RETRY_LOG attempt one\nRETRY_LOG attempt two' }], __meta: { seq: 502, timestamp: base + 2000, noticeType: 'llm-retry', retry: { final: false } } },
    ]
    window.fixture.setCurrentHistory(undefined)
    window.fixture.setMessages(window.fixture.retryScenario)
    window.fixture.setSlice([0, undefined])
    window.fixture.setDraft(null)
    window.fixture.setRuntime({ state: 'idle', busy: false, queueLength: 0 })
  })
  await page.waitForSelector('#timeline [data-system-event]')
  assert.equal(await page.$eval('#timeline [data-system-event]', node => !!node.closest('[data-activity-details]')), false)
  assert.equal(await countMatches('RETRY_LOG'), 2)
  for (const selectedMode of ['detailed', 'grouped']) {
    await mode(selectedMode)
    await page.waitForSelector('#timeline [data-system-event]')
    assert.equal(await page.$eval('#timeline [data-system-event]', node => !!node.closest('[data-timeline-activity]')), false)
    assert.equal(await countMatches('RETRY_LOG'), 2)
    await page.click('#timeline [data-event-details] summary')
    assert.equal(await page.$eval('#timeline [data-event-details] pre', node => node.textContent), 'RETRY_LOG attempt one\nRETRY_LOG attempt two')
  }
  await mode('conversation')
  await page.waitForSelector('#timeline [data-system-event]')
  await page.evaluate(() => window.fixture.setMessages([...window.fixture.retryScenario,
    { role: 'model', parts: [{ functionCall: { id: 'retry-tool', name: 'exec', args: { command: 'true' } } }], __meta: { seq: 503, timestamp: 1700000003000 } },
  ]))
  await page.waitForFunction(() => !document.querySelector('#timeline [data-system-event]'))
  assert.equal(await page.$$eval('#timeline [data-timeline-activity]', nodes => nodes.length), 1)
  assert.equal(await countMatches('RETRY_LOG'), 0)
  await page.click('#timeline [aria-label="Expand activity"]')
  await page.waitForSelector('#timeline [data-activity-details] [data-system-event]')
  assert.equal(await page.$eval('#timeline [data-system-event]', node => node.dataset.eventSeverity), 'warning')
  await page.click('#timeline [data-event-details] summary')
  assert.equal(await page.$eval('#timeline [data-event-details] pre', node => node.textContent), 'RETRY_LOG attempt one\nRETRY_LOG attempt two')
  assert.equal(await countMatches('RETRY_LOG'), 0, 'manually opened Activity remains outside Conversation Search')
  await page.$eval('#timeline [data-activity-toggle="bottom"]', button => button.click())
  await page.evaluate(() => {
    const base = 1700000000000
    window.fixture.setMessages([...window.fixture.retryScenario,
      { role: 'model', parts: [{ functionCall: { id: 'retry-tool', name: 'exec', args: { command: 'true' } } }], __meta: { seq: 503, timestamp: base + 3000 } },
      { role: 'model', parts: [{ text: 'RETRY_FINISHED_BODY' }], __meta: { seq: 504, timestamp: base + 5000 } },
    ])
  })
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('RETRY_FINISHED_BODY'))
  assert.equal(await page.$$eval('#timeline [data-timeline-activity]', nodes => nodes.length), 1, 'retry does not split the process or leave an empty row')
  await page.evaluate(() => window.fixture.setSlice([3, undefined]))
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('Retry this request'))
  assert.match(await page.$eval('#timeline [data-timeline-activity]', node => node.textContent), /Elapsed 5s/, 'a hidden retry must not replace the preceding user clock boundary')
})

test('Activity counts use direct recorded outcomes, not script code or asynchronous sends', async () => {
  await mode('conversation')
  const previousTiming = await page.evaluate(() => ({ runtime: window.fixture.runtime, now: window.fixture.now }))
  const model = (seq, parts, segmented = false) => ({role:'model',parts,__meta:{seq,...segmented?{llmRequestId:'stats-request',llmSegment:{outputStart:seq===13?8:0,outputEndExclusive:seq===13?9:8,complete:true}}:{}}})
  const tool = (id,name,output,error = false) => ({role:'tool',parts:[{functionResponse:{tool_use_id:id,name,response:error?{error:output}:{output}}}]})
  const records = [
    model(1,[{thinking:'STATS_REASONING'},{functionCall:{id:'child-async',name:'create_child_session',args:{suffix:'async',message:'initial',afterSend:'continue'}}},{functionCall:{id:'child-task',name:'call_tool',args:{toolId:'builtin:create_child_session',args:{taskId:'fixture-task',suffix:'task'}}}},{text:'VISIBLE_BARRIER'}, {functionCall:{id:'send-good',name:'send_to_session',args:{sessionId:'fixture/target',message:'hello'}}},{functionCall:{id:'send-failed',name:'send_to_channel',args:{channelTargetId:'fixture:target',message:'hello'}}},{functionCall:{id:'script',name:'run_script',args:{code:'create_child_session(); send_to_session()'}}},{functionCall:{id:'background',name:'exec',args:{command:'long-job'}}}],true),
    tool('child-async','create_child_session','Child session created: `fixture/async` (new session). Initial message sent.'),
    tool('child-task','call_tool','Child session created: `fixture/task` (new session), but task assignment delivery failed.'),
    tool('send-good','send_to_session','Message sent to session `fixture/target`'),
    tool('send-failed','send_to_channel','SEND_FAILED',true),
    {role:'tool',parts:[{functionResponse:{tool_use_id:'script',name:'run_script',response:{runId:'fixture-script',status:'completed',result:'script output mentioning create_child_session and send_to_session'}}}]},
    tool('background','exec','Background command started'),
    {role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\nRECEIVED_ONE\n</foxwarm-message>'}],__meta:{seq:8}},
    {role:'user',parts:[{system:'<foxwarm-system kind="external-input" server="fixture" endpoint="notify">\nRECEIVED_TWO\n</foxwarm-system>'}],__meta:{seq:9}},
    {role:'user',parts:[{system:'<foxwarm-system kind="external-input" externalId="fixture-external" contextId="fixture-context" channelTargetId="fixture:reply" hint="Message from an external MCP client.">'},{text:'INBOUND_MCP_BODY'},{system:'</foxwarm-system>'}],__meta:{seq:10}},
    {role:'user',parts:[{system:'<foxwarm-system kind="time" time="one day later" />'}],__meta:{seq:11}},
    {role:'user',parts:[{system:'<foxwarm-system kind="goal-reminder">maintenance</foxwarm-system>'}],__meta:{seq:12}},
    ctx(60),
    model(13,[{functionCall:{id:'no-evidence',name:'run_script',args:{code:'create_child_session(); send_to_session()'}}}],true),
    model(14,[{text:'CONTINUE_BARRIER'},{functionCall:{id:'script-continue',name:'continue_script',args:{runId:'fixture-script',continuationId:'next'}}}]),
    {role:'tool',parts:[{functionResponse:{tool_use_id:'script-continue',name:'continue_script',response:{runId:'fixture-script',status:'completed'}}}]},
    {role:'user',parts:[{system:'<foxwarm-message type="channel" channelType="webui">\n<foxwarm-system kind="external-input" externalId="fixture-external" contextId="fixture-context">\nQUOTED_MCP_XML\n</foxwarm-system>\n</foxwarm-message>'}],__meta:{seq:16,clientMessageId:'fixture-human-quote'}},
  ]
  await page.evaluate(records => { window.fixture.setMessages(records); window.fixture.setSlice([0,undefined]) }, records)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('2 child sessions'))
  assert.deepEqual(await page.$$eval('#timeline [data-timeline-activity] [aria-label$="activity"]', buttons => buttons.filter(button=>button.dataset.activityToggle!=='bottom').map(button => button.textContent)), [
    '2 calls',
    '4 calls · 2 child sessions · 1 sent',
    'Activity',
    '2 received',
    '1 call',
    '1 call',
  ])
  assert.ok(!(await page.$eval('#timeline', root => root.textContent)).includes('Activity · Error'))
  await page.$eval('#timeline', root => { root.style.width = '220px' })
  const wrapped = await page.$$eval('#timeline [data-timeline-activity] [aria-label$="activity"]', buttons => {
    const summary = buttons.find(button => button.textContent.includes('child sessions')).lastElementChild
    const range = document.createRange()
    range.selectNodeContents(summary)
    return { align: getComputedStyle(summary).textAlign, lefts: [...range.getClientRects()].map(rect => rect.left) }
  })
  assert.equal(wrapped.align, 'left')
  assert.ok(wrapped.lefts.length > 1, 'the real summary wraps in a narrow container')
  assert.ok(wrapped.lefts.every(left => Math.abs(left - wrapped.lefts[0]) < 1), 'wrapped lines keep the same left edge')
  await page.$$eval('#timeline [aria-label="Expand activity"]', buttons => buttons.forEach(button=>button.click()))
  await page.$$eval('[data-activity-details] [aria-label="Expand send_to_channel tool"]', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => [...document.querySelectorAll('[data-activity-details]')].some(element=>element.textContent.includes('SEND_FAILED')))
  assert.ok((await page.$eval('#timeline', root => root.textContent)).includes('SEND_FAILED'))
  assert.ok((await page.$eval('#timeline', root => root.textContent)).includes('QUOTED_MCP_XML'), 'ordinary authored XML remains visible rather than becoming received communication')
  await page.evaluate(start => window.fixture.setSlice([start,undefined]), records.length - 2)
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.equal(await page.$eval('#timeline [data-timeline-activity] [aria-label$="activity"]', button => button.textContent), 'Activity', 'the clipped response does not recount its ordinary invocation already represented before the window')
  const base = 1700000000000
  await page.evaluate(base => {
    window.fixture.setMessages([{ role: 'user', parts: [{ text: 'ALIGNMENT_INPUT' }], __meta: { seq: 1, timestamp: base, clientMessageId: 'alignment-input' } }])
    window.fixture.setSlice([0, undefined])
    window.fixture.setNow(base + 90000)
    window.fixture.setRuntime({ state: 'requesting-model', since: base + 70000, busy: true, queueLength: 0 })
  }, base)
  await page.waitForFunction(() => document.querySelector('#timeline [data-timeline-activity]')?.textContent.includes('Worked'))
  const live = await page.$eval('#timeline [data-timeline-activity] [data-conversation-statistics] > div', summary => {
    const range = document.createRange()
    range.selectNodeContents(summary)
    return { align: getComputedStyle(summary).textAlign, lefts: [...range.getClientRects()].map(rect => rect.left) }
  })
  assert.equal(live.align, 'left')
  assert.ok(live.lefts.length > 0)
  assert.ok(live.lefts.every(left => Math.abs(left - live.lefts[0]) < 1))
  assert.equal(await page.$eval('#timeline [data-timeline-time-separator]', row => getComputedStyle(row).textAlign), 'center')
  await page.$eval('#timeline', root => { root.style.width = '' })
  await page.evaluate(previous => { window.fixture.setRuntime(previous.runtime); window.fixture.setNow(previous.now) }, previousTiming)
})

test('ingress kinds and retry metadata fold, while human XML/code examples and ordinary warning text remain body', async () => {
  await page.evaluate(() => window.fixture.setSlice([0,undefined]))
  await page.evaluate(() => window.fixture.setMessages([
    ...['task', 'timer', 'mcp', 'trigger'].map((type, index) => ({ role: 'user', parts: [{ system: '<foxwarm-message type="' + type + '">\nINTERNAL_' + type + '\n</foxwarm-message>' }], __meta: { seq: index + 1 } })),
    { role: 'user', parts: [{ system: '<foxwarm-system kind="external-input" />' }, { text: 'EXTERNAL_BODY' }], __meta: { seq: 5 } },
    { role: 'user', parts: [{ text: '<foxwarm-system kind="event">\nLEGACY_EVENT\n</foxwarm-system>' }], __meta: { seq: 6 } },
    { role: 'model', parts: [{ text: '⚠️ LLM Error: RETRY_ERROR' }], __meta: { seq: 7, noticeType: 'llm-retry' } },
    { role: 'tool', parts: [{ functionResponse: { name: 'exec', response: { error: 'TOOL_ERROR' } } }], __meta: { seq: 8 } },
    { role: 'user', parts: [{ text: '<foxwarm-system kind="event">\nHUMAN_XML\n</foxwarm-system>\n```xml\n<foxwarm-message type="timer" />\n```' }], __meta: { seq: 9, clientMessageId: 'human-xml' } },
    { role: 'user', parts: [{ text: '<foxwarm-message type="channel">\nLEGACY_CHANNEL_BODY\n</foxwarm-message>' }], __meta: { seq: 10 } },
    { role: 'model', parts: [{ text: '⚠️ LLM Error: ORDINARY_WARNING' }], __meta: { seq: 11 } },
  ]))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('ORDINARY_WARNING'))
  const text = await page.$eval('#timeline', root => root.textContent)
  for (const hidden of ['INTERNAL_', 'EXTERNAL_BODY', 'LEGACY_EVENT', 'RETRY_ERROR', 'TOOL_ERROR']) assert.ok(!text.includes(hidden), hidden)
  for (const visible of ['HUMAN_XML', '<foxwarm-message type="timer" />', 'LEGACY_CHANNEL_BODY', 'ORDINARY_WARNING']) assert.ok(text.includes(visible), visible)
  assert.equal(text.includes('Activity · Error'), false)
  assert.equal(text.includes('<foxwarm-message type="channel">'), false, 'legacy channel metadata still honors the metadata preference')
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-timeline-activity]').length), 1)
  assert.equal(await countMatches('RETRY_ERROR'), 0)
  assert.equal(await countMatches('HUMAN_XML'), 1)
  await page.click('[aria-label="Expand activity"]')
  await page.$eval('[data-activity-details] [aria-label="Expand exec tool"]', button => button.click())
  await page.waitForFunction(() => document.querySelector('[data-activity-details]').textContent.includes('TOOL_ERROR'))
  assert.ok((await page.$eval('[data-activity-details]', root => root.textContent)).includes('RETRY_ERROR'))
})


const epoch = 1700000000000
const timed = (seq, second, role, parts, request) => ({ role, parts, __meta: { seq, timestamp: epoch + second * 1000, ...request ? {
  llmRequestId: request.id,
  llmSegment: { outputStart: request.offset || 0, outputEndExclusive: (request.offset || 0) + parts.length, complete: !!request.end },
  ...request.end ? { llmRequestTiming: { startedAt: epoch + request.start * 1000, completedAt: epoch + request.end * 1000, durationMs: (request.end - request.start) * 1000 } } : {},
} : {} } })
const incoming = (seq, second) => timed(seq, second, 'user', [{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/worker">\nRECEIVED_WORK\n</foxwarm-message>'}])
const boundaryRecords = () => [
  timed(1,0,'user',[{text:'START_BODY'}]),
  timed(2,5,'model',[{thinking:'PRE_BODY_REASONING'}],{id:'request-1'}),
  timed(3,10,'model',[{text:'ARRANGED_BODY',providerMeta:{openaiResponses:{outputItem:{type:'message',id:'msg-arranged',phase:'commentary'}}}}],{id:'request-1',start:0,end:10,offset:1}),
  incoming(4,70),
  timed(5,71,'model',[{thinking:'AFTER_RECEIVE_REASONING'},{text:'   '}],{id:'request-2'}),
  timed(6,72,'model',[],{id:'request-2',start:70,end:72,offset:2}),
  timed(7,75,'user',[{system:'<foxwarm-system kind="time" time="fixture" />'}]),
  incoming(8,100),
  timed(9,101,'model',[{thinking:'LATE_REASONING'}],{id:'request-3'}),
  timed(10,120,'model',[{text:'DONE_BODY'}],{id:'request-3',start:100,end:120,offset:1}),
]
const headers = () => page.$$eval('#timeline [data-timeline-activity] [aria-label$="activity"]', buttons => buttons.filter(button=>button.dataset.activityToggle!=='bottom').map(button => button.textContent))
const setRecords = async (records, runtime = {state:'idle',busy:false,queueLength:0}, now = epoch + 120000) => {
  await mode('conversation')
  await page.evaluate(({records,runtime,now}) => { window.fixture.setNow(now); window.fixture.setDraft(null); window.fixture.setSlice([0,undefined]); window.fixture.setMessages(records); window.fixture.setRuntime(runtime) }, {records,runtime,now})
  await page.waitForFunction(() => window.fixture.prefs.timelineView === 'conversation')
}

test('Activity elapsed uses adjacent visible boundaries, retaining leading idle and empty final processing evidence', async () => {
  const records = boundaryRecords()
  await setRecords(records)
  // The displayed divider at the first 70s input excludes the earlier idle minute.
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Waited 28s'))
  assert.deepEqual(await headers(), ['Worked 10s', 'Worked 2s · Waited 28s', 'Worked 20s'])
  assert.deepEqual(await page.$$eval('#timeline .foxwarm-assistant-message-markdown', bodies => bodies.map(body => body.textContent.trim())), ['ARRANGED_BODY','DONE_BODY'])
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-timeline-activity]').length), 3)
  await page.$$eval('#timeline [data-timeline-activity]', activities => { const button=activities[1].querySelector('[data-activity-toggle="top"]'); if(button.getAttribute('aria-expanded')!=='true')button.click() })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-activity-details]')].some(element=>element.textContent.includes('AFTER_RECEIVE_REASONING')))
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('.foxwarm-assistant-message-markdown').length), 2)
  assert.equal(await countMatches('LATE_REASONING'), 0)
  // A successful empty request without committed segments produces no model history record.
  // A later request beginning at the next input cannot account for that earlier processing.
  await setRecords(records.filter((_,index) => index !== 4 && index !== 5))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Elapsed 30s'))
  assert.deepEqual(await headers(), ['Worked 10s','Elapsed 30s','Worked 20s'])
  // Missing request data must not become an invented waiting interval.
  delete records[9].__meta.llmRequestTiming
  await setRecords(records)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Elapsed 20s'))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Elapsed 20s'])
  delete records[2].__meta.timestamp
  await setRecords(records)
  await page.waitForFunction(() => document.querySelector('[data-activity-toggle="top"]')?.textContent==='Activity')
  assert.deepEqual(await headers(), ['Activity','Worked 2s · Waited 28s','Elapsed 20s'])
})

test('Shared logical request and parallel tools clip across text-plus-call and user boundaries without double work', async () => {
  const calls = ['parallel-a','parallel-b'].map(id => ({functionCall:{id,name:'exec',args:{command:'echo actual'}}}))
  const records = [
    timed(1,0,'user',[{text:'FIRST_INPUT'}]),
    timed(2,3,'model',[{thinking:'PARALLEL_REASONING'},{text:'TEXT_WITH_CALL'},...calls],{id:'parallel-request'}),
    timed(3,5,'user',[{text:'INTERRUPTING_INPUT'}]),
    timed(4,8,'model',[],{id:'parallel-request',start:0,end:8,offset:4}),
    timed(5,14,'tool',calls.map((part,index) => ({functionResponse:{tool_use_id:part.functionCall.id,name:'exec',response:{output:'REAL_RESULT'},executionTiming:{startedAt:epoch+8000,completedAt:epoch+(index?14000:12000),durationMs:index?6000:4000}}}))),
    timed(6,20,'model',[{text:'PARALLEL_DONE'}],{id:'next-request',start:14,end:20}),
  ]
  await setRecords(records)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('PARALLEL_DONE'))
  assert.deepEqual(await headers(), ['Worked 3s','Worked 2s · 2 calls','Worked 15s'])
  await page.evaluate(() => window.fixture.setSlice([4,undefined]))
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.deepEqual(await headers(), ['Worked 15s'], 'viewport clipping retains the real left user boundary and does not recount calls')
  // Empty/whitespace model text with only usage or phase metadata is not an Activity record.
  await setRecords([records[0],timed(2,5,'model',[{text:'  ',providerMeta:{openaiResponses:{outputItem:{type:'message',phase:'final'}}}}],{id:'empty',start:0,end:5}),records[5]])
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('TEXT_WITH_CALL'))
  assert.deepEqual(await headers(), [])
})

test('Open Activity clocks update from actual runtime and canonical endpoints, not streaming text arrival; idle coordination also waits', async () => {
  const records = boundaryRecords()
  await setRecords(records.slice(0,-1), {state:'requesting-model',since:epoch+100000,busy:true,queueLength:0}, epoch+110000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Worked 10s'))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Worked 10s'])
  await page.evaluate(() => window.fixture.setDraft({role:'model',parts:[{text:'DONE_BODY'}],__meta:{temporary:true,synthetic:'draft',llmRequestId:'request-3',llmSegment:{outputStart:1,outputEndExclusive:2,complete:false}}}))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('DONE_BODY'))
  await page.evaluate(() => window.fixture.setNow(1700000120000))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Worked 20s'))
  await setRecords(records)
  await page.waitForFunction(() => !document.querySelector('[data-conversation-preview]')?.textContent.includes('DONE_BODY'))
  assert.equal(await page.$$eval('#timeline .foxwarm-assistant-message-markdown', bodies => bodies.filter(body => body.textContent.includes('DONE_BODY')).length), 1, 'canonical reply replaces the provisional process preview without duplicating its text')
  await page.evaluate(() => window.fixture.setNow(1700000600000))
  await new Promise(resolve => setTimeout(resolve,1100))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Worked 20s'], 'closed boundaries do not grow with wall time')
  await setRecords(records.slice(0,6), {state:'idle',busy:false,queueLength:0}, epoch+110000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Worked 2s'))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s'], 'a completed commentary-only request fixes its persisted endpoint while idle')
  await page.evaluate(() => { window.fixture.setNow(1700000120000); window.fixture.setRuntime({state:'idle',busy:false,queueLength:0,since:1700000120000}) })
  await page.waitForFunction(() => window.fixture.runtime.since === 1700000120000)
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s'])
  await setRecords(records.slice(0,3), undefined, epoch+200000)
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.deepEqual(await headers(), ['Worked 10s'], 'no forever-growing empty waiting row after the last visible model text')
})

test('Terminal LLM errors close at their stored timestamp; CTX and missing Stop endpoints do not invent work or waiting', async () => {
  const records = boundaryRecords()
  const error = timed(10,120,'model',[{text:'⚠️ LLM Error: FINAL_FAILURE'}])
  error.__meta.noticeType='llm-retry'; error.__meta.retry={attempt:3,maxAttempts:3,final:true}
  await setRecords([...records.slice(0,-1),error], undefined,epoch+200000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('FINAL_FAILURE'))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Elapsed 20s'])
  await page.evaluate(() => window.fixture.setNow(1700000600000))
  await new Promise(resolve => setTimeout(resolve,1100))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Elapsed 20s'])
  // Normal Stop currently leaves idle unfinished history and no durable stop time. Do not fabricate one.
  await setRecords(records.slice(0,-1), {state:'idle',busy:false,queueLength:0}, epoch+200000)
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('FINAL_FAILURE'))
  assert.deepEqual(await headers(), ['Worked 10s','Worked 2s · Waited 28s','Activity'])
  const block = ctx(80); block.__meta.timestamp=epoch+90000
  await setRecords([...records.slice(0,6),block,...records.slice(7)])
  await page.waitForSelector('[aria-label="Expand CTX-BLOCK B#80"]')
  assert.deepEqual(await headers(), ['Worked 10s','Elapsed 20s','Worked 20s'])
})

test('Direct Task notifications and hosted web search count actual effects; scripts remain ordinary top-level calls', async () => {
  const output = (seq,id,name,data,subCalls) => ({role:'tool',parts:[{functionResponse:{tool_use_id:id,name,response:data,...subCalls?{__meta:{toolScriptSubCalls:subCalls}}:{}}}],__meta:{seq}})
  const taskCall = (id,action) => ({functionCall:{id,name:'task',args:{action,notifySession:true,taskId:'fixture-task'}}})
  const hosted = {providerMeta:{openaiResponses:{outputItem:{id:'ws-real',type:'web_search_call',status:'completed',action:{type:'search',query:'actual hosted query'}}}}}
  const records = [
    {role:'model',parts:[{thinking:'HOSTED_REASONING'},hosted,taskCall('task-create','create'),taskCall('task-assign','assign'),taskCall('task-note','update'),taskCall('task-quiet','update'),taskCall('task-failed','update'),{functionCall:{id:'script-one',name:'run_script',args:{code:'call_tool("create_child_session", args)'}}}],__meta:{seq:1}},
    ...[['task-create',1],['task-assign',2],['task-note',1],['task-quiet',0],['task-failed',0]].map(([id,sentNotifications],index) => output(index+2,id,'task',{output:JSON.stringify({taskId:'fixture-task',status:'active',ownerSessionId:'fixture/owner',sentNotifications,...id==='task-failed'?{warning:'Delivery failed'}:{}})})),
    output(7,'script-one','run_script',{runId:'script-effects',status:'waiting'},[{id:'tss_1',name:'task',status:'completed',startedAt:1},{id:'tss_2',name:'create_child_session',status:'completed',startedAt:1}]),
    {role:'model',parts:[{text:'EFFECTS_BOUNDARY'}],__meta:{seq:8}},
    {role:'model',parts:[hosted,{functionCall:{id:'script-two',name:'continue_script',args:{runId:'script-effects',continuationId:'next'}}}],__meta:{seq:9}},
    output(10,'script-two','continue_script',{runId:'script-effects',status:'completed',result:{sentNotifications:900}},[{id:'tss_1',name:'task',status:'completed',startedAt:1}]),
    {role:'model',parts:[{text:'EFFECTS_DONE'}],__meta:{seq:11}},
  ]
  await setRecords(records)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('EFFECTS_DONE'))
  assert.deepEqual(await headers(), ['7 calls · 4 sent','1 call'])
  await page.evaluate(() => window.fixture.setSlice([8,undefined]))
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.deepEqual(await headers(), ['1 call'], 'script metadata/result data never expands invocation counts or claims internal sends')
})

const dividerTimes = () => page.$$eval('#timeline [data-timeline-time-separator] time', times => times.map(time => time.dateTime))

test('Conversation keeps the 08:11 processing disclosure and 08:15 body under one clock, collapsed or expanded', async () => {
  await mode('conversation')
  await page.emulateTimezone('UTC')
  const base = Date.UTC(2026,9,11,8)
  const stamp = (seq, seconds, role, parts, request) => ({role,parts,__meta:{seq,timestamp:base+seconds*1000,...request?{
    llmRequestId:request.id,llmRequestTiming:{startedAt:base+request.start*1000,completedAt:base+seconds*1000,durationMs:(seconds-request.start)*1000},
  }:{}}})
  const records = [
    stamp(101,0,'user',[{text:'CLOCK_USER'}]),
    stamp(102,665,'model',[{thinking:'UNIT_REASONING'},call('clock-unit')],{id:'clock-first',start:660}),
    stamp(103,670,'tool',[{functionResponse:{name:'exec',tool_use_id:'clock-unit',response:{output:'UNIT_RESULT'},executionTiming:{startedAt:base+665000,completedAt:base+670000,durationMs:5000}}}]),
    stamp(104,720,'user',[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/worker">\nUNIT_REPORT\n</foxwarm-message>'}]),
    stamp(105,780,'model',[{thinking:'UNIT_LATER_REASONING'}],{id:'clock-second',start:720}),
    stamp(106,905,'model',[{text:'UNIT_DONE'}],{id:'clock-body',start:900}),
  ]
  await setRecords(records,undefined,base+960000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('UNIT_DONE'))
  const expected = [new Date(base).toISOString(),new Date(base+660000).toISOString()]
  assert.deepEqual(await dividerTimes(), expected, 'the later request start is not a divider inside the processing/body unit')
  assert.deepEqual(await headers(), ['Worked 10s · Waited 50s · 1 call','Worked 1m5s · Waited 2m'], 'visible communication separates work periods without duplicating measured work or wait')
  assert.deepEqual(await page.$eval('#timeline', root => [...root.querySelectorAll('[data-timeline-time-separator], [data-timeline-activity], .foxwarm-assistant-message-card')].map(node => node.matches('[data-timeline-time-separator]') ? node.querySelector('time').dateTime : node.matches('[data-timeline-activity]') ? 'activity' : node.querySelector('.foxwarm-assistant-message-markdown').textContent.trim())), [...expected,'activity','activity','UNIT_DONE'])
  assert.equal(await countMatches('UNIT_DONE'),1)
  await page.evaluate(() => { window.unitBody=document.querySelector('#timeline .foxwarm-assistant-message-card') })
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_PATH,fullPage:true})
  await page.click('#timeline [aria-label="Expand activity"]')
  await page.$eval('[data-activity-details] [aria-label="Expand exec tool"]', button => button.click())
  await page.waitForFunction(() => document.querySelector('[data-activity-details]')?.textContent.includes('UNIT_RESULT') && document.querySelector('[data-timeline-activity]').style.height === '')
  assert.deepEqual(await dividerTimes(),expected)
  assert.equal(await page.evaluate(() => window.unitBody === document.querySelector('#timeline .foxwarm-assistant-message-card')),true)
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_PATH+'.expanded.png',fullPage:true})
  await page.click('#timeline [aria-label="Collapse activity"]')
  await page.waitForFunction(() => !document.querySelector('[data-activity-details]'))
  assert.deepEqual(await dividerTimes(),expected)
})

test('An unmarked Activity uses its own start; user/CTX boundaries and source-oriented modes retain their dividers', async () => {
  await mode('conversation')
  const base = Date.UTC(2026,9,11,8)
  const stamp = (seq,seconds,role,parts) => ({role,parts,__meta:{seq,timestamp:base+seconds*1000}})
  const block = ctx(120); block.__meta={...block.__meta,seq:117,timestamp:base+1900000,contextBlock:{...block.__meta.contextBlock,rawStartTimestamp:base+1800000}}
  const records = [
    stamp(111,0,'user',[{text:'PREFIX_USER'}]),
    stamp(112,0,'model',[call('clipped-clock')]),
    stamp(113,600,'tool',[{functionResponse:{name:'exec',tool_use_id:'clipped-clock',response:{output:'CLIPPED_RESULT'}}}]),
    stamp(114,900,'model',[{text:'AFTER_UNMARKED_ACTIVITY'}]),
    stamp(115,1200,'user',[{text:'CLOCK_INTERRUPT'}]),
    stamp(116,1500,'model',[{thinking:'BEFORE_CLOCK_CTX'}]),
    block,
    stamp(118,2100,'model',[{text:'AFTER_CLOCK_CTX'}]),
  ]
  await setRecords(records,undefined,base+2200000)
  await page.evaluate(() => window.fixture.setSlice([2,undefined]))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('AFTER_CLOCK_CTX') && !document.querySelector('#timeline').textContent.includes('PREFIX_USER'))
  const iso = seconds => new Date(base+seconds*1000).toISOString()
  assert.deepEqual(await dividerTimes(),[600,1200,1500,1800,2100].map(iso), 'a tool-first disclosure uses its persisted start, not the later 08:15 body time')
  for (const value of ['detailed','grouped']) {
    await mode(value)
    assert.deepEqual(await dividerTimes(),[900,1200,1500,1800,2100].map(iso),value+' retains the original raw-message separators')
  }
  await mode('conversation')
  // With no known start, omit the unit's clock instead of moving the later body's valid timestamp before it.
  delete records[2].__meta.timestamp
  await setRecords(records,undefined,base+2200000)
  await page.evaluate(() => window.fixture.setSlice([2,undefined]))
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('PREFIX_USER') && document.querySelectorAll('#timeline [data-timeline-time-separator]').length === 4)
  assert.deepEqual(await dividerTimes(),[1200,1500,1800,2100].map(iso))
})

test('Activity omits each short overhead gap before summing waiting without changing measured work', async () => {
  await mode('conversation')
  const work = (gap, modelSeconds, toolSeconds, leading = 0, cycles = 1) => {
    const records = [timed(601,0,'user',[{text:'NOISE_START'}])]
    let cursor = leading
    for (let index=0; index<cycles; index++) {
      const id = 'noise-'+index
      const end = cursor+modelSeconds
      records.push(timed(602+index*2,end,'model',[{thinking:'NOISE_REASONING'},call(id)],{id:'noise-request-'+index,start:cursor,end}))
      const startedAt = end+gap
      const completedAt = startedAt+toolSeconds
      records.push(timed(603+index*2,completedAt,'tool',[{functionResponse:{name:'exec',tool_use_id:id,response:{output:'NOISE_RESULT'},executionTiming:{startedAt:epoch+startedAt*1000,completedAt:epoch+completedAt*1000,durationMs:toolSeconds*1000}}}]))
      cursor = completedAt
    }
    records.push(timed(700,cursor+1,'model',[{text:'NOISE_DONE'}],{id:'noise-final',start:cursor,end:cursor+1}))
    return records
  }
  for (const [records,expected] of [
    [work(.405,30,31),'Worked 1m2s · 1 call'],
    [work(.388,20,19),'Worked 40s · 1 call'],
    [work(.4,1,1,0,10),'Worked 21s · 10 calls'],
    [work(1.999,20,19),'Worked 40s · 1 call'],
    [work(2,20,19),'Worked 40s · Waited 2s · 1 call'],
    [work(.388,20,19,30),'Worked 40s · Waited 30s · 1 call'],
  ]) {
    await setRecords(records)
    await page.waitForFunction(expected => document.querySelector('#timeline [data-timeline-activity] [aria-label$="activity"]')?.textContent === expected,{},expected)
    assert.deepEqual(await headers(),[expected])
  }
  // A trustworthy metadata-only completion fixes its endpoint; later idle time is not waiting.
  const open = work(0,20,19).slice(0,-1)
  await setRecords([...open,timed(700,40,'model',[],{id:'noise-final',start:39,end:40})],undefined,epoch+40388)
  await page.waitForFunction(() => document.querySelector('#timeline [data-timeline-activity] [aria-label$="activity"]')?.textContent.includes('Worked 40s'))
  assert.deepEqual(await headers(),['Worked 40s · 1 call'])
  await page.evaluate(() => { window.fixture.setNow(1700000042000); window.fixture.setRuntime({state:'idle',busy:false,queueLength:0,since:1700000042000}) })
  await page.waitForFunction(() => window.fixture.runtime.since === 1700000042000)
  assert.deepEqual(await headers(),['Worked 40s · 1 call'])
})


test('Conversation clocks share logical request timing across a commentary prefix and call suffix without rewinding', async () => {
  await mode('conversation')
  const base = Date.UTC(2026,9,11,11,53,22,945)
  const stamp = (seq,offset,role,parts,extra={}) => ({role,parts,__meta:{seq,timestamp:base+offset,...extra}})
  const request = (id,start,end) => ({llmRequestId:id,llmRequestTiming:{startedAt:base+start,completedAt:base+end,durationMs:end-start}})
  const result = (id,name,start,end,output) => [{functionResponse:{name,tool_use_id:id,response:{output},executionTiming:{startedAt:base+start,completedAt:base+end,durationMs:end-start}}}]
  const records = [
    stamp(801,0,'user',[{text:'SEGMENT_START'}]),
    stamp(802,74953,'model',[...Array.from({length:4},(_,index)=>({thinking:'SEGMENT_REASONING_'+index})),{text:'SEGMENT_COMMENTARY'}],{llmRequestId:'segmented-request',llmSegment:{outputStart:0,outputEndExclusive:5,complete:false}}),
    stamp(803,95823,'model',[{functionCall:{id:'segment-task',name:'task',args:{action:'create',title:'Fixture task'}}}],{...request('segmented-request',68,95807),llmSegment:{outputStart:5,outputEndExclusive:6,complete:true}}),
    stamp(804,95877,'tool',result('segment-task','task',95815,95877,'{"taskId":"fixture-task","status":"open","sentNotifications":0}')),
    stamp(805,127872,'model',[{functionCall:{id:'segment-wait',name:'wait',args:{waitAnySessions:['fixture/worker']}}}],request('wait-request',95900,127872)),
    stamp(806,127922,'tool',result('segment-wait','wait',127872,127922,'Waiting registered')),
    stamp(807,1004404,'user',[{system:'<foxwarm-message type="task" taskId="fixture-task" event="completed" sourceSessionId="fixture/worker">\nFixture task complete\n</foxwarm-message>'}]),
    stamp(808,1050000,'model',[call('segment-read')],request('read-request',1004500,1050000)),
    stamp(809,1051000,'tool',result('segment-read','exec',1050000,1051000,'SEGMENT_RESULT')),
    stamp(810,1074464,'model',[{text:'SEGMENT_FINAL'}],request('final-request',1051000,1074448)),
    stamp(811,1597055,'user',[{text:'LATER_REAL_GAP'}]),
    stamp(812,1657055,'model',[{thinking:'LATER_REASONING'},{text:'LATER_REPLY'}],request('later-request',1597155,1657039)),
  ]
  await setRecords(records,undefined,base+1700000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('LATER_REPLY'))
  const expected = [base,base+1597055].map(value=>new Date(value).toISOString())
  assert.deepEqual(await dividerTimes(),expected,'neither a 75-second generation gap nor the suffix whole-request rewind is an idle separator')
  const unchanged = await headers()
  assert.deepEqual(unchanged, ['Worked 1m14s', 'Worked 2m2s · Waited 14m36s · 3 calls · 1 received', 'Worked 59s'])
  await page.evaluate(() => { window.segmentBody=[...document.querySelectorAll('#timeline .foxwarm-assistant-message-card')].find(card => card.textContent.includes('SEGMENT_FINAL')); document.querySelectorAll('#timeline [aria-label="Expand activity"]').forEach(button=>button.click()) })
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-activity-details]').length===3)
  assert.deepEqual(await dividerTimes(),expected)
  assert.deepEqual(await headers(),unchanged)
  assert.equal(await page.evaluate(() => window.segmentBody===[...document.querySelectorAll('#timeline .foxwarm-assistant-message-card')].find(card => card.textContent.includes('SEGMENT_FINAL'))),true)
  await page.evaluate(() => document.querySelectorAll('#timeline [aria-label="Collapse activity"]').forEach(button=>button.click()))
  await page.waitForFunction(() => !document.querySelector('#timeline [data-activity-details]'))
  assert.deepEqual(await dividerTimes(),expected)
  // A cropped window still uses the suffix timing and commentary boundary in already-loaded history.
  await page.evaluate(() => window.fixture.setSlice([1,2]))
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('SEGMENT_FINAL'))
  assert.deepEqual(await dividerTimes(),[new Date(base+68).toISOString()])
  await page.evaluate(() => window.fixture.setSlice([2,undefined]))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('LATER_REPLY'))
  assert.deepEqual(await dividerTimes(),[base+74953,base+1597055].map(value=>new Date(value).toISOString()),'a clipped suffix starts at its preceding visible commentary boundary without rewinding the shared request')
  // Existing source-oriented modes retain their original rules, including the raw prefix/suffix clocks.
  await page.evaluate(() => window.fixture.setSlice([0,undefined]))
  for (const value of ['detailed','grouped']) {
    await mode(value)
    assert.deepEqual((await dividerTimes()).slice(0,3),[base,base+74953,base+68].map(value=>new Date(value).toISOString()))
  }
  await mode('conversation')
  // Images and user interruptions remain independent visible cuts, not a reason to reuse the request origin.
  const imageRecords=records.map((message,index)=>index===1?{...message,parts:[...message.parts.slice(0,4),image]}:message)
  await setRecords(imageRecords,undefined,base+1700000)
  await page.waitForFunction(() => !!document.querySelector('#timeline img'))
  assert.deepEqual(await dividerTimes(),expected)
  const interrupted=[...records.slice(0,2),stamp(0,80000,'user',[{text:'SEGMENT_INTERRUPT'}]),...records.slice(2)].map((message,index)=>({...message,__meta:{...message.__meta,seq:901+index}}))
  await setRecords(interrupted,undefined,base+1700000)
  await page.evaluate(() => window.fixture.setSlice([3,undefined]))
  await page.waitForFunction(() => !document.querySelector('#timeline').textContent.includes('SEGMENT_COMMENTARY'))
  assert.deepEqual(await dividerTimes(),[base+80000,base+1597055].map(value=>new Date(value).toISOString()))
  // A summary prevents linking the earlier prefix to the suffix's clock. Its own clock stays strict raw-start.
  const block=ctx(121); block.__meta={...block.__meta,timestamp:base+95000,contextBlock:{...block.__meta.contextBlock,rawStartTimestamp:base}}
  const truncated=[...records.slice(0,2),block,...records.slice(2)].map((message,index)=>({...message,__meta:{...message.__meta,seq:1001+index}}))
  await setRecords(truncated,undefined,base+1700000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('SUMMARY_121'))
  assert.deepEqual(await dividerTimes(),[base,base,base+1597055].map(value=>new Date(value).toISOString()))
  // Untimed visible commentary cannot supply either adjacent Activity endpoint.

  delete records[1].__meta.timestamp
  await setRecords(records,undefined,base+1700000)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('SEGMENT_FINAL'))
  assert.deepEqual(await headers(),['Activity','3 calls · 1 received','Worked 59s'])
  assert.deepEqual(await dividerTimes(),expected)
})

test('Every progress update separates adjacent technical spans, including early commentary and later tool suffixes', async () => {
  await mode('conversation')
  const first = 'I will check the existing implementation.'
  const second = 'The update is in place; I am checking the behavior.'
  const final = 'The review is complete.'
  const prefix = [
    timed(1201,0,'user',[{text:'Review the example.'}]),
    timed(1202,5,'model',[{text:first,phase:'commentary'}],{id:'visible-prefix'}),
  ]
  await setRecords(prefix)
  assert.deepEqual(await page.$$eval('#timeline .foxwarm-assistant-message-markdown', nodes => nodes.map(node => node.textContent.trim())),[first])
  assert.equal(await page.$$eval('#timeline [data-timeline-activity]', nodes => nodes.length),0)
  await page.evaluate(() => { window.visibleProgressNode = document.querySelector('#timeline .foxwarm-assistant-message-markdown') })
  const records = [
    ...prefix,
    timed(1203,7,'model',[{thinking:'PRIVATE_FIRST_REASONING'},call('first-span')],{id:'visible-prefix',start:0,end:7,offset:1}),
    timed(1204,8,'tool',[{functionResponse:{name:'exec',tool_use_id:'first-span',response:{output:'PRIVATE_FIRST_RESULT'}}}]),
    timed(1205,12,'model',[{text:second,phase:'commentary'}],{id:'visible-second'}),
    timed(1206,15,'model',[call('second-span')],{id:'visible-second',start:8,end:15,offset:1}),
    timed(1207,16,'tool',[{functionResponse:{name:'exec',tool_use_id:'second-span',response:{output:'PRIVATE_SECOND_RESULT'}}}]),
    timed(1208,20,'model',[{text:final,phase:'final_answer'}],{id:'visible-final',start:16,end:20}),
  ]
  await setRecords(records)
  assert.equal(await page.evaluate(() => window.visibleProgressNode.isConnected && window.visibleProgressNode === document.querySelector('#timeline .foxwarm-assistant-message-markdown')),true,'later tool participation never moves or remounts the earlier update')
  const readingOrder = () => page.$$eval('#timeline .foxwarm-assistant-message-markdown, #timeline [data-timeline-activity]', nodes => nodes.map(node => node.hasAttribute('data-timeline-activity') ? 'process' : node.textContent.trim()))
  assert.deepEqual(await readingOrder(),[first,'process',second,'process',final])
  assert.equal(await page.$eval('#timeline', node => node.textContent.includes('PRIVATE_')),false)
  for (const text of [first,second,final]) assert.equal(await countMatches(text),1)
  await page.$$eval('#timeline [aria-label="Expand activity"]', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-activity-details]').length===2)
  assert.equal(await page.$$eval('#timeline [data-activity-details] .foxwarm-assistant-message-markdown', nodes => nodes.length),0,'opening tools does not duplicate progress prose')
  await page.$$eval('#timeline [aria-label="Collapse activity"]', buttons => buttons.forEach(button => button.click()))
  // Completion-only metadata must not leave a new empty process below the final text.
  const suffix = timed(1209,20,'model',[],{id:'visible-final',start:16,end:20,offset:1})
  suffix.__meta.usage = {inputTokens:10,outputTokens:20}
  await setRecords([...records,suffix])
  assert.deepEqual(await readingOrder(),[first,'process',second,'process',final])
  if (process.env.FOXWARM_CONVERSATION_PREVIEW_PATH) {
    await page.setViewport({width:600,height:900})
    await (await page.$('#timeline')).screenshot({path:process.env.FOXWARM_CONVERSATION_PREVIEW_PATH})
  }
})


test('active history owns retry status independently of the loaded Archive tail', async () => {
  await mode('conversation')
  await page.evaluate(() => {
    const retry = { role: 'model', modelVisible: false, parts: [{ text: 'ARCHIVE_STATUS_RETRY' }], __meta: { seq: 700, noticeType: 'llm-retry', retry: { final: true } } }
    window.fixture.archiveStatusRetry = retry
    window.fixture.setMessages([retry])
    window.fixture.setSlice([0, undefined])
    window.fixture.setDraft(null)
    window.fixture.setCurrentHistory([{ role: 'user', parts: [{ text: 'Later active input' }], __meta: { seq: 701 } }])
  })
  await page.waitForFunction(() => document.querySelector('#timeline [data-timeline-activity]'))
  assert.equal(await page.$('#timeline [data-system-event]'), null)
  assert.equal(await countMatches('ARCHIVE_STATUS_RETRY'), 0)
  await page.evaluate(() => window.fixture.setCurrentHistory([structuredClone(window.fixture.archiveStatusRetry)]))
  await page.waitForSelector('#timeline [data-system-event]')
  assert.equal(await page.$eval('#timeline [data-system-event]', node => !!node.closest('[data-activity-details]')), false)
  assert.equal(await countMatches('ARCHIVE_STATUS_RETRY'), 1)
  await page.evaluate(() => window.fixture.setMessages([window.fixture.archiveStatusRetry, { role: 'user', parts: [{ text: 'Archive-only later row' }], __meta: { seq: 701 } }]))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Archive-only later row'))
  assert.equal(await page.$$eval('#timeline [data-system-event]', nodes => nodes.length), 1, 'active authority, not the displayed Archive tail, owns failure visibility')
  await page.evaluate(() => {
    const nonfinal = { ...window.fixture.archiveStatusRetry, __meta: { ...window.fixture.archiveStatusRetry.__meta, retry: { final: false } } }
    window.fixture.setCurrentHistory([structuredClone(nonfinal)])
    window.fixture.setMessages([nonfinal, { role: 'user', parts: [{ text: 'Archive-only later row' }], __meta: { seq: 701 } }])
  })
  await page.waitForFunction(() => document.querySelector('#timeline [data-system-event]')?.dataset.eventSeverity === 'warning')
  assert.equal(await countMatches('ARCHIVE_STATUS_RETRY'), 1)
  await page.evaluate(() => window.fixture.setCurrentHistory([]))
  await page.waitForFunction(() => !document.querySelector('#timeline [data-system-event]'))
  assert.equal(await countMatches('ARCHIVE_STATUS_RETRY'), 0)
  await page.evaluate(() => window.fixture.setCurrentHistory(undefined))
})

test('system-event cards keep title and summary on one wrapping line with Details below', async () => {
  await mode('conversation')
  await page.evaluate(() => {
    window.fixture.setCurrentHistory(undefined)
    window.fixture.setSlice([0, undefined])
    window.fixture.setDraft(null)
    window.fixture.setMessages([{ role: 'model', modelVisible: false, parts: [{ text: 'Complete diagnostic line one\nComplete diagnostic line two' }], __meta: { seq: 750, noticeType: 'llm-retry', retry: { final: false } } }])
  })
  await page.waitForSelector('#timeline [data-system-event]')
  const geometry = () => page.$eval('#timeline [data-system-event]', card => {
    const heading = card.querySelector('h3')
    const title = heading.querySelector('span')
    const summary = document.createRange()
    summary.selectNodeContents(heading.lastChild)
    const lines = [...summary.getClientRects()]
    const rect = heading.getBoundingClientRect()
    return {
      text: heading.textContent,
      label: card.getAttribute('aria-label'),
      titleWeight: Number(getComputedStyle(title).fontWeight),
      summaryWeight: Number(getComputedStyle(heading).fontWeight),
      titleTop: title.getBoundingClientRect().top,
      summaryTop: lines[0].top,
      summaryLines: lines.length,
      headingBottom: rect.bottom,
      detailsTop: card.querySelector('[data-event-details]').getBoundingClientRect().top,
      overflow: card.scrollWidth > card.clientWidth,
      contained: lines.every(line => line.right <= rect.right + 1 && line.bottom <= rect.bottom + 1),
    }
  })
  try {
    await page.setViewport({ width: 1100, height: 900 })
    const wide = await geometry()
    assert.equal(wide.text.trim(), 'Request retry: A model request attempt failed.')
    assert.equal(wide.label, 'Request retry')
    assert.ok(wide.titleWeight > wide.summaryWeight)
    assert.ok(Math.abs(wide.titleTop - wide.summaryTop) < 1, JSON.stringify(wide))
    assert.equal(wide.summaryLines, 1)
    assert.ok(wide.detailsTop >= wide.headingBottom)
    await page.setViewport({ width: 320, height: 900 })
    const narrow = await geometry()
    assert.ok(narrow.summaryLines > 1, JSON.stringify(narrow))
    assert.equal(narrow.overflow, false)
    assert.equal(narrow.contained, true)
    assert.ok(narrow.detailsTop >= narrow.headingBottom)
    assert.equal(await countMatches('A model request attempt failed.'), 1)
    assert.equal(await countMatches('Complete diagnostic line two'), 1)
    await page.click('#timeline [data-event-details] summary')
    assert.equal(await page.$eval('#timeline [data-event-details] pre', node => node.textContent), 'Complete diagnostic line one\nComplete diagnostic line two')
  } finally {
    await page.setViewport({ width: 1100, height: 900 })
  }
})

test('trusted system events stay identifiable in every timeline mode and never reinterpret ordinary Error prose', async () => {
  const records=[
    {role:'user',parts:[{text:'Review this result'}],__meta:{seq:800}},
    {role:'model',parts:[{text:'Error: this is ordinary assistant prose.'}],__meta:{seq:801}},
    {role:'model',parts:[{text:'Internal diagnostic'}],modelVisible:false,__meta:{seq:802,noticeType:'system-event',sessionNotice:{version:1,id:'failure-demo',source:'compaction',severity:'error',title:'Compaction failed',summary:'No valid plan was produced.',details:'All supplied segments are ineligible. <img src=x onerror=alert(1)>'}}},
    {role:'model',parts:[{text:'Error: ordinary text after the event.'}],__meta:{seq:803}},
    {role:'model',parts:[{text:'Planner text must not become a reply.'}],__meta:{temporary:true,compactPreview:true}},
  ]
  await page.evaluate(records=>{window.fixture.setCurrentHistory(undefined);window.fixture.setMessages(records);window.fixture.setSlice([0,undefined]);window.fixture.setDraft(null)},records)
  for(const selectedMode of ['conversation','detailed','grouped']){
    await mode(selectedMode)
    await page.waitForSelector('#timeline [data-system-event][data-event-source="compaction"]')
    assert.equal(await page.$$eval('#timeline [data-system-event]',rows=>rows.length),1)
    assert.equal(await countMatches('Compaction failed'),1)
    assert.equal(await countMatches('Internal diagnostic'),0)
    assert.equal(await page.$eval('#timeline [data-system-event]',el=>!!el.closest('[data-timeline-activity]')),false)
    assert.equal(await page.$eval('#timeline [data-event-details]',el=>el.open),false)
    assert.match(await page.$eval('#timeline',el=>el.innerText),/Error: this is ordinary assistant prose/)
    assert.match(await page.$eval('#timeline',el=>el.innerText),/ordinary text after the event/)
    assert.doesNotMatch(await page.$eval('#timeline',el=>el.innerText),/Planner text must not become a reply/)
    await page.click('#timeline [data-event-details] summary')
    assert.match(await page.$eval('#timeline [data-event-details] pre',el=>el.textContent),/<img src=x/)
    assert.equal(await page.$('#timeline [data-event-details] img'),null)
    await page.click('#timeline [data-event-details] summary')
  }
})

test('Conversation shows successful sent and received Session messages as distinct readable cards, not Activity', async () => {
  const records=[
    {role:'user',parts:[{text:'Coordinate the verification.'}],__meta:{seq:900}},
    {role:'model',parts:[{text:'I will ask the reviewer to verify the result.'},{functionCall:{id:'send-demo',name:'send_to_session',args:{sessionId:'review/main',message:'Please verify the paired measurements.'}}}],__meta:{seq:901}},
    {role:'tool',parts:[{functionResponse:{tool_use_id:'send-demo',name:'send_to_session',response:{output:'Delivered'}}}],__meta:{seq:902}},
    {role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="review/main">\nThe measurements are consistent.\n</foxwarm-message>'}],__meta:{seq:903}},
    {role:'model',parts:[{functionCall:{id:'failed-demo',name:'send_to_session',args:{sessionId:'missing/main',message:'Must not be shown as sent.'}}}],__meta:{seq:904}},
    {role:'tool',parts:[{functionResponse:{tool_use_id:'failed-demo',name:'send_to_session',response:{error:'Not found'}}}],__meta:{seq:905}},
    {role:'tool',parts:[{functionResponse:{tool_use_id:'script-demo',name:'run_script',response:{output:'Done'},__meta:{toolScriptSubCalls:[{id:'sub-send',name:'builtin:send_to_session',status:'completed',startedAt:1,sessionMessage:{targetSessionId:'analysis/main',message:'Please inspect the memory measurements.'}}]}}}],__meta:{seq:906}},
  ]
  await page.evaluate(records=>{window.fixture.setCurrentHistory(undefined);window.fixture.setMessages(records);window.fixture.setSlice([0,undefined]);window.fixture.setDraft(null)},records)
  await mode('conversation')
  await page.waitForSelector('[data-session-communication="received"]')
  assert.equal(await page.$$eval('[data-session-communication]',els=>els.length),3)
  const outgoing=await page.$eval('[data-session-communication="sent"]',el=>({text:el.innerText,inside:!!el.closest('[data-timeline-activity]'),bubble:!!el.closest('.foxwarm-user-message-bubble')}))
  assert.match(outgoing.text,/To.*review\/main/s);assert.match(outgoing.text,/Please verify the paired measurements/);assert.equal(outgoing.inside,false);assert.equal(outgoing.bubble,false)
  assert.match(await page.$eval('[data-session-communication="received"]',el=>el.innerText),/From.*review\/main.*measurements are consistent/s)
  assert.equal(await countMatches('Please verify the paired measurements'),1)
  assert.equal(await countMatches('The measurements are consistent'),1)
  assert.doesNotMatch(await page.$eval('#timeline',el=>el.innerText),/Must not be shown as sent|foxwarm-message type/)
  await page.evaluate(()=>{window.communicationNode=document.querySelector('[data-session-communication]');window.fixture.setMessages(previous=>[...previous,{role:'model',parts:[{text:'Verification complete.'}],__meta:{seq:907}}])})
  await page.waitForFunction(()=>document.getElementById('timeline').innerText.includes('Verification complete'))
  assert.equal(await page.evaluate(()=>window.communicationNode===document.querySelector('[data-session-communication]')),true)
})

test('expanded Activity retains top and bottom collapse controls without duplicating metrics', async () => {
  const records=[{role:'user',parts:[{text:'Inspect the files.'}],__meta:{seq:1000}}]
  for(let index=0;index<24;index++) records.push({role:'model',parts:[{functionCall:{id:'read-'+index,name:'read',args:{filePath:'report-'+index+'.md'}}}],__meta:{seq:1001+index*2}},{role:'tool',parts:[{functionResponse:{tool_use_id:'read-'+index,name:'read',response:{output:'Inspection result '+index}}}],__meta:{seq:1002+index*2}})
  await page.evaluate(records=>{window.fixture.setCurrentHistory(undefined);window.fixture.setMessages(records);window.fixture.setSlice([0,undefined]);window.fixture.setDraft(null)},records)
  await mode('conversation')
  await page.focus('[data-timeline-activity] button[aria-label="Expand activity"]');await page.keyboard.press('Enter')
  await page.waitForSelector('[data-timeline-activity] [aria-label="Collapse activity"]')
  const geometry=await page.$eval('[data-timeline-activity]',el=>{const details=el.querySelector('[data-activity-details]'),control=el.querySelector('[data-activity-toggle="bottom"]');return {bottom:details.getBoundingClientRect().bottom,top:control.getBoundingClientRect().top,count:el.querySelectorAll('[aria-label="Collapse activity"]').length,focused:document.activeElement===el.querySelector('[data-activity-toggle="top"]')}})
  assert.equal(geometry.count,2);assert.ok(geometry.top>=geometry.bottom-1,JSON.stringify(geometry));assert.equal(geometry.focused,true)
  await page.waitForFunction(()=>document.querySelector('[data-timeline-activity]').style.height==='')
  await page.click('[data-timeline-activity] [data-activity-toggle="bottom"]')
  await page.waitForSelector('[data-activity-details]',{hidden:true})
  assert.equal(await page.$('[data-activity-details]'),null)
  assert.ok(await page.$('[data-timeline-activity] [aria-label="Expand activity"]'))
})
