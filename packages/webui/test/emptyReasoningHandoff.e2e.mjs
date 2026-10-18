import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { build } from './browserFixtureBundle.mjs'

const entry = relative => new URL(relative, import.meta.url).pathname
const model = (parts, seq, tokens) => ({ role: 'model', parts, __meta: { seq, ...(tokens !== undefined ? { usage: { reasoningTokens: tokens } } : {}) } })
const empty = { thinking: '', providerMeta: { encryptedThinking: 'opaque-not-visible' } }
const call = id => ({ functionCall: { id, name: 'exec', args: { command: `echo ${id}` } } })
const result = id => ({ role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: 'Check complete.' }, executionTiming: { startedAt: 1000, completedAt: 2250, durationMs: 1250 } } }] })
const retry = (seq, final = false) => ({ role: 'model', modelVisible: false, parts: [{ text: '⚠️ LLM Error: Attempt 1 failed: Service unavailable.' }], __meta: {
  seq, timestamp: 1700000000000 + seq, noticeType: 'llm-retry',
  retry: { attempt: 1, maxRetries: 6, ...(final ? { final: true } : { nextAttempt: 2, delayMs: 1000, final: false }), kind: 'http-error', reason: 'Service unavailable', status: '503' },
} })
const scenarios = {
  tool: [model([empty, call('first'), call('second')], 1, 42), result('first')],
  text: [model([empty, { text: 'The result is ready. This answer remains readable beside its reasoning information.' }], 2, 128)],
  longText: [model([empty, { text: 'The opening line leaves room for reasoning information, while later lines return to the full reading width. '.repeat(8) }], 31, 128)],
  shortText: [model([empty, { text: 'Ready.' }], 32, 128)],
  shortPlain: [model([{ text: 'Ready.' }], 33)],
  missing: [model([empty, { text: 'No token estimate.' }], 3)],
  zero: [model([empty, { text: 'Zero is a real value.' }], 4, 0)],
  content: [model([{ thinking: 'Visible summary one.' }, { thinking: 'Visible summary two.' }, { text: 'A normal answer.' }], 5, 21)],
  partOrder: [model([{ text: 'Earlier text cannot receive later reasoning.' }, empty], 6, 11)],
  userBoundary: [model([empty], 7, 13), { role: 'user', parts: [{ text: 'A new turn.' }], __meta: { seq: 8 } }, model([{ text: 'Unrelated answer.' }], 9)],
  ctxBoundary: [model([empty], 10, 14), { ...model([{ text: 'Archived context.' }], 11), __meta: { seq: 11, contextBlock: { id: 1, level: 1, rawStartSeq: 1, rawEndSeq: 9 } } }, model([{ text: 'After context.' }], 12)],
  split: [model([empty], 13, 35), model([{ text: 'A later segment receives the original token information.' }], 14)],
  grouped: [model([empty, call('group')], 15, 64), result('group'), model([{ text: 'Grouped answer.' }], 16)],
  conversation: [model([empty, call('process')], 17, 51), result('process'), model([empty, { text: 'Conversation reply.', phase: 'final_answer' }], 18, 77)],
  mixedConversation: [model([{ ...empty, text: 'Mixed-field reply.', phase: 'final_answer' }], 19, 78)],
  retryTail: [model([empty], 23, 61), retry(24, true)],
  retryThenText: [model([empty], 25, 62), retry(26), model([{ text: 'Recovered response.' }], 27)],
  retryThenTool: [model([empty], 28, 63), retry(29), model([call('recovered')], 30)],
}
let browser, page, server

before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import ChatTimeline from ${JSON.stringify(entry('../src/components/ChatTimeline.tsx'))}
      import { buildStreamingAssistantMessage } from ${JSON.stringify(entry('../src/streamingAssistantDraft.ts'))}
      import { initializeThemeRuntime, setThemeSelection } from ${JSON.stringify(entry('../src/theme/index.ts'))}
      initializeThemeRuntime()
      setThemeSelection({themeId:'foxwarm.default', colorMode:'light'})
      const scenarios = ${JSON.stringify(scenarios)}
      const roots = new Map()
      window.renderScenario = (id, messages = scenarios[id], view = id.includes('Conversation') || id === 'conversation' ? 'conversation' : id === 'grouped' ? 'grouped' : 'detailed', running = false) => {
        if (!roots.has(id)) roots.set(id, createRoot(document.getElementById(id)))
        roots.get(id).render(React.createElement(ChatTimeline, {sessionId:'fixture/'+id, messages, isMobile:window.innerWidth < 640, timelineView:view, showUsageBadge:false, isRunningTool:running}))
      }
      window.renderStream = (stage, target = 'text') => {
        const draft = {streamId:'empty-reasoning', llmRequestId:'stream-request', reasoning:'', text:'', toolCalls:[], parts:[{outputIndex:0,kind:'reasoning',summaryIndex:0,text:''}]}
        if(stage === 'successor') {
          if(target === 'text') draft.parts.push({outputIndex:1,kind:'text',text:'Live answer arrived.'})
          else { draft.parts.push({outputIndex:1,kind:'tool-call'}); draft.toolCalls.push({index:1,id:'live-call',name:'exec',arguments:'{"command":"echo live"}'}) }
        }
        const message = buildStreamingAssistantMessage(draft)
        if(stage === 'canonical') { message.parts.push({text:'Live answer arrived.'}); message.__meta={seq:20,llmRequestId:'stream-request',usage:{reasoningTokens:93}} }
        window.renderScenario('stream', [message], 'detailed', stage !== 'stopped' && stage !== 'canonical')
      }
      window.renderPrefixStream = (complete) => {
        const prefix = {role:'model',parts:[{thinking:''}],__meta:{seq:21,llmRequestId:'prefix-request',llmSegment:{outputStart:0,outputEndExclusive:1,complete:false}}}
        const successor = buildStreamingAssistantMessage({streamId:'prefix-stream',llmRequestId:'prefix-request',committedThrough:1,reasoning:'',text:'',toolCalls:[],parts:[{outputIndex:1,kind:'text',text:'A committed prefix followed by live text.'}]})
        if(complete) successor.__meta={seq:22,llmRequestId:'prefix-request',llmSegment:{outputStart:1,outputEndExclusive:2,complete:true},usage:{reasoningTokens:105}}
        window.renderScenario('stream',[prefix,successor],'detailed')
      }
      for (const id of Object.keys(scenarios)) window.renderScenario(id)
      window.renderStream('thinking')
      window.setDark = () => setThemeSelection({themeId:'foxwarm.default',colorMode:'dark'})
    `, resolveDir: entry('..'), sourcefile: 'empty-reasoning-handoff-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style><style>body{margin:0;padding:24px;background:var(--fw-bg);color:var(--fw-text)} main{max-width:960px;margin:auto} section{margin:20px 0} h2{font:12px sans-serif;color:var(--fw-text-muted);margin:0 0 8px}</style></head><body><main class="foxwarm-chat-root">${[...Object.keys(scenarios), 'stream'].map(id => `<section data-case="${id}"><h2>${id}</h2><div id="${id}"></div></section>`).join('')}</main><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('pageerror', error => console.error(error))
  await page.setViewport({ width: 1100, height: 900 })
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' })
  await page.waitForSelector('#stream .foxwarm-reasoning-card')
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const state = id => page.$eval(`#${id}`, root => ({
  cards: root.querySelectorAll('.foxwarm-reasoning-card').length,
  badges: [...root.querySelectorAll('[data-reasoning-handoff]')].map(el => ({ text: el.textContent, tool: !!el.closest('.foxwarm-tool-card'), assistant: !!el.closest('.foxwarm-assistant-message-card') })),
  tokens: [...root.querySelectorAll('[data-reasoning-tokens]')].map(el => el.textContent),
}))

test('empty reasoning moves to the next invocation once and coexists with duration and disclosure', async () => {
  assert.deepEqual(await state('tool'), { cards: 0, badges: [{ text: '42 tokens', tool: true, assistant: false }], tokens: ['42 tokens'] })
  assert.equal(await page.$eval('#tool [data-tool-execution-time]', el => el.textContent), '1s')
  await page.click('#tool .foxwarm-tool-header-toggle')
  await page.waitForSelector('#tool .foxwarm-tool-expanded-content')
  assert.equal((await state('tool')).badges.length, 1)
  assert.equal(await page.$eval('#tool .foxwarm-tool-expanded-content', el => el.textContent.includes('Check complete.')), true)
  await page.click('#tool .foxwarm-tool-header-toggle')
})

test('text receives a compact badge without estimates or changes to nonempty reasoning', async () => {
  assert.deepEqual(await state('text'), { cards: 0, badges: [{ text: '128 tokens', tool: false, assistant: true }], tokens: ['128 tokens'] })
  assert.deepEqual((await state('missing')).tokens, [])
  assert.equal((await state('missing')).badges.length, 1)
  assert.deepEqual((await state('zero')).tokens, ['0 tokens'])
  assert.deepEqual(await state('content'), { cards: 1, badges: [], tokens: ['21 tokens'] })
  assert.equal(await page.$eval('#content .foxwarm-reasoning-tag', el => el.getAttribute('aria-label')), 'Reasoning ×2')
  assert.deepEqual(await state('partOrder'), { cards: 1, badges: [], tokens: ['11 tokens'] })
  assert.equal(await page.$eval('#text .foxwarm-assistant-message-markdown', el => el.textContent.trim()), scenarios.text[0].parts[1].text)
  await page.$eval('#text button[title="Raw Text"]', el => el.click())
  assert.equal(await page.$eval('#text .foxwarm-assistant-message-raw', el => el.textContent), scenarios.text[0].parts[1].text)
  await page.$eval('#text button[title="Rendered (Markdown)"]', el => el.click())
})

test('handoffs cross model segments but never direct-user or CTX boundaries', async () => {
  assert.deepEqual((await state('split')).tokens, ['35 tokens'])
  assert.equal((await state('split')).cards, 0)
  for (const id of ['userBoundary', 'ctxBoundary']) {
    assert.equal((await state(id)).cards, 1)
    assert.equal((await state(id)).badges.length, 0)
  }
})

test('LLM retry notices neither receive reasoning information nor prevent a later real output from receiving it', async () => {
  assert.deepEqual(await state('retryTail'), { cards: 1, badges: [], tokens: ['61 tokens'] })
  for (const [id, tokens, target] of [['retryThenText', '62 tokens', 'assistant'], ['retryThenTool', '63 tokens', 'tool']]) {
    const recovered = await state(id)
    assert.equal(recovered.cards, 0)
    assert.deepEqual(recovered.tokens, [tokens])
    assert.equal(recovered.badges.length, 1)
    assert.equal(recovered.badges[0][target], true)
    assert.equal(await page.$eval(`#${id} [data-system-event]`, el => el.querySelector('[data-reasoning-handoff]') === null), true)
  }
  assert.equal(await page.$eval('#retryTail [data-system-event]', el => el.textContent.includes('Service unavailable.')), true)
})

test('live empty reasoning stays at the tail through stop, then transfers on real draft output and canonical completion', async () => {
  assert.equal((await state('stream')).cards, 1)
  await page.evaluate(() => window.renderStream('stopped'))
  assert.equal((await state('stream')).cards, 1)
  for (const target of ['tool', 'text']) {
    await page.evaluate(target => window.renderStream('successor', target), target)
    await page.waitForSelector('#stream [data-reasoning-handoff]')
    const live = await state('stream')
    assert.equal(live.cards, 0)
    assert.deepEqual(live.tokens, [])
    assert.equal(live.badges[0][target === 'tool' ? 'tool' : 'assistant'], true)
  }
  await page.evaluate(() => window.renderStream('canonical'))
  await page.waitForFunction(() => document.querySelector('#stream [data-reasoning-tokens]')?.textContent === '93 tokens')
  assert.equal((await state('stream')).cards, 0)
  for (const complete of [false, true]) {
    await page.evaluate(complete => window.renderPrefixStream(complete), complete)
    await page.waitForFunction(() => document.querySelector('#stream .foxwarm-assistant-message-markdown')?.textContent.includes('committed prefix'))
    const prefix = await state('stream')
    assert.equal(prefix.cards, 0)
    assert.equal(prefix.badges.length, 1)
    assert.deepEqual(prefix.tokens, [], 'completion usage is not borrowed for the committed prefix')
  }
  await page.evaluate(() => window.renderStream('canonical'))
})

test('Grouped and expanded Conversation reuse ownership, including a reply outside Activity and mixed-field parts', async () => {
  assert.equal((await state('grouped')).cards, 0)
  await page.click('#grouped [aria-label="Expand tool group"]')
  await page.waitForSelector('#grouped .foxwarm-tool-card [data-reasoning-handoff]')
  assert.deepEqual((await state('grouped')).tokens, ['64 tokens'])
  assert.equal((await state('conversation')).cards, 0)
  assert.deepEqual((await state('conversation')).tokens, ['77 tokens'])
  for (const id of ['conversation', 'mixedConversation']) {
    await page.$eval(`#${id} [aria-label="Expand activity"]`, el => el.click())
    await page.waitForSelector(`#${id} [data-activity-details]`)
    assert.equal((await state(id)).cards, 0)
  }
  assert.deepEqual((await state('conversation')).tokens, ['51 tokens', '77 tokens'])
  assert.deepEqual((await state('mixedConversation')).tokens, ['78 tokens'])
})

test('wide and narrow prose wraps a right float while original hover controls overlay it without moving', async () => {
  const directory = process.env.FOXWARM_E2E_SCREENSHOT_DIR
  if (directory) await mkdir(directory, { recursive: true })
  await page.addStyleTag({ content: 'section:not([data-case="tool"]):not([data-case="longText"]):not([data-case="shortText"]):not([data-case="shortPlain"]):not([data-case="conversation"]) {display:none}' })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  for (const width of [1100, 390]) {
    // Narrow desktop panes keep metrics/actions; root-mobile hiding is checked separately below.
    await page.setViewport({ width:1100, height:900 })
    await page.$eval('main',(main,width)=>{main.style.maxWidth=`${width-48}px`},width)
    for (const id of ['tool', 'longText', 'shortText', 'shortPlain', 'conversation']) await page.evaluate(id => window.renderScenario(id), id)
    await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-tool-card, [data-timeline-activity]')].every(el => !el.style.height))
    await page.evaluate(() => document.activeElement?.blur())
    await page.mouse.move(0, 0)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#shortText .foxwarm-assistant-action-buttons')).opacity === '0')
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect()
      const badge = rect('#tool [data-reasoning-handoff]')
      const duration = rect('#tool [data-tool-execution-time]')
      const prose = id => {
        const root = document.querySelector('#' + id)
        const marker = root.querySelector('[data-reasoning-handoff]')
        const markerRect = marker.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(root.querySelector('.foxwarm-markdown p'))
        const lines = [...range.getClientRects()]
        return {
          rightFloat: getComputedStyle(marker.parentElement).float === 'right',
          firstLineBesideBadge: lines[0].top < markerRect.bottom && lines[0].bottom > markerRect.top && lines[0].right <= markerRect.left + 1,
          laterLineUsesFullWidth: lines.some(line => line.top >= markerRect.bottom && line.right > markerRect.left + 20),
        }
      }
      const actionOffset = id => {
        const card = rect('#' + id + ' .foxwarm-assistant-message-card')
        const actions = rect('#' + id + ' .foxwarm-assistant-action-buttons')
        return { top: actions.top - card.top, right: card.right - actions.right }
      }
      const shortCard = rect('#shortText .foxwarm-assistant-message-card')
      const plainCard = rect('#shortPlain .foxwarm-assistant-message-card')
      const conversation = document.querySelector('#conversation .foxwarm-conversation-reply')
      const conversationActions = conversation.querySelector('.foxwarm-assistant-action-buttons')
      return {
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth,
        toolFits: badge.right <= rect('#tool .foxwarm-tool-card').right + 1,
        durationBeforeBadge: duration.right <= badge.left,
        short: prose('shortText'), long: prose('longText'),
        shortHeightUnchanged: Math.abs(shortCard.height - plainCard.height) <= 1,
        actionOffset: actionOffset('shortText'), plainActionOffset: actionOffset('shortPlain'),
        conversationActionsBelowBody: conversationActions.getBoundingClientRect().top >= conversation.querySelector('.foxwarm-assistant-message-markdown').getBoundingClientRect().bottom,
        conversationActionsPosition: getComputedStyle(conversationActions).position,
      }
    })
    assert.ok(geometry.noPageOverflow && geometry.toolFits && geometry.durationBeforeBadge, JSON.stringify(geometry))
    assert.deepEqual(geometry.short, { rightFloat: true, firstLineBesideBadge: true, laterLineUsesFullWidth: false })
    assert.deepEqual(geometry.long, { rightFloat: true, firstLineBesideBadge: true, laterLineUsesFullWidth: true })
    assert.ok(geometry.shortHeightUnchanged)
    assert.deepEqual(geometry.actionOffset, geometry.plainActionOffset)
    assert.equal(geometry.conversationActionsPosition, 'static')
    assert.ok(geometry.conversationActionsBelowBody)
    if (directory) await page.screenshot({ path: path.join(directory, `reasoning-float-${width}.png`), fullPage: true })
    await page.$eval('#shortText .foxwarm-assistant-message-card', card => card.scrollIntoView({ block: 'center' }))
    const buttons = await page.$('#shortText .foxwarm-assistant-action-buttons')
    const before = await buttons.boundingBox()
    await page.hover('#shortText .foxwarm-assistant-message-card')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#shortText .foxwarm-assistant-action-buttons')).opacity === '1')
    assert.deepEqual(await buttons.boundingBox(), before)
    assert.equal(await page.$eval('#shortText button[title="Raw Text"]', button => {
      const rect = button.getBoundingClientRect()
      const badge = button.closest('.foxwarm-assistant-message-card').querySelector('[data-reasoning-handoff]').getBoundingClientRect()
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      return x >= badge.left && x <= badge.right && y >= badge.top && y <= badge.bottom && button.contains(document.elementFromPoint(x, y))
    }), true, 'the actual button stays clickable over the badge')
    if (directory) await page.screenshot({ path: path.join(directory, `reasoning-float-${width}-hover.png`), fullPage: true })
    await page.click('#shortText button[title="Raw Text"]')
    assert.equal(await page.$eval('#shortText .foxwarm-assistant-message-raw', element => element.textContent), 'Ready.')
    await page.click('#shortText button[title="Rendered (Markdown)"]')
  }
  await page.setViewport({width:390,height:900})
  await page.waitForFunction(()=>!document.querySelector('#shortText .foxwarm-assistant-action-buttons'))
  assert.equal(await page.$$eval('[data-reasoning-handoff]',elements=>elements.length),0)
  if (directory) {
    await page.evaluate(() => window.setDark())
    await page.screenshot({ path: path.join(directory, 'reasoning-float-390-dark-hover.png'), fullPage: true })
  }
})
