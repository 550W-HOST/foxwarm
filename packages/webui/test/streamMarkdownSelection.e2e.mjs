import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-stream-markdown-selection-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')

let server
let fixtureUrl

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatTimeline.tsx'))}
  import ReasoningCard from ${JSON.stringify(path.join(webuiRoot, 'src/components/ReasoningCard.tsx'))}
  import ${JSON.stringify(path.join(webuiRoot, 'src/index.css'))}

  let assistantText = 'First assistant paragraph with selectable words.\\n\\nSecond assistant paragraph is growing.'
  let assistantCommitted = false
  let reasoningText = 'First reasoning paragraph with selectable words.\\n\\nSecond reasoning paragraph is growing.'
  const root = createRoot(document.getElementById('root'))

  function render() {
    const assistantMeta = assistantCommitted
      ? { seq: 7, timestamp: 2000, llmRequestId: 'request-selection' }
      : { synthetic: 'streamingAssistantDraft', temporary: true, streaming: true, llmRequestId: 'request-selection' }
    root.render(
      <main>
        <section id="assistant-fixture">
          <ChatTimeline
            sessionId="fixture/main"
            messages={[{ role: 'model', parts: [{ text: assistantText }], __meta: assistantMeta }]}
            isMobile={false}
            groupTools={false}
            showUsageBadge={false}
          />
        </section>
        <section id="reasoning-fixture">
          <ReasoningCard thinking={reasoningText} tone="processing" defaultExpanded={true} />
        </section>
      </main>,
    )
  }

  window.fixture = {
    growAssistantTail() { assistantText += ' more'; render() },
    appendAssistantBlock() { assistantText += '\\n\\nThird assistant paragraph arrived.'; render() },
    commitAssistant() { assistantCommitted = true; render() },
    growReasoningTail() { reasoningText += ' more'; render() },
    appendReasoningBlock() { reasoningText += '\\n\\nThird reasoning paragraph arrived.'; render() },
  }
  render()
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath],
    outdir: outputDirectory,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    logLevel: 'silent',
  })

  const scriptName = 'fixture.js'
  server = createServer(async (request, response) => {
    if (request.url === `/${scriptName}`) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(await readFile(path.join(outputDirectory, scriptName)))
      return
    }
    if (request.url === '/fixture.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      response.end(await readFile(path.join(outputDirectory, 'fixture.css')))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/${scriptName}"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

const browsers = [
  { name: 'Chromium', executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  { name: 'Firefox', browser: 'firefox', executablePath: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox', args: [] },
]

for (const browserSpec of browsers) {
  test(`${browserSpec.name} preserves selections in unchanged streamed Markdown blocks`, async () => {
    const browser = await puppeteer.launch({
      ...(browserSpec.browser ? { browser: browserSpec.browser } : {}),
      executablePath: browserSpec.executablePath,
      headless: true,
      args: browserSpec.args,
    })
    try {
      const page = await browser.newPage()
      await page.goto(fixtureUrl, { waitUntil: 'load' })
      await page.waitForSelector('#assistant-fixture .foxwarm-markdown p')
      await page.waitForSelector('#reasoning-fixture .foxwarm-markdown p')

      const selectText = async (selector, storageKey) => page.$eval(selector, (paragraph, key) => {
        const textNode = paragraph.firstChild
        const range = document.createRange()
        range.setStart(textNode, 6)
        range.setEnd(textNode, 30)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        window[key] = { paragraph, textNode }
        return selection.toString()
      }, storageKey)
      const readSelection = async (selector, storageKey) => page.$eval(selector, (paragraph, key) => {
        const selection = window.getSelection()
        return {
          text: selection.toString(),
          sameParagraph: paragraph === window[key].paragraph,
          sameTextNode: selection.anchorNode === window[key].textNode,
          anchorOffset: selection.anchorOffset,
          focusOffset: selection.focusOffset,
        }
      }, storageKey)
      const expectPreserved = (snapshot, selectedText) => {
        assert.equal(snapshot.text, selectedText)
        assert.equal(snapshot.sameParagraph, true)
        assert.equal(snapshot.sameTextNode, true)
        assert.equal(snapshot.anchorOffset, 6)
        assert.equal(snapshot.focusOffset, 30)
      }

      const assistantSelector = '#assistant-fixture .foxwarm-markdown p:first-of-type'
      const selectedAssistant = await selectText(assistantSelector, '__assistantSelection')
      await page.evaluate(() => window.fixture.growAssistantTail())
      await page.waitForFunction(() => document.querySelector('#assistant-fixture .foxwarm-markdown')?.textContent.includes('growing. more'))
      expectPreserved(await readSelection(assistantSelector, '__assistantSelection'), selectedAssistant)

      await page.evaluate(() => window.fixture.appendAssistantBlock())
      await page.waitForFunction(() => document.querySelectorAll('#assistant-fixture .foxwarm-markdown p').length === 3)
      expectPreserved(await readSelection(assistantSelector, '__assistantSelection'), selectedAssistant)
      assert.deepEqual(await page.$eval('#assistant-fixture .foxwarm-markdown', markdown => {
        const paragraphs = markdown.querySelectorAll('p')
        return {
          firstMarginTop: getComputedStyle(paragraphs[0]).marginTop,
          lastMarginBottom: getComputedStyle(paragraphs[paragraphs.length - 1]).marginBottom,
        }
      }), { firstMarginTop: '0px', lastMarginBottom: '0px' })

      await page.evaluate(() => window.fixture.commitAssistant())
      await page.waitForFunction(() => document.querySelector('#assistant-fixture [data-chat-message-anchor-key="seq-local-7"]'))
      expectPreserved(await readSelection(assistantSelector, '__assistantSelection'), selectedAssistant)

      const reasoningSelector = '#reasoning-fixture .foxwarm-markdown p:first-of-type'
      const selectedReasoning = await selectText(reasoningSelector, '__reasoningSelection')
      await page.evaluate(() => window.fixture.growReasoningTail())
      await page.waitForFunction(() => document.querySelector('#reasoning-fixture .foxwarm-markdown')?.textContent.includes('growing. more'))
      expectPreserved(await readSelection(reasoningSelector, '__reasoningSelection'), selectedReasoning)

      await page.evaluate(() => window.fixture.appendReasoningBlock())
      await page.waitForFunction(() => document.querySelectorAll('#reasoning-fixture .foxwarm-markdown p').length === 3)
      expectPreserved(await readSelection(reasoningSelector, '__reasoningSelection'), selectedReasoning)
    } finally {
      await browser.close()
    }
  })
}
