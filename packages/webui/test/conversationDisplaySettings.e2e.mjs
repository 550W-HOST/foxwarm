import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const webui = new URL('..', import.meta.url).pathname
let browser, page, server, url
const longBody = 'Long delivery\n\n' + Array.from({ length: 35 }, (_, n) => `Delivery paragraph ${n}: retain the original body and readable context.`).join('\n\n') + '\n\nDELIVERY_TAIL'
const call = (id, name, args) => ({ role: 'model', parts: [{ functionCall: { id, name, args } }] })
const result = (id, name, response, meta) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name, response, __meta: meta } }] })
const incoming = body => ({ role: 'user', parts: [{ system: `<foxwarm-message type="inter-agent" sourceSessionId="fixture/peer">\n${body}\n</foxwarm-message>` }] })
const records = [
  { role: 'user', parts: [{ text: 'Inspect the display preferences.' }] },
  { role: 'model', parts: [{ text: 'EXPLICIT_COMMENTARY', phase: 'commentary' }, { text: 'UNMARKED_PROSE' }, { text: 'FINAL_PROSE', phase: 'final_answer' }] },
  call('send', 'send_to_session', { sessionId: 'fixture/peer', message: 'SENT_BODY with [ordinary link](https://example.com/)' }),
  result('send', 'send_to_session', { output: 'DELIVERY_ACK' }),
  incoming('RECEIVED_BODY'),
  call('script', 'run_script', { code: 'send_using_supported_metadata()' }),
  result('script', 'run_script', { output: 'SCRIPT_ACK_WITHOUT_BODY' }, { toolScriptSubCalls: [{ id: 'sub', status: 'completed', sessionMessage: { targetSessionId: 'fixture/peer', message: 'SCRIPT_METADATA_BODY' } }] }),
  call('canceled', 'send_to_session', { sessionId: 'fixture/peer', message: 'CANCELED_BODY' }),
  result('canceled', 'send_to_session', { canceled: true }),
  call('failed', 'send_to_session', { sessionId: 'fixture/peer', message: 'FAILED_BODY' }),
  result('failed', 'send_to_session', { error: 'Not delivered' }),
  call('missing', 'send_to_session', { sessionId: 'fixture/peer', message: 'MISSING_BODY' }),
  { role: 'model', parts: [{ text: 'END_PROSE', phase: 'final_answer' }] },
].map((message, index) => ({ ...message, __meta: { seq: index + 1, timestamp: 1700000000000 + index * 1000 } }))

before(async () => {
  const cssName = (await readdir(new URL('../dist/assets/', import.meta.url))).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(`../dist/assets/${cssName}`, import.meta.url), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import Chat from './src/components/Chat'
    import { useChatPreferences } from './src/chatPreferences'
    import { buildTimelineRows } from './src/components/timelineRows'
    import { initializeThemeRuntime, setThemeSelection, DEFAULT_THEME } from './src/theme'
    initializeThemeRuntime()
    setThemeSelection({themeId:DEFAULT_THEME.id,colorMode:'light'})
    const original = ${JSON.stringify(records)}
    const longBody = ${JSON.stringify(longBody)}
    let messages = original
    const sessionId = 'fixture/display'
    window.fixture = { requests: [], navigations: [], original, longBody }
    document.addEventListener('click', event => {const link=event.target.closest?.('a.foxwarm-session-hash-link');if(link){event.preventDefault();window.fixture.navigations.push(decodeURIComponent(link.hash.slice(9)))}})
    window.fixture.rows = (messages, options = {}) => buildTimelineRows({messages,historyMessages:messages,currentHistoryMessages:messages,isMobile:false,timelineView:'conversation',showUsageBadge:true,showTimeDividers:true,nestedDepth:0,expandedGroupKeys:new Set(),...options}).rows
    window.fetch = async input => {
      const url = String(input)
      window.fixture.requests.push(url)
      const data = url.includes('/history') ? {session:{id:sessionId,busy:false,runtimeState:{state:'idle',busy:false,since:1700000030000},queueLength:0,messageCount:messages.length,historyVersion:0},messages,queuedMessages:[],queueLength:0,latestSeq:messages.at(-1)?.__meta.seq,historyVersion:0,prefixLength:0,historyComplete:true}
        : url.includes('/models') ? { models: [] } : url.includes('/asr/status') ? { configured: false, available: false } : url.includes('/commands') ? { commands: [] } : {}
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})
    }
    class Socket {
      static CLOSED=3
      constructor(){this.readyState=0;window.fixture.socket=this;queueMicrotask(()=>{this.readyState=1;this.onopen?.({});this.emit({type:'connected'})})}
      close(){this.readyState=3}
      send(raw){const payload=JSON.parse(raw);if(payload.type==='set-subscriptions')queueMicrotask(()=>{this.emit({type:'subscriptions-accepted',revision:payload.revision,sessionListResolutions:{},sessionResolutions:{[sessionId]:sessionId}});this.emit({type:'subscriptions-applied',revision:payload.revision})})}
      emit(payload){this.onmessage?.({data:JSON.stringify(payload)})}
    }
    window.WebSocket=Socket
    window.fixture.emit = event => window.fixture.socket.emit({type:'session-event',sessionId,event})
    window.fixture.replace = next => {
      messages = next
      window.fixture.emit({type:'model-stream-reset'})
      window.fixture.socket.emit({type:'session-state',sessionId,session:{id:sessionId,busy:false,runtimeState:{state:'idle',busy:false,since:1700000030000},queueLength:0,messageCount:messages.length,historyVersion:++window.fixture.version}})
    }
    window.fixture.version=0
    function Fixture(){
      const prefs=useChatPreferences()
      window.fixture.prefs=prefs
      return <Chat sessionId={sessionId} canonicalSessionId={sessionId} sessionDisplayName="Display preferences" {...prefs}
        onSendKeyModeChange={prefs.setSendKeyMode} onTimelineViewChange={prefs.setTimelineView} onFullWidthChange={prefs.setFullWidth}
        onShowUsageBadgeChange={prefs.setShowUsageBadge} onShowUserMessageMetadataChange={prefs.setShowUserMessageMetadata}
        onShowInterAgentMessagesChange={prefs.setShowInterAgentMessages} onShowCommentaryChange={prefs.setShowCommentary} />
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: webui, sourcefile: 'conversation-display-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 850 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('[aria-label="Open session options"]')
})
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })
const menu = '[data-session-ui-settings-menu]'
const standalone = '[data-session-communication]:not([data-activity-details] [data-session-communication])'
const openMenu = async () => { if (!await page.$(menu)) await page.click('[aria-label="Open session options"]'); await page.waitForSelector(menu) }
const choose = async label => {
  await openMenu()
  await page.$eval(menu, (root, label) => {
    const target = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === label)
    if (!target) throw new Error('Missing setting: ' + label)
    target.click()
  }, label)
}
const closeMenu = async () => { if (await page.$(menu)) await page.keyboard.press('Escape') }
const text = () => page.$eval('.foxwarm-chat-messages', node => node.textContent)
const screenshot = async name => {
  if (!process.env.FOXWARM_E2E_SCREENSHOT_DIR) return
  await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, name + '.png') })
}
const search = async term => {
  if (!await page.$('[data-chat-search]')) {
    if (await page.$('[aria-label="Find in chat"]')) await page.click('[aria-label="Find in chat"]')
    else await choose('Find in chat')
  }
  const input = '[data-chat-search] input[aria-label="Search messages"]'
  await page.click(input, { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type(input, term)
}
const hits = expected => page.waitForFunction(expected => document.querySelector('[role="search"] [aria-live]')?.textContent === expected, {}, expected)
const closeSearch = async () => { if (await page.$('[data-chat-search]')) await page.click('[aria-label="Close search"]') }
const expandActivities = async () => {
  await page.$$eval('[aria-label="Expand activity"]', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => !document.querySelector('[aria-label="Expand activity"]'))
}

test('actual Chat menu exposes default-on Conversation switches immediately before Full width', async () => {
  await choose('Conversation')
  await page.waitForSelector(standalone)
  await openMenu()
  const switches = await page.$$eval(`${menu} [role="switch"]`, buttons => buttons.map(button => ({label:button.textContent.trim(),checked:button.getAttribute('aria-checked')})))
  assert.deepEqual(switches.slice(0, 3), [{label:'Show inter-agent messages',checked:'true'},{label:'Show commentary',checked:'true'},{label:'Full width',checked:'true'}])
  assert.equal(await page.$$eval(standalone, cards => cards.length), 3)
  assert.ok((await text()).includes('EXPLICIT_COMMENTARY'))
  await screenshot('desktop-menu-default')
  await closeMenu()
  const linkDialog = new Promise(resolve => page.once('dialog', async dialog => {const message=dialog.message();await dialog.dismiss();resolve(message)}))
  await page.$eval('a[href="https://example.com/"]',link=>link.click())
  assert.match(await linkDialog, /https:\/\/example\.com\//)
  await choose('Show commentary')
  await page.waitForFunction(() => !document.querySelector('.foxwarm-chat-messages').textContent.includes('EXPLICIT_COMMENTARY'))
  assert.equal(await page.$$eval(standalone, cards => cards.length), 3, 'independent switch does not hide communications')
  assert.ok((await text()).includes('UNMARKED_PROSE'))
  assert.ok((await text()).includes('FINAL_PROSE'))
  await choose('Show inter-agent messages')
  await closeMenu()
  await page.waitForFunction(() => !document.querySelector('[data-session-communication]'))
  await search('SCRIPT_METADATA_BODY'); await hits('0/0')
  await search('EXPLICIT_COMMENTARY'); await hits('0/0')
  await closeSearch()
  await expandActivities()
  const body = await text()
  for (const value of ['EXPLICIT_COMMENTARY','SENT_BODY','RECEIVED_BODY','SCRIPT_METADATA_BODY']) assert.ok(body.includes(value), value)
  assert.equal(await page.$$eval('[data-activity-details] [data-session-communication]', cards => cards.length), 3)
  assert.equal(await page.$$eval(standalone, cards => cards.length), 0)
  assert.equal(await page.$$eval('[data-session-communication]', cards => cards.filter(card => /CANCELED_BODY|FAILED_BODY|MISSING_BODY/.test(card.textContent)).length), 0)
  await page.$$eval('[aria-label="Expand send_to_session tool"], [aria-label="Expand run_script tool"]', buttons => buttons.forEach(button => button.click()))
  assert.ok((await text()).includes('DELIVERY_ACK'), 'native technical receipt is retained')
  assert.ok((await text()).includes('SCRIPT_ACK_WITHOUT_BODY'))
  await search('RECEIVED_BODY'); await hits('0/0')
  await closeSearch()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-timeline-activity], .foxwarm-tool-card')].every(node => !node.style.height))
  const settled = await page.evaluate(() => {
    const activities = [...document.querySelectorAll('[data-timeline-activity]')]
    const reply = text => [...document.querySelectorAll('.foxwarm-conversation-reply')].find(node => node.textContent.includes(text))
    return {
      firstBottom: activities[0].getBoundingClientRect().bottom,
      firstCollapseBottom: activities[0].querySelector('[data-activity-toggle="bottom"]').getBoundingClientRect().bottom,
      unmarkedTop: reply('UNMARKED_PROSE').getBoundingClientRect().top,
      lastBottom: activities.at(-1).getBoundingClientRect().bottom,
      scriptBottom: [...document.querySelectorAll('[data-session-communication]')].find(node => node.textContent.includes('SCRIPT_METADATA_BODY')).getBoundingClientRect().bottom,
      endTop: reply('END_PROSE').getBoundingClientRect().top,
    }
  })
  assert.ok(settled.firstCollapseBottom <= settled.firstBottom + 1, JSON.stringify(settled))
  assert.ok(settled.firstBottom <= settled.unmarkedTop + 1, JSON.stringify(settled))
  assert.ok(settled.scriptBottom <= settled.lastBottom + 1, JSON.stringify(settled))
  assert.ok(settled.lastBottom <= settled.endTop + 1, JSON.stringify(settled))
  const viewport = await page.$eval('.foxwarm-chat-messages', node => node.getBoundingClientRect().toJSON())
  await page.mouse.move(viewport.left + viewport.width / 2, viewport.top + viewport.height / 2)
  await page.mouse.wheel({deltaY:-10000})
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop < 1)
  await screenshot('desktop-folded-activity')
  await page.$$eval('[data-session-communication]', nodes => nodes.find(node => node.textContent.includes('SCRIPT_METADATA_BODY')).scrollIntoView({block:'start'}))
  await screenshot('desktop-folded-activity-tail')
})

test('mode changes, reload, and another browser root retain preferences without changing technical search', async () => {
  for (const view of ['Detailed', 'Grouped']) {
    await choose(view)
    assert.equal(await page.$$eval(`${menu} [role="switch"]`, buttons => buttons.some(button => button.textContent.includes('Show commentary'))), false)
    await closeMenu()
    await search('EXPLICIT_COMMENTARY'); await hits('1/1')
    await closeSearch()
  }
  await choose('Conversation'); await closeMenu()
  assert.equal(await page.evaluate(() => window.fixture.prefs.showCommentary), false)
  assert.equal(await page.evaluate(() => window.fixture.prefs.showInterAgentMessages), false)
  await page.reload({waitUntil:'load'})
  await page.waitForSelector('[aria-label="Expand activity"]')
  assert.equal(await page.$(standalone), null)
  const other = await browser.newPage()
  await other.goto(url,{waitUntil:'load'})
  await other.waitForFunction(() => !!window.fixture?.prefs)
  await other.evaluate(() => {window.fixture.prefs.setShowCommentary(true);window.fixture.prefs.setShowInterAgentMessages(true)})
  await page.waitForFunction(() => window.fixture.prefs.showCommentary && window.fixture.prefs.showInterAgentMessages)
  await page.waitForSelector(standalone)
  await other.close()
  await search('RECEIVED_BODY'); await hits('1/1')
  await closeSearch()
})

test('the latest live commentary stays in the collapsed preview until visible prose replaces it', async () => {
  await choose('Show commentary'); await closeMenu()
  const activityCount = await page.$$eval('[data-timeline-activity]',nodes=>nodes.length)
  await page.evaluate(() => window.fixture.emit({type:'model-stream-update',streamId:'display-stream',streamVersion:2,sequence:1,partDeltas:[{outputIndex:0,kind:'text',phase:'commentary',textDelta:{offset:0,text:'LIVE_COMMENTARY'}}]}))
  await page.waitForFunction(count=>document.querySelectorAll('[data-timeline-activity]').length>count,{},activityCount)
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-conversation-reply')].some(node => node.textContent.includes('LIVE_COMMENTARY')))
  await search('LIVE_COMMENTARY'); await hits('0/0')
  await closeSearch()
  await expandActivities()
  await page.waitForFunction(() => document.querySelector('[data-activity-details]') && [...document.querySelectorAll('[data-activity-details]')].some(node=>node.textContent.includes('LIVE_COMMENTARY')))
  assert.equal(await page.$$eval('.foxwarm-conversation-reply:not([data-activity-details] .foxwarm-conversation-reply)', nodes=>nodes.some(node=>node.textContent.includes('LIVE_COMMENTARY'))), false)
  await page.evaluate(() => window.fixture.emit({type:'model-stream-update',streamId:'display-stream',streamVersion:2,sequence:2,partDeltas:[{outputIndex:0,kind:'text',phase:'commentary',textDelta:{offset:0,text:'LIVE_COMMENTARY extended'}},{outputIndex:1,kind:'text',textDelta:{offset:0,text:'LIVE_UNMARKED'}}]}))
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-conversation-reply')].some(node=>node.textContent.includes('LIVE_UNMARKED')))
  await page.evaluate(() => window.fixture.replace([...window.fixture.original,{role:'model',parts:[{text:'LIVE_COMMENTARY extended',phase:'commentary'},{text:'LIVE_UNMARKED'},{text:'COMMITTED_FINAL',phase:'final_answer'}],__meta:{seq:14,timestamp:1700000030000}}]))
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').textContent.includes('COMMITTED_FINAL'))
  await expandActivities()
  assert.equal(await page.$$eval('.foxwarm-assistant-message-card', nodes=>nodes.filter(node=>node.textContent.includes('LIVE_COMMENTARY extended')).length), 1)
})

test('short and genuinely clipped To/From cards share native fade and full-body disclosure at desktop and mobile widths', async () => {
  await page.evaluate(() => {
    const body=window.fixture.longBody
    window.fixture.replace([
      {role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/peer">\nShort readable delivery.\n</foxwarm-message>'}],__meta:{seq:1}},
      {role:'tool',parts:[{functionResponse:{name:'run_script',tool_use_id:'long-send',response:{output:'ACK'},__meta:{sessionMessages:[{id:'long-send',targetSessionId:'fixture/peer',message:body}]}}}],__meta:{seq:2}},
      {role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="fixture/peer">\n'+body+'\n</foxwarm-message>'}],__meta:{seq:3}},
      {role:'model',parts:[{text:'CARD_TAIL'}],__meta:{seq:4}},
    ])
  })
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').textContent.includes('CARD_TAIL'))
  for (const width of [1100,390]) {
    await page.setViewport({width,height:850})
    await page.waitForFunction(() => document.querySelectorAll('[data-session-communication] [data-overflow-fade="bottom"]').length === 2)
    const cards=await page.$$('[data-session-communication]')
    assert.equal(await cards[0].$('[data-overflow-fade]'),null)
    assert.equal(await cards[0].$('button[aria-label="Expand message"]'),null)
    for (const index of [1,2]) {
      const card=cards[index]
      const clipped=await card.$eval('[data-search-surface="communication"]',node=>({height:node.clientHeight,total:node.scrollHeight,mask:getComputedStyle(node).maskImage}))
      assert.ok(clipped.total>clipped.height)
      assert.ok(clipped.mask.includes('linear-gradient'))
      await page.$eval('.foxwarm-chat-messages',node=>{node.scrollTop=0})
      await screenshot(`${width===390?'mobile':'desktop'}-cards-collapsed`)
      await card.$eval('[aria-label="Expand message"]',button=>button.focus())
      await page.keyboard.press('Enter')
      await page.waitForFunction(index => {
        const card=document.querySelectorAll('[data-session-communication]')[index]
        const body=card.querySelector('[data-search-surface="communication"]')
        return !card.style.height && body.clientHeight>=body.scrollHeight-1 && !body.hasAttribute('data-overflow-fade')
      },{},index)
      assert.equal(await card.$eval('[data-search-surface="communication"]',node=>node.textContent.includes('DELIVERY_TAIL')),true)
      const selected=await card.$eval('[data-search-surface="communication"]',node=>{const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);return getSelection().toString()})
      assert.ok(selected.endsWith('DELIVERY_TAIL'))
      await page.evaluate(()=>getSelection().removeAllRanges())
      await card.evaluate(node=>node.scrollIntoView({block:'start'}))
      await screenshot(`${width===390?'mobile':'desktop'}-${index===1?'sent':'received'}-expanded`)
      await card.$eval('[aria-label="Collapse message"]',button=>button.focus())
      await page.keyboard.press('Enter')
      assert.equal(await card.$eval('[aria-label="Expand message"]',button=>button===document.activeElement),true)
      await page.waitForFunction(index=>{const card=document.querySelectorAll('[data-session-communication]')[index];return !card.style.height && !!card.querySelector('[data-overflow-fade="bottom"]')},{},index)
    }
    await openMenu()
    const bounds=await page.$eval(menu,node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,width:innerWidth}))
    assert.ok(bounds.left>=0 && bounds.right<=bounds.width)
    await screenshot(`${width===390?'mobile':'desktop'}-menu-persisted`)
    await closeMenu()
  }
  await search('DELIVERY_TAIL'); await hits('1/2')
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-session-communication]')].some(card=>{const body=card.querySelector('[data-search-surface="communication"]');return body.textContent.includes('DELIVERY_TAIL') && body.clientHeight>=body.scrollHeight-1}))
  await closeSearch()
  await page.waitForFunction(()=>document.querySelectorAll('[data-session-communication] [data-overflow-fade="bottom"]').length===2)
  await page.$eval('[data-session-communication] a',link=>link.click())
  assert.deepEqual(await page.evaluate(()=>window.fixture.navigations),['fixture/peer'])
})

test('folded long deliveries retain disclosure and do not steal detached reading on stream or resize', async context => {
  const client = await page.createCDPSession()
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  context.after(async () => {
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await client.detach()
  })
  await choose('Show inter-agent messages'); await closeMenu()
  await page.waitForFunction(()=>!document.querySelector('[data-session-communication]:not([data-activity-details] [data-session-communication])'))
  await expandActivities()
  await page.waitForFunction(()=>document.querySelectorAll('[data-activity-details] [data-overflow-fade="bottom"]').length===2)
  await page.$eval('[data-activity-details] [data-session-communication="sent"] [aria-label="Expand message"]',button=>button.click())
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-session-communication="sent"]')
    const body = card.querySelector('[data-search-surface="communication"]')
    return !card.style.height && body.clientHeight >= body.scrollHeight - 1
      && [...document.querySelectorAll('[data-timeline-activity]')].every(node => !node.style.height)
  })
  // Expansion can already detach follow. Start at the actual bottom so the wheel
  // enters a nonzero reading position rather than clamping a small old offset to zero.
  await page.click('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(() => {
    const node = document.querySelector('.foxwarm-chat-messages')
    return node.scrollHeight - node.scrollTop - node.clientHeight < 1
      && !document.querySelector('[aria-label="Scroll to bottom"]')
  })
  const wheelTarget = await page.$eval('.foxwarm-chat-messages', node => {
    const target = node.scrollTop - 500
    window.fixture.readingScroll = null
    const record = () => {
      if (Math.abs(node.scrollTop - target) > 1) return
      window.fixture.readingScroll = node.scrollTop
      node.removeEventListener('scroll', record)
    }
    node.addEventListener('scroll', record)
    return target
  })
  assert.ok(wheelTarget > 0, 'expanded delivery leaves room for an interior reading position')
  const view=await page.$eval('.foxwarm-chat-messages',node=>node.getBoundingClientRect().toJSON())
  await page.mouse.move(view.left+view.width/2,view.top+view.height/2)
  await page.mouse.wheel({deltaY:-500})
  // The follow button acknowledges intent, not completed native movement.
  await page.waitForFunction(target => window.fixture.readingScroll !== null
    && Math.abs(window.fixture.readingScroll - target) <= 1, {}, wheelTarget)
  await page.waitForSelector('[aria-label="Scroll to bottom"]')
  const before=await page.$eval('.foxwarm-chat-messages',node=>node.scrollTop)
  assert.ok(Math.abs(before - wheelTarget) <= 1)
  await page.evaluate(()=>window.fixture.emit({type:'model-stream-update',streamId:'detached-display',text:'DETACHED_STREAM'}))
  await page.setViewport({width:420,height:820})
  await page.waitForFunction(()=>document.querySelector('.foxwarm-chat-messages').textContent.includes('DETACHED_STREAM'))
  const after = await page.evaluate(async () => {
    const node = document.querySelector('.foxwarm-chat-messages')
    const samples = [node.scrollTop]
    // Observe the resize correction frames as well as the first rendered stream.
    for (let frame = 0; frame < 4; frame++) {
      await new Promise(requestAnimationFrame)
      samples.push(node.scrollTop)
    }
    return samples
  })
  assert.ok(after.every(top => Math.abs(top - before) < 30), JSON.stringify({ before, after }))
  assert.ok(await page.$('[aria-label="Scroll to bottom"]'))
  await page.click('[aria-label="Scroll to bottom"]')
  await page.waitForFunction(()=>{const node=document.querySelector('.foxwarm-chat-messages');return node.scrollHeight-node.scrollTop-node.clientHeight<3})
})

test('folded mixed parts preserve images, one-owner request usage, timing scope, and legacy sends across a viewport cut', async () => {
  const evidence = await page.evaluate(() => {
    const timestamp = 1700000000000
    const messages = [
      { role: 'user', parts: [{ text: 'INPUT' }], __meta: { seq: 1, timestamp } },
      { role: 'model', parts: [
        { text: 'MIXED_COMMENTARY', phase: 'commentary', thinking: 'MIXED_REASONING', inlineDataUnavailable: { mimeType: 'image/png' } },
        { functionCall: { id: 'legacy', name: 'send_to_session', args: { sessionId: 'fixture/peer', message: 'LEGACY_FULL_BODY' } } },
      ], __meta: { seq: 2, timestamp: timestamp + 3000, llmRequestId: 'one-request', llmSegment: { outputStart: 0, outputEndExclusive: 2, complete: false } } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'legacy', name: 'send_to_session', response: { output: 'ACK_ONLY' } } }], __meta: { seq: 3, timestamp: timestamp + 4000 } },
      { role: 'user', parts: [{ system: '<foxwarm-message type="inter-agent" sourceSessionId="fixture/peer">\nINCOMING\n</foxwarm-message>' }], __meta: { seq: 4, timestamp: timestamp + 5000 } },
      { role: 'model', parts: [{ text: 'FINAL', phase: 'final_answer' }], __meta: { seq: 5, timestamp: timestamp + 12000, llmRequestId: 'one-request', llmSegment: { outputStart: 2, outputEndExclusive: 3, complete: true }, usage: { cachedTokens: 0, inputTokens: 10, outputTokens: 20 } } },
    ]
    const original = JSON.stringify(messages)
    const project = options => {
      const rows = window.fixture.rows(messages, options)
      return {
        communicationCount: rows.filter(row => row.communication).length,
        images: rows.filter(row => row.conversationImageOnly).length,
        visible: rows.filter(row => row.conversationPartIndex !== undefined && !row.conversationImageOnly).map(row => row.msg.parts[row.conversationPartIndex].text),
        folded: rows.flatMap(row => row.activity?.messages || []).flatMap(message => message.parts).filter(part => part.text === 'MIXED_COMMENTARY').length,
        usage: rows.reduce((total, row) => total + (row.activity?.usage?.usage.inputTokens || 0) + (row.activity?.usage?.usage.outputTokens || 0), 0),
        owners: rows.filter(row => row.activity?.usage).length,
        summaries: rows.filter(row => row.activity).map(row => row.activity.summary),
      }
    }
    const shown = project({})
    const folded = project({ showInterAgentMessages: false, showCommentary: false })
    const cut = window.fixture.rows(messages.slice(2), { timelineView: 'detailed', activityDetails: true, showInterAgentMessages: false, historyMessages: messages })
    return { shown, folded, cutSends: cut.filter(row => row.communication?.direction === 'sent').map(row => row.communication.message), unchanged: JSON.stringify(messages) === original }
  })
  assert.equal(evidence.shown.communicationCount, 2)
  assert.deepEqual(evidence.shown.visible, ['MIXED_COMMENTARY', 'FINAL'])
  assert.equal(evidence.folded.communicationCount, 0)
  assert.deepEqual(evidence.folded.visible, ['FINAL'])
  assert.equal(evidence.folded.images, 1)
  assert.equal(evidence.folded.folded, 1)
  assert.equal(evidence.shown.usage, 30)
  assert.equal(evidence.folded.usage, 30)
  assert.equal(evidence.shown.owners, 1)
  assert.equal(evidence.folded.owners, 1)
  assert.ok(evidence.folded.summaries.some(summary => summary.includes('12s')), evidence.folded.summaries.join('; '))
  assert.deepEqual(evidence.cutSends, ['LEGACY_FULL_BODY'])
  assert.equal(evidence.unchanged, true)
})


test('Show commentary off retains only the last commentary of a reply-free turn, including Search and disclosure', async () => {
  await page.setViewport({ width: 1100, height: 850 })
  await page.evaluate(() => {
    window.fixture.prefs.setTimelineView('conversation')
    window.fixture.prefs.setShowCommentary(false)
    window.fixture.prefs.setShowInterAgentMessages(false)
    const messages = [
      { role: 'user', parts: [{ text: 'First turn' }] },
      { role: 'model', parts: [{ text: 'EARLIER_COMMENTARY', phase: 'commentary' }] },
      { role: 'model', parts: [{ text: 'LAST_TURN_COMMENTARY', phase: 'commentary' }, { functionCall: { id: 'tail-call', name: 'exec', args: { command: 'synthetic command' } } }] },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'tail-call', name: 'exec', response: { output: 'Synthetic result' } } }] },
      { role: 'model', parts: [], __meta: { llmRequestId: 'tail-request', llmSegment: { outputStart: 0, outputEndExclusive: 0, complete: true } } },
      { role: 'user', parts: [{ text: 'Second turn' }] },
      { role: 'model', parts: [{ text: 'SUPERSEDED_COMMENTARY', phase: 'commentary' }, { text: 'ORDINARY_FINAL_REPLY', phase: 'final_answer' }] },
    ].map((message, index) => ({ ...message, __meta: { ...message.__meta, seq: 100 + index, timestamp: 1700000100000 + index * 1000 } }))
    window.fixture.replace(messages)
  })
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').textContent.includes('ORDINARY_FINAL_REPLY'))
  const collapsed = await text()
  assert.ok(collapsed.includes('LAST_TURN_COMMENTARY'))
  assert.ok(!collapsed.includes('EARLIER_COMMENTARY'))
  assert.ok(!collapsed.includes('SUPERSEDED_COMMENTARY'))
  await search('LAST_TURN_COMMENTARY'); await hits('1/1')
  await search('EARLIER_COMMENTARY'); await hits('0/0')
  await search('SUPERSEDED_COMMENTARY'); await hits('0/0')
  await closeSearch()
  await screenshot('last-commentary-preview')
  await expandActivities()
  const expanded = await text()
  for (const body of ['EARLIER_COMMENTARY', 'LAST_TURN_COMMENTARY', 'SUPERSEDED_COMMENTARY']) {
    assert.equal(expanded.split(body).length - 1, 1, body + ' is rendered once in expanded Activity')
  }
})
