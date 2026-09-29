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

before(async () => {
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'build the WebUI before browser tests')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from ${JSON.stringify(chatEntry)}
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
      {role:'model',parts:[{thinking:'Reasoning **thought-needle** here'},{text:'Final hello **world** &amp; safe content'},{text:'Text plus image keeps visible-needle',inlineData:{mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}}],__meta:{seq:115,timestamp:1700000000115}},
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
    ]
    window.fixture = { archiveRequests:0, get history(){return history}, emitStream(text){this.socket?.onmessage?.({data:JSON.stringify({type:'session-event',sessionId:'fixture/main',event:{type:'model-stream-update',streamId:'fixture-search-stream',text}})})} }
    window.fetch = async input => {
      const url = String(input)
      if (url.includes('/context-blocks/')) {window.fixture.archiveRequests++;return new Response('{}',{status:404})}
      if (url.includes('/history')) return new Response(JSON.stringify({session:{id:'fixture/main',busy:false,runtimeState:{state:'idle'},queueLength:0,messageCount:history.length,historyVersion:0,modelKey:'fixture/model'},messages:history,queuedMessages:[],queueLength:0,latestSeq:128,historyVersion:0,prefixLength:0,historyComplete:true}),{status:200,headers:{'Content-Type':'application/json'}})
      if (url.includes('/models')) return new Response(JSON.stringify({models:[{key:'fixture/model',contextLimit:128000}]}),{status:200})
      if (url.includes('/asr/status')) return new Response(JSON.stringify({configured:false,available:false}),{status:200})
      if (url.includes('/commands')) return new Response(JSON.stringify({commands:[]}),{status:200})
      return new Response('{}',{status:404})
    }
    class Socket { static CONNECTING=0; static OPEN=1;static CLOSED=3;
      constructor(){this.readyState=0;window.fixture.socket=this;queueMicrotask(()=>{this.readyState=1;this.onopen?.({})})}
      close(){this.readyState=3}
      send(raw){const data=JSON.parse(raw);if(data.type==='set-subscriptions') queueMicrotask(()=>{this.onmessage?.({data:JSON.stringify({type:'subscriptions-accepted',revision:data.revision,sessionListResolutions:{},sessionResolutions:Object.fromEntries(data.sessionIds.map(id=>[id,id]))})});this.onmessage?.({data:JSON.stringify({type:'subscriptions-applied',revision:data.revision})})})}
    }
    window.WebSocket=Socket
    function Fixture(){const [groupTools,setGroupTools]=React.useState(true);window.fixture.setGroupTools=setGroupTools;return React.createElement(Chat,{sessionId:'fixture/main',groupTools,showUsageBadge:false})}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const bundle = await build({ stdin: {contents:fixture,resolveDir:new URL('..',import.meta.url).pathname,sourcefile:'chat-search-fixture.tsx'}, bundle:true,format:'iife',platform:'browser',target:'chrome120',write:false,define:{'process.env.NODE_ENV':JSON.stringify('test')},logLevel:'silent' })
  server = createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser = await puppeteer.launch({browser:firefox?'firefox':'chrome',executablePath:firefox?(process.env.FOXWARM_E2E_FIREFOX||'/usr/bin/firefox'):(process.env.FOXWARM_E2E_CHROMIUM||'/usr/bin/chromium'),headless:true,args:firefox?[]:['--no-sandbox','--disable-setuid-sandbox']})
  page=await browser.newPage();if(!firefox) await page.setViewport({width:1100,height:760});await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});await page.waitForSelector('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
  assert.equal(await page.$eval('[data-chat-search] input', input=>input.placeholder),'Search messages')
  await page.waitForSelector('[aria-label="Search messages"]')
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

test('finds already-loaded older unmounted rows, read results, reasoning, rendered Markdown and CTX summary without Archive',async()=>{
  await page.click('[aria-label="Search messages"]')
  for(const [needle, expected] of [['OLD_ONLY_MATCH','OLD_ONLY_MATCH'],['PASTED_DEEP_SEARCH','PASTED_DEEP_SEARCH'],['command-needle','command-needle'],['read-file-needle','read-file-needle'],['fallback-needle','fallback-needle'],['json-needle','json-needle'],['thought-needle','thought-needle'],['hello world','hello world'],['visible-needle','visible-needle'],['<safe>','<safe>'],['CTX摘要末尾','CTX摘要末尾'],['SYSTEM_BODY_HIDDEN_TARGET','SYSTEM_BODY_HIDDEN_TARGET']]){
    await page.click('[data-chat-search] input[aria-label="Search messages"]');await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.keyboard.type(needle)
    await page.waitForFunction(value=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()===value),{timeout:4000},expected)
    const state=await snapshot();assert.equal(state.visible,true,`${needle} ${JSON.stringify(state)}`);assert.equal(state.hits,'1/1',needle)
  }
  const state=await snapshot();assert.equal(state.oldMounted,true);assert.equal(state.archive,0)
  assert.equal(await page.$eval('.foxwarm-context-block-card [aria-label="Expand CTX-BLOCK B#7"]',el=>el.getAttribute('aria-expanded')),'false')
  await page.click('[aria-label="Close search"]')
})

test('literal matching and local keyboard navigation keep the match counter in sync',async()=>{
  await page.click('[aria-label="Search messages"]')
  await page.type('[data-chat-search] input[aria-label="Search messages"]','earlier ordinary message')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/105',{timeout:5000})
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString().toLowerCase()==='earlier ordinary message'),{timeout:5000})
  await page.keyboard.press('Enter')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='2/105',{timeout:5000})
  await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift')
  await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='1/105',{timeout:5000})
  for(const excluded of ['iVBORw0KGgoAAAANSUhEUg','attachment1_attachment-marker-only','attachment-ref ref=','foxwarm-system kind="goal-reminder"','functionResponse.__meta','**world**','a.*']){
    await page.click('[data-chat-search] input[aria-label="Search messages"]');await page.keyboard.down('Control');await page.keyboard.press('A');await page.keyboard.up('Control');await page.keyboard.type(excluded)
    await page.waitForFunction(()=>document.querySelector('[role="search"] [aria-live]')?.textContent==='0/0',{timeout:2500})
  }
  await page.keyboard.press('Escape')
  assert.equal(await page.$('[data-chat-search]'),null)
  assert.equal(await page.evaluate(()=>[...CSS.highlights].filter(([name])=>name.startsWith('foxwarm-chat-search-')).length),0)
})

test('manual scroll is retained through an unrelated stream update and search close',async()=>{
  await page.click('[aria-label="Search messages"]')
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
  await page.evaluate(()=>window.fixture.setGroupTools(false))
  await page.waitForFunction(()=>document.querySelectorAll('[data-tool-group]').length===0)
  await page.click('[aria-label="Search messages"]')
  await query('json-needle')
  await page.waitForFunction(()=>[...CSS.highlights].some(([name,h])=>name.startsWith('foxwarm-chat-search-')&&[...h][0]?.toString()==='json-needle'))
  const state=await snapshot();assert.equal(state.visible,true);assert.equal(state.hits,'1/1')
  await page.click('[aria-label="Close search"]')
})

test('historical grouped Event and Goal reminder bodies remain searchable without opening unrelated groups',async()=>{
  await page.evaluate(()=>window.fixture.setGroupTools(true))
  await page.waitForFunction(()=>document.querySelectorAll('[data-tool-group]').length===2)
  await page.click('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
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
  await page.click('[aria-label="Search messages"]')
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
