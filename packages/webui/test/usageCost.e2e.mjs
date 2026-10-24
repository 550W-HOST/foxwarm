import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

let server, browser, page, url
before(async () => {
  const cssName = (await readdir(new URL('../dist/assets/', import.meta.url))).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(`../dist/assets/${cssName}`, import.meta.url), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from './src/components/ChatTimeline'
    import TokenUsageDetails from './src/components/TokenUsageDetails'
    import WorkbenchStatusBar from './src/components/WorkbenchStatusBar'
    import ArchitectureView from './src/components/ArchitectureView'
    import { buildTimelineRows } from './src/components/timelineRows'
    import { useBoundedSessionList } from './src/boundedSessionList'
    const counts = {cachedTokens:8,inputTokens:2,outputTokens:5}
    const row = (seq, parts, usage, extra = {}) => ({role:'model',parts,__meta:{seq,timestamp:1700000000000+seq*1000,usage,...extra}})
    const messages = [
      row(1,[{text:'Commentary',phase:'commentary'}],undefined,{llmRequestId:'r',llmSegment:{complete:false}}),
      row(2,[],{...counts,cost:.125},{llmRequestId:'r',llmSegment:{complete:true}}),
      row(3,[{text:'Final',phase:'final_answer'}],{...counts,cost:0},{llmRequestId:'final'})
    ]
    const tool = (seq,cost) => row(seq,[{functionCall:{id:'t'+seq,name:'read',args:{filePath:'file'}}}],{...counts,...(cost===undefined?{}:{cost})})
    const result = seq => ({role:'tool',parts:[{functionResponse:{tool_use_id:'t'+seq,name:'read',response:{output:'ok'}}}],__meta:{seq:seq+1}})
    const grouped = [tool(10,.25),result(10),tool(12,undefined),result(12),tool(14,0),result(14),row(16,[{text:'Done'}],undefined)]
    const base = {isMobile:false,showUsageBadge:true,showTimeDividers:false,nestedDepth:0,expandedGroupKeys:new Set()}
    window.costFixture = { derive: () => {
      const first = buildTimelineRows({...base,messages:grouped,timelineView:'grouped'},null)
      grouped[0].__meta.usage.cost=.375
      const next = buildTimelineRows({...base,messages:grouped,timelineView:'grouped'},first.cache)
      return {before:first.rows[0].group.usage.cost,after:next.rows[0].group.usage.cost,reused:first.rows[0]===next.rows[0]}
    }}
    const session = {id:'cost',agent:'main',currentNode:'master',busy:false,queueLength:0,messageCount:1,lastMessageTime:1,tokenUsage:{...counts,cost:.125}}
    window.fetch = async input => {
      const address=String(input)
      const payload = address.includes('/session-list/architecture') ? {version:1,revision:'r',roots:{sessions:[session],hasMore:false},children:[],agentCounts:[{agent:'main',count:2}],summary:{total:2,busy:0,queued:0,managed:0,...counts,cost:1.25}}
        : address.includes('/tasks') ? {total:0,tasks:[]}
        : address.includes('/nodes') ? {nodes:[]} : address.includes('/agents') ? {agents:[]} : {}
      return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}})
    }
    class Socket { static CLOSED=3; constructor(){this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.({});this.onmessage?.({data:JSON.stringify({type:'connected'})})})} close(){this.readyState=3} send(){} }
    window.WebSocket=Socket
    function Status(){
      const bounded=useBoundedSessionList({focusIds:[],connectStream:false,includeGlobalSummary:true})
      return <WorkbenchStatusBar running={0} sessions={[]} nodes={[]} totalUsage={bounded.globalSummary?.tokenUsage} currentSession={{...session,tokenUsage:{...counts,cost:0}}} currentSessionId="cost" onOpenTasks={()=>{}} onOpenNodes={()=>{}} />
    }
    const roots = {}
    for(const mode of ['detailed','conversation','grouped']) {
      roots[mode]=createRoot(document.getElementById(mode))
      roots[mode].render(<ChatTimeline sessionId="cost" messages={mode==='grouped'?grouped:messages} historyMessages={mode==='grouped'?grouped:messages} {...base} timelineView={mode} />)
    }
    for(const [id,usage,loaded] of [['unknown',counts,false],['zero',{...counts,cost:0},false],['tiny',{...counts,cost:.0000001},true]])
      createRoot(document.getElementById(id)).render(<TokenUsageDetails usage={usage} detailed loaded={loaded} />)
    createRoot(document.getElementById('status')).render(<Status />)
    createRoot(document.getElementById('architecture')).render(<ArchitectureView onSelectSession={()=>{}} onBack={()=>{}} onOpenNodes={()=>{}} onCreateAgent={()=>{}} onCreateSession={()=>{}} onAgentsChanged={()=>{}} onOpenAgentMemory={()=>{}} />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'usage-cost-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><style>${css}</style></head><body>${['detailed','conversation','grouped','unknown','zero','tiny','status','architecture'].map(id=>`<section id="${id}" style="width:1000px;min-height:160px;margin:20px"></section>`).join('')}<script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1000 })
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
const mount = async () => { await page.goto(url, { waitUntil: 'load' }); await page.waitForSelector('#grouped [data-usage-badge]') }
const text = selector => page.$eval(selector, el => el.textContent)

test('request details preserve recorded amounts, group only known amounts, and retain zero', async () => {
  await mount()
  for (const button of await page.$$('#detailed [data-usage-badge-toggle]')) await button.click()
  assert.match(await text('#detailed'), /\$0\.125 USD/)
  assert.match(await text('#detailed'), /\$0\.00 USD/)
  await page.click('#grouped [data-usage-badge-toggle]')
  assert.match(await text('#grouped'), /Recorded estimated cost\$0\.25 USD/)
  assert.match(await text('#grouped'), /Calls3/)
  assert.doesNotMatch(await text('#unknown'), /USD|estimated cost/)
  assert.match(await text('#zero'), /\$0\.00 USD/)
  assert.match(await text('#tiny'), /< \$0\.0001 USD/)
})

test('Conversation counts the complete empty suffix once and cost invalidates memoized usage', async () => {
  await mount()
  await page.click('#conversation [aria-label="Show process usage"]')
  assert.match(await text('#conversation [data-conversation-usage-details]'), /Recorded estimated cost\$0\.125 USD/)
  const derived = await page.evaluate(() => window.costFixture.derive())
  assert.deepEqual(derived, { before: .25, after: .375, reused: false })
})

test('Workbench uses global saved subtotal and distinguishes current-session zero', async () => {
  await mount()
  await page.waitForFunction(() => document.querySelector('#status [aria-label="Total token usage"]')?.textContent.includes('15'))
  await page.click('#status [aria-label="Total token usage"]')
  await page.waitForSelector('[data-workbench-status-popup]')
  assert.match(await text('[data-workbench-status-popup]'), /\$1\.25 USD/)
  await page.click('#status [aria-label="Current Session token usage"]')
  assert.match(await text('[data-workbench-status-popup]'), /\$0\.00 USD/)
})

test('Architecture keeps global and loaded-window recorded estimates separate', async () => {
  await mount()
  await page.evaluate(() => { for (const section of document.querySelectorAll('body > section')) if (section.id !== 'architecture') section.style.display = 'none'; window.scrollTo(0, 0) })
  await page.waitForSelector('#architecture [aria-label="Global token usage"]')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.click('#architecture [aria-label="Global token usage"]')
  await page.waitForSelector('[role="dialog"][aria-label="Token usage"]')
  assert.match(await text('[role="dialog"][aria-label="Token usage"]'), /\$1\.25 USD/)
  await page.keyboard.press('Escape')
  await page.click('#architecture [aria-label="Loaded token usage"]')
  assert.match(await text('[role="dialog"][aria-label="Token usage"]'), /\$0\.125 USD/)
})
