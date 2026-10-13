import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chatEntry = new URL('../src/components/Chat.tsx', import.meta.url).pathname
const assets = new URL('../dist/assets/', import.meta.url)
const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
let browser, page, server
const wrapperBodies = {
  full: '\n  BEFORE\n<foxwarm-message type="timer" />\n<foxwarm-system kind="time" time="example" />\nAFTER\n\n<foxwarm-system kind="event">\nQUOTED_BODY\n</foxwarm-system>\n\n',
  legacy: 'LEGACY_BEFORE\n<foxwarm-system kind="time" time="legacy-example" />\n<foxwarm-system kind="event">\nLEGACY_QUOTED\n</foxwarm-system>\nLEGACY_AFTER',
  split: '<foxwarm-message type="channel" note="SPLIT_CHANNEL_XML">\nSPLIT_BODY\n</foxwarm-message>\n<foxwarm-system kind="time" time="split-example" />',
}

before(async () => {
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build the WebUI before browser tests')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
    import { formatFoxwarmMessage, formatFoxwarmMessageOpen, formatFoxwarmMessageClose } from '../../src/utils/promptWrappers'
    const old = Array.from({length: 108}, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{text: i === 4 ? 'OLD_ONLY_MATCH' : 'Earlier ordinary message ' + i}], __meta: { seq: i + 1, timestamp: 1700000000000 + i } }))
    old[10].parts[0].text = '<pasted-text>' + 'P'.repeat(95) + 'PASTED_DEEP_SEARCH <foxwarm-system kind="opaque" note="OPAQUE_TAG_TARGET">literal</foxwarm-system>' + '</pasted-text>'
    old[12].parts[0].text = 'See <attachment-ref ref="attachment1" />\\n<foxwarm-file name="attachment1_attachment-marker-only.txt" mime="text/plain" />'
    const call = (id, seq, name, args) => ({role:'model',parts:[{functionCall:{id,name,args}}],__meta:{seq,timestamp:1700000000000+seq}})
    const response = (id, seq, name, data) => ({role:'tool',parts:[{functionResponse:{tool_use_id:id,name,response:data}}],__meta:{seq,timestamp:1700000000000+seq}})
    const toolBody = 'A'.repeat(900) + ' CJK目标尾部 & <safe>'
    const history = [...old,
      call('exec-a',109,'exec',{command:'echo command-needle'}), response('exec-a',110,'exec',{output:toolBody}),
      call('read-b',111,'read',{filePath:'search-target.txt'}), response('read-b',112,'read',{output:'read-file-needle\\nagain'}),
      call('custom-c',113,'unknown_tool',{payload:{needle:'fallback-needle'}}), response('custom-c',114,'unknown_tool',{output:{data:'json-needle'}}),
      {role:'model',parts:[{thinking:'First reasoning summary'},{thinking:'Reasoning **thought-needle** here'},{thinking:'',providerMeta:{thinkingSummaries:[],encryptedThinking:'opaque-search-not-visible'}},{text:'Final hello **world** &amp; safe content'},{text:'Text plus image keeps visible-needle',inlineData:{mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}}],__meta:{seq:115,timestamp:1700000000115,usage:{reasoningTokens:31}}},
      {role:'model',parts:[{text:'[CTX-BLOCK L1 B#7 raw#1-#3] ' + 'summary line\\n'.repeat(10) + 'CTX摘要末尾'}],__meta:{seq:116,timestamp:1700000000116,contextBlock:{id:7,level:1,rawStartSeq:1,rawEndSeq:3,sourceKind:'message'}}},
      {role:'user',parts:[{system:'<foxwarm-system kind="goal-reminder">\\n' + 'reminder line\\n'.repeat(10) + 'SYSTEM_BODY_HIDDEN_TARGET\\n</foxwarm-system>'}],__meta:{seq:117,timestamp:1700000000117}},
      call('group-a',118,'exec',{command:'echo group start'}), response('group-a',119,'exec',{output:'start done'}),
      {role:'user',parts:[{system:'<foxwarm-system kind="event" type="fixture">\\nGROUP_EVENT_TARGET\\n</foxwarm-system>'}],__meta:{seq:120,timestamp:1700000000120}},
      {role:'user',parts:[{system:'<foxwarm-system kind="goal-reminder">\\nGROUP_GOAL_TARGET\\n</foxwarm-system>'}],__meta:{seq:121,timestamp:1700000000121}},
      call('group-b',122,'read',{filePath:'group.txt'}), response('group-b',123,'read',{output:'group finished'}),
      call('group-edit',124,'edit',{filePath:'sample.txt',oldText:'keep DIFF_SHARED_ONLY\\nold',newText:'keep DIFF_SHARED_ONLY\\nnew'}), response('group-edit',125,'edit',{output:'done'}),
      {role:'model',parts:[{text:'İ UNIQUEOFFSET tail'}],__meta:{seq:126,timestamp:1700000000126}},
      {role:'user',parts:[{text:'<pasted-text>dupeWORD first, dupeWORD second</pasted-text> plain dupeWORD one and dupeWORD two'}],__meta:{seq:127,timestamp:1700000000127}},
      {role:'model',parts:[{text:'start\\n\\n\\\\[\\nZ\\n\\\\]\\n\\nZ after'}],__meta:{seq:128,timestamp:1700000000128}},
      {role:'model',modelVisible:false,parts:[{text:'⚠️ LLM Error: Attempt 1/5 failed: LLM_RETRY_SEARCH_TARGET\\nAttempt 2/5 failed: second retry'}],__meta:{seq:129,timestamp:1700000000129,noticeType:'llm-retry'}},
    ]
    const channelAttrs = {type:'channel',channelType:'webui',time:'METADATA_ONLY',hint:'direct user message via channel'}
    const wrapperBodies = ${JSON.stringify(wrapperBodies)}
    // Text-only channel ingress stores the complete envelope in one system part; attachments use split boundaries.
    const wrappedHistory = [
      {role:'user',parts:[{system:'<foxwarm-system kind="time" time="OUTER_TIME_METADATA" />'},{system:formatFoxwarmMessage(channelAttrs,wrapperBodies.full)}],__meta:{seq:501}},
      {role:'user',parts:[{text:formatFoxwarmMessage(channelAttrs,wrapperBodies.legacy)}],__meta:{seq:502}},
      {role:'user',parts:[{system:formatFoxwarmMessageOpen(channelAttrs)},{text:wrapperBodies.split},{system:formatFoxwarmMessageClose()}],__meta:{seq:503}},
    ]
    window.fixture = { archiveRequests:0, get history(){return history}, emitStream(text){this.socket?.onmessage?.({data:JSON.stringify({type:'session-event',sessionId:'fixture/main',event:{type:'model-stream-update',streamId:'fixture-search-stream',text}})})} }
    window.fetch = async input => {
      const url = String(input)
      if (url.includes('/context-blocks/')) {window.fixture.archiveRequests++;return new Response('{}',{status:404})}
      if (url.includes('/history')) {
        const wrapped = url.includes('fixture%2Fwrapped')
        const compact = url.includes('fixture%2Fcompact-')
        const messages = compact ? window.fixture.compactHistory : wrapped ? wrappedHistory : history
        return new Response(JSON.stringify({session:{id:compact?window.fixture.compactSessionId:wrapped?'fixture/wrapped':'fixture/main',busy:compact?window.fixture.compactRuntime.busy:false,busyStartedAt:compact?window.fixture.compactBusyStartedAt:null,runtimeState:compact?window.fixture.compactRuntime:{state:'idle'},queueLength:0,messageCount:messages.length,historyVersion:0,modelKey:'fixture/model'},messages,queuedMessages:[],queueLength:0,latestSeq:compact?messages.at(-1).__meta.seq:wrapped?503:129,historyVersion:0,prefixLength:0,historyComplete:true}),{status:200,headers:{'Content-Type':'application/json'}})
      }
      if (url.includes('/models')) return new Response(JSON.stringify({models:[{key:'fixture/model',contextLimit:128000}]}),{status:200})
      if (url.includes('/asr/status')) return new Response(JSON.stringify({configured:false,available:false}),{status:200})
      if (url.includes('/commands')) return new Response(JSON.stringify({commands:[]}),{status:200})
      return new Response('{}',{status:404})
    }
    class Socket { static CONNECTING=0; static OPEN=1;static CLOSED=3;
      constructor(){this.readyState=0;window.fixture.socket=this;queueMicrotask(()=>{this.readyState=1;this.onopen?.({});this.onmessage?.({data:JSON.stringify({type:'connected'})})})}
      close(){this.readyState=3}
      send(raw){const data=JSON.parse(raw);if(data.type==='set-subscriptions') queueMicrotask(()=>{this.onmessage?.({data:JSON.stringify({type:'subscriptions-accepted',revision:data.revision,sessionListResolutions:{},sessionResolutions:Object.fromEntries(data.sessionIds.map(id=>[id,id]))})});this.onmessage?.({data:JSON.stringify({type:'subscriptions-applied',revision:data.revision})})})}
    }
    window.WebSocket=Socket
    function Fixture(){
      const [timelineView,setTimelineView]=React.useState('grouped')
      const [sessionId,setSessionId]=React.useState('fixture/main')
      const [showUserMessageMetadata,setMetadata]=React.useState(false)
      window.fixture.setTimelineView=setTimelineView
      window.fixture.showWrappers=()=>{setSessionId('fixture/wrapped');setTimelineView('conversation')}
      window.fixture.showCompactTiming=(messages,now,runtime,busyStartedAt=null)=>{
        window.fixture.compactHistory=messages
        window.fixture.now=now
        Date.now=()=>window.fixture.now
        window.fixture.compactRuntime=runtime
        window.fixture.compactBusyStartedAt=busyStartedAt
        window.fixture.compactSessionId='fixture/compact-'+(window.fixture.compactSerial=(window.fixture.compactSerial||0)+1)
        setSessionId(window.fixture.compactSessionId);setTimelineView('conversation')
      }
      window.fixture.updateCompactTiming=(messages,now,runtime)=>{
        window.fixture.compactHistory=messages;window.fixture.now=now;window.fixture.compactRuntime=runtime
        window.fixture.socket.onmessage({data:JSON.stringify({type:'session-state',sessionId:window.fixture.compactSessionId,session:{id:window.fixture.compactSessionId,busy:runtime.busy,busyStartedAt:window.fixture.compactBusyStartedAt,runtimeState:runtime,queueLength:0,messageCount:messages.length,historyVersion:0,modelKey:'fixture/model'}})})
      }
      return React.createElement(Chat,{sessionId,timelineView,showUsageBadge:false,showUserMessageMetadata,onShowUserMessageMetadataChange:setMetadata})
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const bundle = await build({ stdin: {contents:fixture,resolveDir:new URL('..',import.meta.url).pathname,sourcefile:'chat-search-fixture.tsx'}, bundle:true,format:'iife',platform:'browser',target:'chrome120',write:false,define:{'process.env.NODE_ENV':JSON.stringify('test')},logLevel:'silent' })
  server = createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser = await puppeteer.launch({browser:firefox?'firefox':'chrome',executablePath:firefox?(process.env.FOXWARM_E2E_FIREFOX||'/usr/bin/firefox'):(process.env.FOXWARM_E2E_CHROMIUM||'/usr/bin/chromium'),headless:true,args:firefox?[]:['--no-sandbox','--disable-setuid-sandbox']})
  page=await browser.newPage();if(!firefox) await page.setViewport({width:1100,height:760});await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});await page.evaluate(()=>localStorage.clear());await page.waitForSelector('button[aria-label="Find in chat"]')
})
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve))})

const query = async text => {
  await page.$eval('[data-chat-search] input[aria-label="Search messages"]', (input,value) => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}, text)
  await page.waitForFunction(value => document.querySelector('[data-chat-search] input[aria-label="Search messages"]')?.value===value,{},text)
}
const snapshot = () => page.evaluate(() => {
  const container=document.querySelector('.foxwarm-chat-messages')
  const highlights=[...CSS.highlights].filter(([name])=>name.startsWith('foxwarm-chat-search-'))
  const range=highlights[0]?.[1].values().next().value
  const rect=range?.getBoundingClientRect(),viewport=container?.getBoundingClientRect()
  return {hits:document.querySelector('[role="search"] [aria-live]')?.textContent,highlight:range?.toString(),surface:range?.startContainer.parentElement?.closest('[data-search-surface]')?.getAttribute('data-search-surface'),visible:!!(rect&&viewport&&rect.top>=viewport.top-2&&rect.bottom<=viewport.bottom+2),rect:rect&&{top:rect.top,bottom:rect.bottom},viewport:viewport&&{top:viewport.top,bottom:viewport.bottom},scrollTop:container?.scrollTop,groups:[...document.querySelectorAll('[data-tool-group]')].map(el=>el.dataset.toolGroupExpanded),archive:window.fixture.archiveRequests,oldMounted:!!document.querySelector('[data-search-row="seq-local-5"]'),distance:container?.scrollHeight-container?.scrollTop-container?.clientHeight}
})

test('finds the complete tool tail through a folded group and inner card, and restores disclosure on close',async()=>{
  assert.equal(await page.$eval('button[aria-label="Find in chat"]',button=>button.textContent.trim()),'Find')
  assert.ok(await page.$('button[aria-label="Find in chat"] svg.lucide-search'))
  await page.click('button[aria-label="Find in chat"]')
  assert.equal(await page.$eval('[data-chat-search] input', input=>input.placeholder),'Search messages')
  await page.waitForSelector('[data-chat-search] input[aria-label="Search messages"]')
  assert.equal((await snapshot()).oldMounted,false)
  await page.type('[data-chat-search] input[aria-label="Search messages"]','CJK目标尾部')
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='CJK目标尾部'))
  const state=await snapshot()
  assert.equal(state.hits,'1/1');assert.equal(state.highlight,'CJK目标尾部');assert.equal(state.visible,true)
  assert.equal(state.groups[0],'true');assert.equal(state.archive,0)
  assert.equal(state.oldMounted,false,'a recent match does not mount the older loaded prefix')
  assert.ok(await page.$eval('[data-search-surface="response"]',el=>el.textContent.includes('CJK目标尾部')))
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_PATH})
  await page.click('[aria-label="Close search"]')
  assert.equal(await page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('foxwarm-chat-search-')).length),0)
  assert.equal((await snapshot()).groups[0],'false')
})

test('standalone Chat captures Ctrl/Cmd+F but leaves extended find combinations alone',async()=>{
  await page.click('[role="textbox"][aria-label="Message"]')
  await page.keyboard.down('Control');await page.keyboard.press('f');await page.keyboard.up('Control')
  await page.waitForSelector('[data-chat-search] input[aria-label="Search messages"]')
  await page.type('[data-chat-search] input','retained')
  await page.keyboard.down('Meta');await page.keyboard.press('f');await page.keyboard.up('Meta')
  assert.equal(await page.$eval('[data-chat-search] input',input=>input===document.activeElement&&input.selectionStart===0&&input.selectionEnd===input.value.length),true)
  await page.click('[aria-label="Close search"]')
  const ignored=await page.evaluate(()=>{
    const send=init=>{const event=new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true,...init});window.dispatchEvent(event);return event.defaultPrevented}
    return [send({shiftKey:true}),send({altKey:true}),send({isComposing:true})]
  })
  assert.deepEqual(ignored,[false,false,false])
  assert.equal(await page.$('[data-chat-search]'),null)
})

test('Ctrl/Cmd+F captures text and composer selections, and search history navigates without recording prefixes',async()=>{
  await page.evaluate(()=>localStorage.clear())
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('[data-search-surface="model"]')].find(element => element.textContent?.includes('Earlier ordinary message 4'))
    if (!target) throw new Error('selection target not found')
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && !node.textContent?.includes('Earlier ordinary message 4')) {}
    if (!node) throw new Error('selection text not found')
    const text = node.textContent
    const start = text.indexOf('Earlier ordinary message 4')
    const range = document.createRange();range.setStart(node, start);range.setEnd(node, start + 'Earlier ordinary message 4'.length)
    const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range)
  })
  await page.keyboard.down('Control');await page.keyboard.press('f');await page.keyboard.up('Control')
  await page.waitForSelector('[data-chat-search] input[aria-label="Search messages"]')
  assert.equal(await page.$eval('[data-chat-search] input',input=>input.value),'Earlier ordinary message 4')
  await page.click('[aria-label="Close search"]')

  const editor = '[contenteditable="true"]'
  await page.focus(editor);await page.keyboard.type('composer selection')
  await page.evaluate(selector => {
    const target = document.querySelector(selector)
    if (!target) throw new Error('composer not found')
    const node = target.firstChild
    if (!node) throw new Error('composer text not found')
    const range = document.createRange();range.selectNodeContents(target)
    const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range)
  }, editor)
  await page.keyboard.down('Control');await page.keyboard.press('f');await page.keyboard.up('Control')
  await page.waitForFunction(()=>document.querySelector('[data-chat-search] input')?.value==='composer selection')
  await page.click('[aria-label="Close search"]')

  await page.click('button[aria-label="Find in chat"]')
  await page.type('[data-chat-search] input[aria-label="Search messages"]','second complete query')
  await page.click('[aria-label="Close search"]')
  await page.click('button[aria-label="Find in chat"]')
  const input = '[data-chat-search] input[aria-label="Search messages"]'
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.$eval(input,input=>input.value),'second complete query')
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.$eval(input,input=>input.value),'composer selection')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.$eval(input,input=>input.value),'second complete query')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.$eval(input,input=>input.value),'')
  await page.click('[aria-label="Close search"]')
})

test('Search history arrows do not take over while an IME composition is active',async()=>{
  await page.evaluate(()=>localStorage.clear())
  await page.click('button[aria-label="Find in chat"]')
  const input = '[data-chat-search] input[aria-label="Search messages"]'
  await page.type(input,'ime complete query')
  await page.click('[aria-label="Close search"]')
  await page.click('button[aria-label="Find in chat"]')
  const composing = await page.$eval(input,input=>{
    const event = new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true,isComposing:true})
    const dispatched = input.dispatchEvent(event)
    return {dispatched,value:input.value,defaultPrevented:event.defaultPrevented}
  })
  assert.deepEqual(composing,{dispatched:true,value:'',defaultPrevented:false})
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.$eval(input,input=>input.value),'ime complete query')
  await page.click('[aria-label="Close search"]')
})

test('finds already-loaded older unmounted rows, read results, reasoning, rendered Markdown and CTX summary without Archive',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  for(const [needle, expected] of [['OLD_ONLY_MATCH','OLD_ONLY_MATCH'],['PASTED_DEEP_SEARCH','PASTED_DEEP_SEARCH'],['command-needle','command-needle'],['read-file-needle','read-file-needle'],['fallback-needle','fallback-needle'],['json-needle','json-needle'],['thought-needle','thought-needle'],['hello world','hello world'],['visible-needle','visible-needle'],['<safe>','<safe>'],['CTX摘要末尾','CTX摘要末尾'],['SYSTEM_BODY_HIDDEN_TARGET','SYSTEM_BODY_HIDDEN_TARGET']]){
    await page.click('[data-chat-search] input[aria-label="Search messages"]');await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.keyboard.type(needle)
    await page.waitForFunction(value=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()===value),{timeout:4000},expected)
    const state=await snapshot();assert.equal(state.visible,true,`${needle} ${JSON.stringify(state)}`);assert.equal(state.hits,'1/1',needle)
    if(needle==='thought-needle') {
      assert.deepEqual(await page.evaluate(()=>{
        const entry=[...CSS.highlights].find(([name])=>name.startsWith('foxwarm-chat-search-'))
        const range=entry?.[1].values().next().value
        const body=range?.startContainer.parentElement.closest('[data-search-surface="reasoning"]')
        const card=body?.closest('[data-model-thread-card="reasoning"]')
        return {index:body?.dataset.searchPartIndex,tag:card?.querySelector('.foxwarm-reasoning-tag')?.textContent,tokens:card?.querySelector('[data-reasoning-tokens]')?.textContent}
      }),{index:'1',tag:'Reasoning ×3',tokens:'31 tokens'})
    }
  }
  const state=await snapshot();assert.equal(state.oldMounted,true);assert.equal(state.archive,0)
  assert.equal(await page.$eval('.foxwarm-context-block-card [aria-label="Expand CTX-BLOCK B#7"]',el=>el.getAttribute('aria-expanded')),'false')
  await page.click('[aria-label="Close search"]')
})

test('LLM retry Search indexes the metadata-classified body without its warning prefix',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  await query('LLM_RETRY_SEARCH_TARGET')
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='LLM_RETRY_SEARCH_TARGET'))
  assert.equal((await snapshot()).hits,'1/1')
  await query('LLM Error')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='0/0')
  await page.click('[aria-label="Close search"]')
})

test('literal matching and local keyboard navigation keep the match counter in sync',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  await page.type('[data-chat-search] input[aria-label="Search messages"]','earlier ordinary message')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/105',{timeout:5000})
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString().toLowerCase()==='earlier ordinary message'),{timeout:5000})
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='2/105',{timeout:5000})
  await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/105',{timeout:5000})
  for(const excluded of ['iVBORw0KGgoAAAANSUhEUg','opaque-search-not-visible','attachment1_attachment-marker-only','attachment-ref ref=','foxwarm-system kind="goal-reminder"','functionResponse.__meta','**world**','a.*']){
    await page.click('[data-chat-search] input[aria-label="Search messages"]');await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.keyboard.type(excluded)
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='0/0',{timeout:2500})
  }
  await page.keyboard.press('Escape')
  assert.equal(await page.$('[data-chat-search]'),null)
  assert.equal(await page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('foxwarm-chat-search-')).length),0)
})

test('manual scroll is retained through an unrelated stream update and search close',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  await page.type('[data-chat-search] input[aria-label="Search messages"]','OLD_ONLY_MATCH')
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='OLD_ONLY_MATCH'))
  await page.evaluate(()=>{const container=document.querySelector('.foxwarm-chat-messages');container.scrollTop=1800;container.dispatchEvent(new Event('scroll'));window.fixture.emitStream('UNCOMMITTED_STREAM_SEARCH_TOKEN')})
  await page.waitForFunction(()=>document.querySelector('.foxwarm-chat-timeline')?.textContent.includes('UNCOMMITTED_STREAM_SEARCH_TOKEN'))
  await new Promise(resolve=>setTimeout(resolve,80))
  assert.ok(Math.abs((await snapshot()).scrollTop-1800)<4,'passive stream update does not retarget the scroller')
  await query('UNCOMMITTED_STREAM_SEARCH_TOKEN')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='0/0')
  assert.ok(Math.abs((await snapshot()).scrollTop-1800)<4,'an excluded stream result does not retarget the scroller')
  await page.click('[aria-label="Close search"]')
  assert.ok((await snapshot()).distance>500,'closing Search keeps the detached viewport rather than rejoining the bottom')
})

test('disabling Group tools leaves call and result matches searchable in their own cards',async()=>{
  await page.evaluate(()=>window.fixture.setTimelineView('detailed'))
  await page.waitForFunction(()=>document.querySelectorAll('[data-tool-group]').length===0)
  await page.click('button[aria-label="Find in chat"]')
  await query('json-needle')
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='json-needle'))
  const state=await snapshot();assert.equal(state.visible,true);assert.equal(state.hits,'1/1')
  await page.click('[aria-label="Close search"]')
})

test('historical grouped Event and Goal reminder bodies remain searchable without opening unrelated groups',async()=>{
  await page.evaluate(()=>window.fixture.setTimelineView('grouped'))
  await page.waitForFunction(()=>document.querySelectorAll('[data-tool-group]').length===2)
  await page.click('button[aria-label="Find in chat"]')
  try {
    for (const term of ['GROUP_EVENT_TARGET','GROUP_GOAL_TARGET']) {
      await query(term)
      await page.waitForFunction(value=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/1',{timeout:2000},term)
      await page.waitForFunction(value=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()===value),{timeout:2500},term)
      const state=await snapshot()
      assert.equal(state.highlight,term)
      assert.equal(state.surface,'system')
      assert.equal(state.visible,true)
      assert.deepEqual(state.groups,['false','true'])
    }
  } finally { await page.click('[aria-label="Close search"]') }
})

test('user and pasted surfaces retain separate ordinals for the same visible word',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  try {
    await query('dupeWORD')
    await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='dupeWORD'),{timeout:2500})
    for (const [ordinal,surface] of ['user','user','pasted','pasted'].entries()) {
      await page.waitForFunction(value=>document.querySelector('[role="search"] [aria-live]')?.textContent===value,{timeout:2000},`${ordinal+1}/4`)
      const state=await snapshot()
      assert.equal(state.highlight,'dupeWORD',JSON.stringify(state))
      assert.equal(state.surface,surface,JSON.stringify(state))
      assert.equal(state.visible,true,JSON.stringify(state))
      if(ordinal<3) await page.click('[aria-label="Next match"]')
    }
  } finally { await page.click('[aria-label="Close search"]') }
})

test('quoted metadata-shaped text inside a pasted segment remains searchable',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  try {
    await query('OPAQUE_TAG_TARGET')
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/1',{timeout:2000})
    await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='OPAQUE_TAG_TARGET'),{timeout:2500})
    const state=await snapshot()
    assert.equal(state.highlight,'OPAQUE_TAG_TARGET',JSON.stringify(state))
    assert.equal(state.surface,'pasted')
    assert.equal(state.visible,true)
  } finally { await page.click('[aria-label="Close search"]') }
})

test('unified edit diff indexes a shared context line only once',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  try {
    await query('DIFF_SHARED_ONLY')
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent?.endsWith('/2')||document.querySelector('[role="search"] [aria-live]')?.textContent?.endsWith('/1'),{timeout:2000})
    assert.equal((await snapshot()).hits,'1/1','a common diff context line is rendered only once in unified mode')
    await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='DIFF_SHARED_ONLY'),{timeout:2500})
    const state=await snapshot()
    assert.equal(state.surface,'call')
    assert.equal(state.visible,true)
  } finally { await page.click('[aria-label="Close search"]') }
})

test('case-insensitive matching locates the original offset after a multi-unit lowercase character',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  try {
    await query('UNIQUEOFFSET')
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/1',{timeout:2000})
    await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='UNIQUEOFFSET'),{timeout:2500})
    const state=await snapshot()
    assert.equal(state.highlight,'UNIQUEOFFSET',JSON.stringify(state))
    assert.equal(state.visible,true,JSON.stringify(state))
  } finally { await page.click('[aria-label="Close search"]') }
})

test('excluded display-math controls do not take the ordinary Markdown hit',async()=>{
  await page.click('button[aria-label="Find in chat"]')
  try {
    await query('Z')
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/1',{timeout:2000})
    await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='Z'),{timeout:2500})
    const actual=await page.evaluate(()=>{
      const entry=[...CSS.highlights].find(([name])=>name.startsWith('foxwarm-chat-search-'))
      const range=entry?.[1].values().next().value
      return { text:range?.toString(), inSpecial:!!range?.endContainer.parentElement?.closest('[data-special-block]') }
    })
    assert.deepEqual(actual,{text:'Z',inSpecial:false})
  } finally { await page.click('[aria-label="Close search"]') }
})

test('Conversation Search navigates body and CTX summaries without revealing activity, and keeps the detached viewport', async () => {
  await page.evaluate(() => window.fixture.setTimelineView('conversation'))
  await page.waitForSelector('[data-timeline-activity]')
  await page.click('button[aria-label="Find in chat"]')
  for (const term of ['command-needle', 'CJK目标尾部', 'thought-needle', 'GROUP_EVENT_TARGET', 'LLM_RETRY_SEARCH_TARGET']) {
    await query(term)
    await page.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
    assert.equal(await page.$('[data-activity-details]'), null)
  }
  // Explicitly opening details does not turn them into this pane's Search corpus.
  await page.$eval('[aria-label="Expand activity"]', button => button.click())
  await page.waitForSelector('[data-activity-details]')
  await query('command-needle')
  assert.equal((await snapshot()).hits, '0/0')
  for (const term of ['visible-needle', 'CTX摘要末尾', 'OLD_ONLY_MATCH']) {
    await query(term)
    await page.waitForFunction(value => [...CSS.highlights].some(([name, hits]) => name.startsWith('foxwarm-chat-search-') && [...hits][0]?.toString() === value), { timeout: 3000 }, term)
    assert.equal((await snapshot()).visible, true)
    assert.equal((await snapshot()).hits, '1/1')
  }
  assert.equal((await snapshot()).archive, 0)
  await page.evaluate(() => { const container = document.querySelector('.foxwarm-chat-messages'); container.scrollTop = 1200; container.dispatchEvent(new Event('scroll')); window.fixture.emitStream('CONVERSATION_STREAM_UPDATE') })
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('CONVERSATION_STREAM_UPDATE'))
  assert.ok(Math.abs((await snapshot()).scrollTop - 1200) < 4)
  await page.click('[aria-label="Close search"]')
  assert.ok((await snapshot()).distance > 500)
})

test('Conversation preserves literal channel bodies and Search indices for complete system, legacy text, and split sources', async () => {
  await page.evaluate(() => window.fixture.showWrappers())
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('SPLIT_BODY'))
  const bodies = () => page.$$eval('[data-chat-timeline="committed"] [data-search-surface="user"]', nodes => nodes.map(node => node.textContent))
  assert.deepEqual(await bodies(), Object.values(wrapperBodies), 'outer envelope separators are removed without trimming authored whitespace')
  assert.ok(!(await page.$eval('[data-chat-timeline="committed"]', root => root.textContent)).includes('METADATA_ONLY'))
  await page.click('button[aria-label="Find in chat"]')
  for (const [term, seq, partIndex, hits] of [
    ['<foxwarm-message type="timer" />', 501, 1, '1/1'],
    ['<foxwarm-system kind="time" time="example" />', 501, 1, '1/1'],
    ['<foxwarm-system kind="event">', 501, 1, '1/2'],
    ['</foxwarm-system>', 501, 1, '1/2'],
    ['<foxwarm-system kind="time" time="legacy-example" />', 502, 0, '1/1'],
    ['SPLIT_CHANNEL_XML', 503, 1, '1/1'],
    ['<foxwarm-system kind="time" time="split-example" />', 503, 1, '1/1'],
  ]) {
    await query(term)
    await page.waitForFunction(value => [...CSS.highlights].some(([name, hits]) => name.startsWith('foxwarm-chat-search-') && [...hits][0]?.toString() === value), { timeout: 3000 }, term)
    assert.equal((await snapshot()).hits, hits)
    const target = await page.evaluate(() => {
      const range = [...CSS.highlights].find(([name]) => name.startsWith('foxwarm-chat-search-'))[1].values().next().value
      const node = range.startContainer.parentElement
      return { row: node.closest('[data-search-row]')?.dataset.searchRow, partIndex: node.closest('[data-search-part-index]')?.dataset.searchPartIndex }
    })
    assert.deepEqual(target, { row: `seq-local-${seq}`, partIndex: String(partIndex) })
  }
  await query('METADATA_ONLY')
  await page.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
  await page.click('[aria-label="Close search"]')
  await page.click('[aria-label="Open session options"]')
  await page.$eval('[data-session-ui-settings-menu]', menu => [...menu.querySelectorAll('button')].find(button => button.textContent.includes('Show user message metadata')).click())
  await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('METADATA_ONLY'))
  assert.deepEqual(await bodies(), Object.values(wrapperBodies), 'the metadata toggle does not change literal body content')
  await page.click('[aria-label="Open session options"]')
  await page.click('button[aria-label="Find in chat"]')
  await query('METADATA_ONLY')
  await page.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
  await query('</foxwarm-system>')
  await page.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/2')
  await page.waitForFunction(() => {
    const range = [...CSS.highlights].find(([name]) => name.startsWith('foxwarm-chat-search-'))?.[1].values().next().value
    const rect = range?.getBoundingClientRect()
    const viewport = document.querySelector('.foxwarm-chat-messages').getBoundingClientRect()
    return rect && rect.top >= viewport.top - 2 && rect.bottom <= viewport.bottom + 2
  })
  assert.equal((await snapshot()).visible, true)
  await page.click('[aria-label="Close search"]')
  assert.equal((await snapshot()).archive, 0)
})

const compactEpoch = 1700000000000
const compactMarker = '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="none" currentSessionId="fixture/main" />'
const compactPart = {system:compactMarker}
const compactGoal = {system:'<foxwarm-system kind="goal-reminder">\nKeep the requested outcome in mind.\n</foxwarm-system>'}
const compactMessage = paired => ({role:'user',parts:paired?[compactPart,compactGoal]:[compactPart],__meta:{seq:303,timestamp:compactEpoch+11000,...paired?{goalReminder:true,goalReminderKind:'compact-completion'}:{}}})
const compactReply = {role:'model',parts:[{text:'COMPACT_DONE'}],__meta:{seq:302,timestamp:compactEpoch+10000,llmRequestId:'compact-reply',llmSegment:{complete:true},llmRequestTiming:{startedAt:compactEpoch,completedAt:compactEpoch+10036,durationMs:10036}}}
const compactStart = {role:'user',parts:[{text:'COMPACT_REQUEST'}],__meta:{seq:301,timestamp:compactEpoch}}
let compactScenario = 0
const showCompact = async (records,second,runtime={state:'idle',busy:false,queueLength:0}) => {
  const text='COMPACT_SCENARIO_'+(++compactScenario)
  records=records.map(message=>message===compactReply?{...message,parts:[{text}]}:message)
  await page.evaluate(({records,now,runtime})=>window.fixture.showCompactTiming(records,now,runtime),{records,now:compactEpoch+second*1000,runtime})
  await page.waitForFunction(text=>document.querySelector('.foxwarm-chat-messages')?.textContent.includes(text),{},text)
  await page.waitForFunction(()=>document.querySelectorAll('[data-timeline-activity]').length===1)
}
const compactHeaders = () => page.$$eval('[data-timeline-activity] > button',buttons=>buttons.map(button=>button.textContent))
const continueVisible = () => page.$$eval('button',buttons=>buttons.some(button=>button.textContent.trim()==='Continue'))

test('Actual Chat leaves compact-only maintenance unclocked both at the completed tail and after a new user boundary',async()=>{
  for(const paired of [false,true]) {
    const records=[compactStart,compactReply,compactMessage(paired)]
    await showCompact(records,1811)
    assert.equal(await continueVisible(),false,'completion maintenance keeps the completed turn classification')
    assert.doesNotMatch((await compactHeaders()).join(' '),/Worked for|Waited for|Elapsed/)
    await page.click('[aria-label="Expand activity"]')
    await page.waitForFunction(()=>document.querySelector('[data-activity-details]')?.textContent.includes('compact-completed'))
    if(paired) assert.ok(await page.$eval('[data-activity-details]',node=>node.textContent.includes('Keep the requested outcome')))
    // The same history rendered later must not turn its maintenance event into a growing wait.
    await showCompact(records,2411)
    assert.doesNotMatch((await compactHeaders()).join(' '),/Worked for|Waited for|Elapsed/)
    const next={role:'user',parts:[{text:'COMPACT_NEXT_USER'}],__meta:{seq:304,timestamp:compactEpoch+1920000,clientMessageId:'compact-next'}}
    await showCompact([...records,next],1920)
    assert.equal(await continueVisible(),true,'the new user request remains continuable')
    assert.doesNotMatch((await compactHeaders()).join(' '),/Worked for|Waited for|Elapsed/,'closing the historical maintenance range cannot borrow the prior request\'s final 36ms or its idle gap')
  }
})

test('Actual Chat retains real idle coordination timing through maintenance and does not ignore mixed or authored content',async()=>{
  const incoming={role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/worker">\nREAL_COORDINATION\n</foxwarm-message>'}],__meta:{seq:305,timestamp:compactEpoch+15000}}
  const request={startedAt:compactEpoch+15000,completedAt:compactEpoch+17000,durationMs:2000}
  const reasoning={role:'model',parts:[{thinking:'REAL_REASONING'}],__meta:{seq:306,timestamp:compactEpoch+16000,llmRequestId:'coordination',llmSegment:{complete:false}}}
  const completed={role:'model',parts:[],__meta:{seq:307,timestamp:compactEpoch+17000,llmRequestId:'coordination',llmRequestTiming:request,llmSegment:{complete:true}}}
  const maintenance={...compactMessage(true),__meta:{...compactMessage(true).__meta,seq:308,timestamp:compactEpoch+18000}}
  await showCompact([compactStart,compactReply,incoming,reasoning,completed,maintenance],30)
  await page.waitForFunction(()=>document.querySelector('[data-timeline-activity] > button')?.textContent.includes('Waited for 17s'))
  assert.match((await compactHeaders()).join(' '),/Worked for 2s.*Waited for 17s.*Received 1 message/)
  assert.equal(await continueVisible(),false,'Continue=false does not mean that real coordination cannot wait')
  const mixed={...maintenance,parts:[...maintenance.parts,...incoming.parts],__meta:{...maintenance.__meta,seq:309,timestamp:compactEpoch+18000}}
  await showCompact([compactStart,compactReply,mixed],30,{state:'requesting-model',busy:true,since:compactEpoch+18000,queueLength:0})
  await page.waitForFunction(()=>document.querySelector('[data-timeline-activity] > button')?.textContent.includes('Worked for'))
  assert.match((await compactHeaders()).join(' '),/Worked for.*Received 1 message/,'a completion/reminder row with extra real content is not maintenance-only')
  const quote={role:'user',parts:[{text:compactMarker}],__meta:{seq:310,timestamp:compactEpoch+20000,clientMessageId:'authored-compact-quote'}}
  await showCompact([compactStart,compactReply,maintenance,quote],30)
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-search-surface="user"]')].some(node=>node.textContent.includes('compact-completed')))
  assert.equal(await page.$$eval('[data-search-surface="user"]',nodes=>nodes.filter(node=>node.textContent.includes('compact-completed')).length),1,'authored text stays a visible body, not maintenance details')
})


test('Actual Chat keeps a runtime-confirmed parallel tool batch Worked while receipts are pending, then uses measured results',async()=>{
  const base=compactEpoch
  const user={role:'user',parts:[{text:'LIVE_TOOL_REQUEST'}],__meta:{seq:401,timestamp:base}}
  const model={role:'model',parts:['live-a','live-b'].map(id=>({functionCall:{id,name:'exec',args:{command:'echo '+id}}})),__meta:{seq:402,timestamp:base+10000,llmRequestId:'live-request',llmRequestTiming:{startedAt:base,completedAt:base+10000,durationMs:10000}}}
  const running={state:'running-tool',busy:true,since:base+10030,tool:{id:'live-b',name:'exec',index:1,total:2,startedAt:base+10030},queueLength:0}
  let serial=0
  const show=async(records,runtime=running,now=base+20030,busyStartedAt=null)=>{
    const text='LIVE_TOOL_REQUEST_'+(++serial)
    records=[{...user,parts:[{text}]},...records.slice(1)]
    await page.evaluate(({records,runtime,now,busyStartedAt})=>window.fixture.showCompactTiming(records,now,runtime,busyStartedAt),{records,runtime,now,busyStartedAt})
    await page.waitForFunction(text=>[...document.querySelectorAll('[data-search-surface="user"]')].some(node=>node.textContent.includes(text)),{},text)
    await page.waitForFunction(()=>document.querySelectorAll('[data-timeline-activity]').length===1)
    return records
  }
  let records=await show([user,model])
  assert.match((await compactHeaders()).join(' '),/Worked for 20s.*Called 2 tools/)
  assert.doesNotMatch((await compactHeaders()).join(' '),/Elapsed|Waited/)
  await page.click('[aria-label="Expand activity"]')
  const receipt={role:'tool',parts:[['live-a',10020,10120],['live-b',10030,20030]].map(([id,start,end])=>({functionResponse:{name:'exec',tool_use_id:id,response:{output:'LIVE_BATCH_RESULT_'+id},executionTiming:{startedAt:base+start,completedAt:base+end,durationMs:end-start}}})),__meta:{seq:403,timestamp:base+20030}}
  records=[...records,receipt]
  await page.evaluate(({records,now})=>window.fixture.updateCompactTiming(records,now,{state:'requesting-model',busy:true,since:now,queueLength:0}),{records,now:base+20040})
  await page.waitForFunction(()=>document.querySelector('[data-activity-details]')?.textContent.includes('LIVE_BATCH_RESULT_live-b'))
  assert.match((await compactHeaders()).join(' '),/Worked for 20s.*Called 2 tools/)
  assert.doesNotMatch((await compactHeaders()).join(' '),/Elapsed|Waited/)
  const final={role:'model',parts:[{text:'LIVE_TOOL_DONE'}],__meta:{seq:404,timestamp:base+21000,llmRequestId:'live-final',llmRequestTiming:{startedAt:base+20040,completedAt:base+21000,durationMs:960}}}
  records=[...records,final]
  await page.evaluate(({records,now})=>window.fixture.updateCompactTiming(records,now,{state:'idle',busy:false,queueLength:0}),{records,now:base+21000})
  await page.waitForFunction(()=>document.querySelector('.foxwarm-chat-messages').textContent.includes('LIVE_TOOL_DONE'))
  assert.match((await compactHeaders()).join(' '),/Worked for 20s.*Called 2 tools/)
  assert.doesNotMatch((await compactHeaders()).join(' '),/Elapsed|Waited/)
  // The real session busy start is also transported by Chat; no extra phase-gap fix is needed for this case.
  await show([user,model],{...running,since:base+15000,tool:{...running.tool,startedAt:base+15000}},base+20030,base)
  assert.match((await compactHeaders()).join(' '),/Worked for 20s/)
  // A busy flag or unrelated runtime identity cannot rescue unknown older work.
  const laterModel={...model,__meta:{...model.__meta,timestamp:base+40000,llmRequestTiming:{startedAt:base+30000,completedAt:base+40000,durationMs:10000}}}
  const laterRuntime={...running,since:base+40030,tool:{...running.tool,startedAt:base+40030}}
  const unknownRequest={role:'model',parts:[{thinking:'UNKNOWN_OLDER_REQUEST'}],__meta:{timestamp:base+10000,llmRequestId:'older-unknown'}}
  const oldCall={role:'model',parts:[{functionCall:{id:'old-tool',name:'exec',args:{command:'echo old'}}}],__meta:{timestamp:base+10000,llmRequestTiming:{startedAt:base,completedAt:base+10000,durationMs:10000}}}
  const oldReceipt={role:'tool',parts:[{functionResponse:{name:'exec',tool_use_id:'old-tool',response:{output:'Legacy receipt without execution timing'}}}],__meta:{timestamp:base+20000}}
  const retry={role:'model',parts:[{text:'⚠️ LLM Error: Older failed request'}],__meta:{timestamp:base+10000,noticeType:'llm-retry'}}
  for(const past of [[unknownRequest],[oldCall,oldReceipt],[retry]]) {
    const history=[user,...past,laterModel].map((message,index)=>({...message,__meta:{...message.__meta,seq:501+index}}))
    await show(history,laterRuntime,base+50030)
    assert.match((await compactHeaders()).join(' '),/Elapsed/)
  }
  await show([user,model],{...running,tool:{...running.tool,id:'unrelated-tool'}})
  assert.match((await compactHeaders()).join(' '),/Elapsed/)
  // If a prior batch slice is genuinely unmeasured, do not label its larger gap as waiting.
  await show([user,model],{...running,since:base+20000,tool:{...running.tool,startedAt:base+20000}},base+30000)
  assert.match((await compactHeaders()).join(' '),/Elapsed/)
})

test('a boundary-free new Session times real Task work, not its creation, through live and committed output', async () => {
  const base = 1700000000000
  const request = (startedAt, completedAt) => ({ startedAt: base + startedAt, completedAt: base + completedAt, durationMs: completedAt - startedAt })
  const records = [
    { role: 'user', parts: [{ system: '<foxwarm-system kind="session-boundary" event="new-child" />' }], __meta: { seq: 1, timestamp: base - 1800000 } },
    { role: 'user', parts: [{ system: '<foxwarm-message type="task" event="assigned">\nLEADING_TASK_PUBLIC\n</foxwarm-message>' }], __meta: { seq: 2, timestamp: base } },
    { role: 'model', parts: [{ thinking: 'LEADING_REASONING_PUBLIC' }, { functionCall: { id: 'leading-exec', name: 'exec', args: { command: 'printf example' } } }], __meta: { seq: 3, timestamp: base + 10100, llmRequestId: 'leading-first', llmRequestTiming: request(100, 10100) } },
    { role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: 'leading-exec', response: { output: 'EXAMPLE_RESULT' }, executionTiming: request(10100, 20100) } }], __meta: { seq: 4, timestamp: base + 20100 } },
  ]
  const runtime = { state: 'requesting-model', since: base + 20100, busy: true, queueLength: 0 }
  await page.evaluate((records, now, runtime, start) => window.fixture.showCompactTiming(records, now, runtime, start), records, base + 30100, runtime, base + 100)
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.includes('Worked for 30s'))
  await page.click('[data-timeline-activity] button')
  await page.waitForFunction(() => document.querySelector('[data-activity-details]')?.textContent.includes('LEADING_TASK_PUBLIC'))
  await page.click('[data-timeline-activity] button')
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.includes('Worked for 30s'))
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Received 1 message · Called 1 tool/)
  assert.deepEqual(await page.$$eval('[data-timeline-time-separator] time', nodes => nodes.map(node => node.dateTime)), [new Date(base).toISOString()])
  await page.evaluate(now => { window.fixture.now = now }, base + 35100)
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.includes('Worked for 35s'))
  const finished = [...records, { role: 'model', parts: [{ text: 'LEADING_FINAL_PUBLIC' }], __meta: { seq: 5, timestamp: base + 40120, llmRequestId: 'leading-final', llmRequestTiming: request(20100, 40100) } }]
  await page.evaluate((records, now) => window.fixture.updateCompactTiming(records, now, { state: 'idle', busy: false, queueLength: 0 }), finished, base + 90120)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-search-surface="model"]')].some(node => node.textContent.includes('LEADING_FINAL_PUBLIC')))
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Worked for 40s/)
  assert.doesNotMatch(await page.$eval('[data-timeline-activity]', node => node.textContent), /Waited|Elapsed/)
  assert.deepEqual(await page.$$eval('[data-timeline-time-separator] time', nodes => nodes.map(node => node.dateTime)), [new Date(base).toISOString()])
})

test('requesting-model counts first-response work before any provider part, without inventing queued or idle work', async () => {
  const base = 1700000000000
  const user = { role: 'user', parts: [{ text: 'FIRST_RESPONSE_PUBLIC' }], __meta: { seq: 1, timestamp: base, clientMessageId: 'first-response-public' } }
  const runtime = { state: 'requesting-model', since: base + 60000, busy: true, queueLength: 0 }
  await page.evaluate((records, now, runtime, start) => window.fixture.showCompactTiming(records, now, runtime, start), [user], base + 70000, runtime, base + 60000)
  await page.waitForFunction(() => document.querySelector('[data-search-surface="user"]')?.textContent === 'FIRST_RESPONSE_PUBLIC')
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.includes('Worked for 10s'))
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Waited for 1m/)
  assert.equal(await page.$('[data-timeline-activity] button'), null)
  assert.deepEqual(await page.$$eval('[data-timeline-time-separator] time', nodes => nodes.map(node => node.dateTime)), [base, base + 60000].map(date => new Date(date).toISOString()))
  const anchorCount = await page.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length)
  await page.evaluate(() => { window.fixture.retainedFirstResponseUser = document.querySelector('[data-search-surface="user"]') })
  await page.evaluate(now => { window.fixture.now = now }, base + 75000)
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.includes('Worked for 15s'))
  assert.equal(await page.evaluate(() => window.fixture.retainedFirstResponseUser === document.querySelector('[data-search-surface="user"]')), true)
  assert.equal(await page.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length), anchorCount)
  const thinking = { role: 'model', parts: [{ thinking: 'FIRST_RESPONSE_REASONING_PUBLIC' }], __meta: { seq: 2, timestamp: base + 75000, llmRequestId: 'first-response-public', llmSegment: { outputStart: 0, outputEnd: 1, complete: false } } }
  await page.evaluate((records, now, runtime, start) => window.fixture.updateCompactTiming(records, now, runtime, start), [user, thinking], base + 75000, runtime, base + 60000)
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity] button'))
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Worked for 15s/)
  const final = { role: 'model', parts: [{ text: 'FIRST_RESPONSE_FINAL_PUBLIC' }], __meta: { seq: 3, timestamp: base + 80000, llmRequestId: 'first-response-public', llmSegment: { outputStart: 1, outputEnd: 2, complete: true }, llmRequestTiming: { startedAt: base + 60000, completedAt: base + 80000, durationMs: 20000 } } }
  await page.evaluate((records, now) => window.fixture.updateCompactTiming(records, now, { state: 'idle', busy: false, queueLength: 0 }), [user, thinking, final], base + 100000)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-search-surface="model"]')].some(node => node.textContent.includes('FIRST_RESPONSE_FINAL_PUBLIC')))
  assert.equal(await page.$$eval('[data-timeline-activity]', nodes => nodes.length), 1)
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Worked for 20s · Waited for 1m/)
  for (const state of [
    { state: 'idle', busy: false, queueLength: 1 },
    { state: 'waiting', since: base + 60000, busy: false, queueLength: 1, waiting: { waitId: 'public-wait', waitingFor: 'input', waitForInput: true } },
    { state: 'requesting-model', busy: true, queueLength: 0 },
  ]) {
    await page.evaluate((state, now) => window.fixture.showCompactTiming([{ role: 'user', parts: [{ text: 'NO_SPECULATIVE_WORK_PUBLIC_' + state.state + '_' + !!state.since }], __meta: { seq: 1, timestamp: 1700000000000, clientMessageId: 'no-speculative-work' } }], now, state), state, base + 90000)
    await page.waitForFunction(text => document.querySelector('[data-search-surface="user"]')?.textContent === text, {}, 'NO_SPECULATIVE_WORK_PUBLIC_' + state.state + '_' + !!state.since)
    assert.equal(await page.$$eval('[data-timeline-activity]', nodes => nodes.length), 0)
  }
})

test('a leading execution origin is usable without an input, but unknown earlier work and CTX cuts stay conservative', async () => {
  const base = 1700000000000
  const model = { role: 'model', parts: [{ thinking: 'EXECUTION_ORIGIN_PUBLIC' }], __meta: { seq: 2, timestamp: base + 10000, llmRequestId: 'execution-origin', llmRequestTiming: { startedAt: base, completedAt: base + 10000, durationMs: 10000 } } }
  const creation = { role: 'user', parts: [{ system: '<foxwarm-system kind="session-boundary" event="new-child" />' }], __meta: { seq: 1, timestamp: base - 1800000 } }
  const requesting = { state: 'requesting-model', since: base + 10000, busy: true, queueLength: 0 }
  await page.evaluate((records, now, runtime, start) => window.fixture.showCompactTiming(records, now, runtime, start), [creation, model], base + 20000, requesting, base)
  await page.waitForFunction(date => document.querySelector('[data-timeline-time-separator] time')?.dateTime === date, {}, new Date(base).toISOString())
  assert.match(await page.$eval('[data-timeline-activity]', node => node.textContent), /Worked for 20s/)
  const unknown = { ...model, __meta: { seq: 2, timestamp: base + 5000, llmRequestId: 'unknown-origin' } }
  await page.evaluate((records, now, runtime) => window.fixture.showCompactTiming(records, now, runtime), [creation, unknown], base + 20000, requesting)
  await page.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.textContent.trim() === '›Activity')
  assert.equal(await page.$$eval('[data-timeline-time-separator]', nodes => nodes.length), 0)
  const old = { ...model, __meta: { seq: 1, timestamp: base - 190000, llmRequestId: 'cross-context', llmRequestTiming: { startedAt: base - 400000, completedAt: base - 190000, durationMs: 210000 } } }
  const block = { role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#5501 raw#1-#1] CONTEXT_PUBLIC' }], __meta: { seq: 2, timestamp: base + 10000, contextBlock: { id: 5501, level: 1, rawStartSeq: 1, rawEndSeq: 1, sourceKind: 'message', rawStartTimestamp: base - 190000 } } }
  const suffix = { role: 'model', parts: [{ thinking: 'AFTER_CONTEXT_UNKNOWN_PUBLIC' }], __meta: { seq: 3, timestamp: base + 20000, llmRequestId: 'cross-context', llmSegment: { outputStart: 1, outputEnd: 2, complete: false } } }
  const final = { role: 'model', parts: [{ text: 'AFTER_CONTEXT_FINAL_PUBLIC' }], __meta: { seq: 4, timestamp: base + 40000, llmRequestId: 'after-context-final', llmRequestTiming: { startedAt: base + 30000, completedAt: base + 40000, durationMs: 10000 } } }
  await page.evaluate((records, now) => window.fixture.showCompactTiming(records, now, { state: 'idle', busy: false, queueLength: 0 }), [old, block, suffix, final], base + 50000)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-search-surface="model"]')].some(node => node.textContent.includes('AFTER_CONTEXT_FINAL_PUBLIC')))
  assert.match(await page.$$eval('[data-timeline-activity]', nodes => nodes.at(-1).textContent), /Elapsed 30s/)
  assert.doesNotMatch(await page.$$eval('[data-timeline-activity]', nodes => nodes.at(-1).textContent), /Worked|Waited/)
  assert.deepEqual(await page.$$eval('[data-timeline-time-separator] time', nodes => nodes.map(node => node.dateTime)), [new Date(base - 400000).toISOString()])
})
