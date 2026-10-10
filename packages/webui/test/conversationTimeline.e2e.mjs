import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
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
    import ProcessingStatus from './src/components/ProcessingStatus'
    import SessionUiSettingsMenu from './src/components/SessionUiSettingsMenu'
    import { useChatPreferences } from './src/chatPreferences'
    import { projectSessionSearchFields, findSessionSearchMatches } from './src/components/chatSessionSearch'
    const original = ${JSON.stringify(messages)}
    const queued = [
      { role:'user', parts:[{text:'QUEUED_USER'}], __meta:{queuedPreview:true,queueType:'user',temporary:true,synthetic:'queue-user'} },
      { role:'user', parts:[{system:'<foxwarm-message type="timer">\\nQUEUED_INTERNAL\\n</foxwarm-message>'}], __meta:{queuedPreview:true,queueType:'background',temporary:true,synthetic:'queue-timer'} },
    ]
    window.fixture = { fetches:[], controls:[] }
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
      const [draft,setDraft] = React.useState(null)
      const [runtime,setRuntime] = React.useState({state:'running-tool',tool:{name:'exec',startedAt:1700000000000},since:1700000000000,busy:true,queueLength:2})
      window.fixture.prefs=prefs
      window.fixture.setMessages=setMessages
      window.fixture.setSlice=setSlice
      window.fixture.setDraft=setDraft
      window.fixture.setRuntime=setRuntime
      window.fixture.original=original
      window.fixture.matches = term => findSessionSearchMatches(projectSessionSearchFields(messages,prefs.timelineView),term)
      return <div className="foxwarm-chat-root">
        <SessionUiSettingsMenu {...prefs} onSendKeyModeChange={prefs.setSendKeyMode} onTimelineViewChange={prefs.setTimelineView} onShowUsageBadgeChange={prefs.setShowUsageBadge} onShowUserMessageMetadataChange={prefs.setShowUserMessageMetadata} onOpenDebugInfo={()=>{}} />
        <div id="timeline"><ChatTimeline sessionId="fixture/main" messages={[...messages.slice(...slice),...(draft?[draft]:[])]} historyMessages={messages} isRunningTool={runtime.state==='running-tool'} isMobile={false} timelineView={prefs.timelineView} showUsageBadge={prefs.showUsageBadge} showUserMessageMetadata={prefs.showUserMessageMetadata} /></div>
        <div id="status"><ProcessingStatus timelineView={prefs.timelineView} runtimeState={runtime} sessionBusy={runtime.busy} sessionQueueLength={2} turnIncomplete={runtime.state==='idle'} loading={false} isMobile={false} onStop={()=>window.fixture.controls.push('stop')} onContinue={()=>window.fixture.controls.push('continue')} onRunQueued={()=>window.fixture.controls.push('queued')} /></div>
        <div id="queue"><ChatTimeline sessionId="fixture/main" messages={queued} isMobile={false} timelineView={prefs.timelineView} showUsageBadge={false} showTimeDividers={false} /></div>
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
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-activity-details]').length), 0)
  assert.deepEqual(await page.$eval('#timeline', root => [...root.querySelectorAll('.foxwarm-assistant-message-card, img')].map(el => el.tagName === 'IMG' ? 'image' : el.textContent.trim())), ['image', 'COMMENTARY_BODY', 'image', 'MIDDLE_BODY', 'AFTER_CALL_BODY', 'FINAL_BODY'])
  const body = await page.$eval('#timeline', root => root.textContent)
  for (const text of ['QUOTED_USER_BODY', 'PASTED_USER_BODY', 'SUMMARY_40', '</foxwarm-system>']) assert.ok(body.includes(text), text)
  for (const text of ['TECHNICAL_', 'SECRET_REASONING', 'INTERNAL_', 'Worked for']) assert.ok(!body.includes(text), text)
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('[data-usage-badge]').length), 1)
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_E2E_SCREENSHOT_PATH, fullPage: true })
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Expand activity"]')].forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelectorAll('#timeline [data-activity-details]').length === 6)
  for (const text of ['COMMENTARY_BODY', 'MIDDLE_BODY', 'AFTER_CALL_BODY', 'FINAL_BODY']) {
    assert.equal(await page.$eval('#timeline', (root, text) => [...root.querySelectorAll('.foxwarm-assistant-message-card')].filter(card => card.textContent.includes(text)).length, text), 1)
  }
  assert.ok((await page.$eval('#timeline', root => root.textContent)).includes('INTERNAL_TOOL_RESULT'))
  assert.equal(await page.$eval('#timeline', root => root.querySelectorAll('img:not([data-activity-details] img)').length), 2)
  assert.equal(await countMatches('TECHNICAL_mixed'), 0)
  assert.equal(await countMatches('INTERNAL_HANDOFF'), 0)
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

test('live status owns Working once; pending internal inputs do not become activity or completed work, and controls survive', async () => {
  assert.ok((await page.$eval('#status', root => root.textContent)).includes('Working…'))
  assert.equal(await page.$eval('#root', root => (root.textContent.match(/Working…/g) || []).length), 1)
  assert.equal(await page.$eval('#queue', root => root.querySelectorAll('[data-timeline-activity]').length), 0)
  assert.equal((await page.$eval('#queue', root => root.textContent)).trim(), 'QUEUED_USER')
  await page.$eval('#status', root => [...root.querySelectorAll('button')].find(button => button.textContent === 'Stop').click())
  await page.evaluate(() => window.fixture.setRuntime({ state: 'waiting', busy: false, queueLength: 2, waiting: { waitingFor: 'input', reason: 'Please choose a target' } }))
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Waiting · Please choose a target'))
  assert.equal(await page.$eval('#status', root => [...root.querySelectorAll('button')].some(button => button.textContent === 'Stop')), false)
  await page.evaluate(() => window.fixture.setRuntime({ state: 'waiting', busy: false, queueLength: 2, waiting: { waitingFor: 'input' } }))
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Waiting for input'))
  await page.evaluate(() => window.fixture.setRuntime({ state: 'idle', busy: false, queueLength: 2 }))
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Turn interrupted'))
  await page.$eval('#status', root => [...root.querySelectorAll('button')].forEach(button => button.click()))
  assert.deepEqual(await page.evaluate(() => window.fixture.controls), ['stop', 'continue', 'queued'])
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
  await page.evaluate(() => {
    const earlier = { role:'model',parts:[{text:'⚠️ LLM Error: EARLIER_RETRY'}],__meta:{seq:200,noticeType:'llm-retry'} }
    const ordinary = Array.from({length:110},(_,index)=>({role:'model',parts:[{text:'BODY_'+index}],__meta:{seq:201+index}}))
    const tail = { role:'model',parts:[{text:'⚠️ LLM Error: TAIL_RETRY'}],__meta:{seq:400,noticeType:'llm-retry'} }
    window.fixture.tailScenario=[earlier,...ordinary,tail]
    window.fixture.setMessages(window.fixture.tailScenario)
    window.fixture.setSlice([12,undefined])
  })
  await page.waitForSelector('#timeline [data-system-message-kind="llm error"]')
  assert.deepEqual(await page.$$eval('#timeline [data-system-message-kind="llm error"]', cards => cards.map(card => ({text:card.textContent,inside:!!card.closest('[data-activity-details]')}))), [{text:'LLM error ×1TAIL_RETRY',inside:false}])
  await page.evaluate(() => window.fixture.setDraft({role:'model',parts:[{text:'UNCOMMITTED_STREAM'}],__meta:{temporary:true,synthetic:'tail-draft'}}))
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('UNCOMMITTED_STREAM'))
  assert.equal(await page.$$('#timeline [data-system-message-kind="llm error"]').then(cards => cards.length), 1)
  await page.evaluate(() => {
    window.fixture.setDraft(null)
    window.fixture.setMessages([...window.fixture.tailScenario,{role:'model',parts:[{text:'[CTX-BLOCK L1 B#42 raw#1-#2] CTX_BOUNDARY'}],__meta:{contextBlock:{id:42,level:1,rawStartSeq:1,rawEndSeq:2}}}])
  })
  await page.waitForSelector('[aria-label="Expand CTX-BLOCK B#42"]')
  assert.equal(await page.$('#timeline [data-system-message-kind="llm error"]'), null)
  assert.ok(!(await page.$eval('#timeline', root => root.textContent)).includes('TAIL_RETRY'))
  await page.evaluate(() => window.fixture.setSlice([0,1]))
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.equal(await page.$('#timeline [data-system-message-kind="llm error"]'), null, 'the viewport slice ends in an old retry, not the full history tail')
  await page.evaluate(() => { window.fixture.setSlice([0,undefined]); window.fixture.setMessages([...window.fixture.tailScenario,{role:'user',parts:[{text:'REAL_USER_APPEND'}],__meta:{seq:401}}]) })
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('REAL_USER_APPEND'))
  assert.equal(await page.$('#timeline [data-system-message-kind="llm error"]'), null)
  assert.equal(await page.$('#queue [data-system-message-kind="llm error"]'), null)
})

test('Activity statistics use scoped execution unions and recorded outcomes, not gaps, script code or asynchronous sends', async () => {
  const model = (seq, parts, request = false) => ({role:'model',parts,__meta:{seq,...request?{llmRequestId:'stats-request',llmRequestTiming:{startedAt:0,completedAt:120000,durationMs:120000},llmSegment:{outputStart:seq===13?8:0,outputEndExclusive:seq===13?9:8,complete:true}}:{}}})
  const tool = (id,name,output,start,end,error = false,meta) => ({role:'tool',parts:[{functionResponse:{tool_use_id:id,name,response:error?{error:output}:{output},...meta?{__meta:{toolScriptSubCalls:meta}}:{},executionTiming:{startedAt:start,completedAt:end,durationMs:end-start}}}]})
  const records = [
    model(1,[{thinking:'STATS_REASONING'},{functionCall:{id:'child-async',name:'create_child_session',args:{suffix:'async',message:'initial',afterSend:'continue'}}},{functionCall:{id:'child-task',name:'call_tool',args:{toolId:'builtin:create_child_session',args:{taskId:'fixture-task',suffix:'task'}}}},{text:'VISIBLE_BARRIER'}, {functionCall:{id:'send-good',name:'send_to_session',args:{sessionId:'fixture/target',message:'hello'}}},{functionCall:{id:'send-failed',name:'send_to_channel',args:{channelTargetId:'fixture:target',message:'hello'}}},{functionCall:{id:'script',name:'run_script',args:{code:'create_child_session(); send_to_session()'}}},{functionCall:{id:'background',name:'exec',args:{command:'long-job'}}}],true),
    tool('child-async','create_child_session','Child session created: `fixture/async` (new session). Initial message sent.',120000,180000),
    tool('child-task','call_tool','Child session created: `fixture/task` (new session), but task assignment delivery failed.',150000,240000),
    tool('send-good','send_to_session','Message sent to session `fixture/target`',200000,260000),
    tool('send-failed','send_to_channel','SEND_FAILED',220000,250000,true),
    tool('script','run_script','script completed',240000,250000,false,[{id:'tss_1',name:'create_child_session',status:'completed',startedAt:240000,completedAt:245000,durationMs:5000},{id:'tss_2',name:'send_to_session',status:'completed',startedAt:245000,completedAt:250000,durationMs:5000}]),
    tool('background','exec','Background command started',240000,250000),
    {role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/child">\nRECEIVED_ONE\n</foxwarm-message>'}],__meta:{seq:8}},
    {role:'user',parts:[{system:'<foxwarm-system kind="external-input" server="fixture" endpoint="notify">\nRECEIVED_TWO\n</foxwarm-system>'}],__meta:{seq:9}},
    {role:'user',parts:[{system:'<foxwarm-system kind="time" time="one day later" />'}],__meta:{seq:10,timestamp:86400000}},
    {role:'user',parts:[{system:'<foxwarm-system kind="goal-reminder">maintenance</foxwarm-system>'}],__meta:{seq:11}},
    ctx(60),
    model(13,[{functionCall:{id:'no-evidence',name:'run_script',args:{code:'create_child_session(); send_to_session()'}}}],true),
    model(14,[{text:'CONTINUE_BARRIER'},{functionCall:{id:'script-continue',name:'continue_script',args:{runId:'fixture-script',continuationId:'next'}}}]),
    {role:'tool',parts:[{functionResponse:{tool_use_id:'script-continue',name:'continue_script',response:{runId:'fixture-script',status:'completed'},__meta:{toolScriptSubCalls:[{id:'tss_1',name:'create_child_session',status:'completed',startedAt:240000},{id:'tss_2',name:'send_to_session',status:'completed',startedAt:245000},{id:'tss_3',name:'read',status:'completed',startedAt:270000}]}}}]},
  ]
  records[5].parts[0].functionResponse.response.runId='fixture-script'
  await page.evaluate(records => { window.fixture.setMessages(records); window.fixture.setSlice([0,undefined]) }, records)
  await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Created 2 child sessions'))
  assert.deepEqual(await page.$$eval('#timeline [data-timeline-activity] > button', buttons => buttons.map(button => button.textContent.slice(1))), [
    'Worked for 2m · Called 2 tools',
    'Worked for 2m20s · Created 2 child sessions · Sent 1 message · Received 2 messages · Called 5 tools',
    'Called 1 tool',
    'Called 1 tool',
  ])
  assert.ok(!(await page.$eval('#timeline', root => root.textContent)).includes('Waited'), 'canonical history does not record completed waits')
  assert.ok(!(await page.$eval('#timeline', root => root.textContent)).includes('Activity · Error'))
  await page.$eval('#timeline', root => [...root.querySelectorAll('[aria-label="Expand activity"]')][1].click())
  await page.waitForFunction(() => document.querySelector('[data-activity-details]').textContent.includes('SEND_FAILED'))
  assert.ok((await page.$eval('[data-activity-details]', root => root.textContent)).includes('SEND_FAILED'))
  await page.evaluate(() => window.fixture.setSlice([14,undefined]))
  await page.waitForFunction(() => document.querySelector('#timeline').querySelectorAll('[data-timeline-activity]').length === 1)
  assert.equal(await page.$eval('#timeline [data-timeline-activity] > button', button => button.textContent.slice(1)), 'Called 1 tool', 'continuation snapshots do not recount old subcalls outside the viewport')
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
  await page.waitForFunction(() => document.querySelector('[data-activity-details]').textContent.includes('TOOL_ERROR'))
  assert.ok((await page.$eval('[data-activity-details]', root => root.textContent)).includes('RETRY_ERROR'))
})
