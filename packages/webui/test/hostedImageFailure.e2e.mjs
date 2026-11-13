import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const fixture = `
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from './src/components/ChatTimeline.tsx'
  import { projectSessionSearchFields, findSessionSearchMatches } from './src/components/chatSessionSearch'
  import { initializeThemeRuntime } from './src/theme/runtime'
  initializeThemeRuntime()
  import { buildStreamingAssistantMessage } from './src/streamingAssistantDraft.ts'
  const root = createRoot(document.getElementById('root'))
  let mode = 'detailed'
  let messages = []
  const render = (next, searchTarget) => { messages = next; root.render(React.createElement(ChatTimeline, {
    sessionId: 'fixture/main', messages, isMobile: false, timelineView: mode, showUsageBadge: false, searchTarget,
  })) }
  window.fixture = {
    mode(value) { mode = value; render(messages) },
    search(query) { const matches = findSessionSearchMatches(projectSessionSearchFields(messages, mode), query); render(messages, matches[0]); return matches },
    status(status) { render([buildStreamingAssistantMessage({
      streamId: 'image-request', iteration: 0, startedAt: 1, reasoning: '', text: '', toolCalls: [],
      parts: [{ outputIndex: 0, kind: 'image-generation', status }],
    })]) },
    history() { render([{ role: 'model', __meta: { seq: 1, timestamp: 1 }, parts: [
      { text: '[image generation did not produce a usable image: ig_fixture: Image generation failed.; system_error; UserError]',
        providerMeta: { openaiResponses: { sourceModelId: 'fixture/model', imageGenerationFailure: {
          type: 'image_generation_call', id: 'fixture', status: 'failed', hasResult: false,
          error: { code: 'system_error', type: 'UserError' },
        } } } },
      { text: 'The normal answer remains available.', phase: 'final_answer' },
      { text: 'Image generation failed: ordinary assistant prose is still prose.', phase: 'final_answer' },
    ] }]) },
  }
`

test('hosted image failures remain understandable during streaming and after history replacement', async () => {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: packageDir, sourcefile: 'hosted-image-failure-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  const assets = new URL('../dist/assets/', import.meta.url)
  const css = (await Promise.all((await readdir(assets)).filter(name => name.endsWith('.css')).map(name => readFile(new URL(name, assets), 'utf8')))).join('\n')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
    for (const [status, label] of [['in_progress', 'Generating image'], ['failed', 'Image generation failed'], ['incomplete', 'Image generation incomplete']]) {
      await page.evaluate(status => window.fixture.status(status), status)
      await page.waitForFunction(label => document.body.innerText.includes(label), {}, label)
      if (status !== 'in_progress') {
        assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /Generating image|Image ready/)
      }
    }
    for (const mode of ['detailed', 'grouped', 'conversation']) {
      await page.reload({ waitUntil: 'load' })
      await page.evaluate(mode => { window.fixture.mode(mode); window.fixture.history() }, mode)
      await page.waitForSelector('[data-system-event][data-event-severity="error"]')
      const initial = await page.evaluate(() => {
        const card = document.querySelector('[data-system-event]')
        const details = card.querySelector('details')
        return { title: card.getAttribute('aria-label'), open: details.open, text: card.innerText,
          border: getComputedStyle(card).borderLeftWidth,
          ordinary: [...document.querySelectorAll('.foxwarm-assistant-message-card')].map(node => node.innerText).join('\n') }
      })
      assert.equal(initial.title, 'Image generation failed')
      assert.equal(initial.open, false)
      assert.doesNotMatch(initial.text, /UserError|system_error|ig_fixture/)
      assert.match(initial.ordinary, /normal answer remains/)
      assert.match(initial.ordinary, /ordinary assistant prose is still prose/)
      assert.doesNotMatch(initial.ordinary, /did not produce a usable image/)
      assert.equal(initial.border, '2px')
      if (mode === 'detailed' && process.env.FOXWARM_IMAGE_CARD_SCREENSHOT) await page.screenshot({ path: process.env.FOXWARM_IMAGE_CARD_SCREENSHOT, fullPage: true })
      await page.click('[data-system-event] summary')
      await page.waitForFunction(() => document.querySelector('[data-system-event] details').open)
      assert.match(await page.$eval('[data-system-event]', node => node.innerText), /system_error/)
      await page.click('[data-system-event] summary')
      const matches = await page.evaluate(() => window.fixture.search('UserError'))
      assert.equal(matches.length, 1)
      await page.waitForFunction(() => document.querySelector('[data-system-event] details').open)
      assert.match(await page.$eval('[data-system-event]', node => node.innerText), /UserError/)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
