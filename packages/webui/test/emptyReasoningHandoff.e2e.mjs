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
const scenarios = {
  tool: [model([empty, call('first'), call('second')], 1, 42), result('first')],
  text: [model([empty, { text: 'The result is ready. This answer remains readable beside its reasoning information.' }], 2, 128)],
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

test('wide and narrow headers preserve text, duration and action geometry', async () => {
  const directory = process.env.FOXWARM_E2E_SCREENSHOT_DIR
  if (directory) await mkdir(directory, { recursive: true })
  await page.addStyleTag({ content: 'section:not([data-case="tool"]):not([data-case="text"]):not([data-case="content"]):not([data-case="partOrder"]):not([data-case="stream"]) {display:none}' })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  for (const width of [1100, 390]) {
    await page.setViewport({ width, height: 900 })
    for (const id of ['tool', 'text', 'content', 'partOrder']) await page.evaluate(id => window.renderScenario(id), id)
    await page.waitForFunction(() => [...document.querySelectorAll('#tool .foxwarm-tool-card')].every(el => !el.style.height))
    await page.hover('#text .foxwarm-assistant-message-card')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#text .foxwarm-assistant-action-buttons')).opacity === '1')
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect()
      const badge = rect('#tool [data-reasoning-handoff]')
      const duration = rect('#tool [data-tool-execution-time]')
      const body = rect('#text .foxwarm-assistant-message-markdown')
      const textBadge = rect('#text [data-reasoning-handoff]')
      const actions = rect('#text .foxwarm-assistant-action-buttons')
      return { noPageOverflow: document.documentElement.scrollWidth <= innerWidth, toolFits: badge.right <= rect('#tool .foxwarm-tool-card').right + 1, durationBeforeBadge: duration.right <= badge.left, bodyBelowBadge: body.top >= textBadge.bottom, actionsBeforeBadge: actions.right <= textBadge.left }
    })
    assert.deepEqual(geometry, { noPageOverflow: true, toolFits: true, durationBeforeBadge: true, bodyBelowBadge: true, actionsBeforeBadge: true })
    if (directory) await page.screenshot({ path: path.join(directory, `empty-reasoning-${width}.png`), fullPage: true })
  }
  if (directory) {
    await page.evaluate(() => window.setDark())
    await page.screenshot({ path: path.join(directory, 'empty-reasoning-390-dark.png'), fullPage: true })
  }
})
