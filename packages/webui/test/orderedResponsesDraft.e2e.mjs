import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = path.resolve(packageDir, '../..')
const require = createRequire(import.meta.url)
const { collectOpenAIResponsesStream } = require(path.join(root, 'lib/llmProviders/openai.js'))
const { createModelStreamEventEmitter } = require(path.join(root, 'lib/llm.js'))
const { mergeModelStreamDeltaEvents } = require(path.join(root, 'lib/sessionWorkerHost.js'))
const { getModelStreamDraft } = require(path.join(root, 'lib/modelStreamDraft.js'))

const reactFixture = `
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from ${JSON.stringify(path.join(packageDir, 'src/components/ChatTimeline.tsx'))}
  import { applyModelStreamEvent, applyModelStreamSnapshot, buildStreamingAssistantMessage, reconcileCommittedModelDraft } from ${JSON.stringify(path.join(packageDir, 'src/streamingAssistantDraft.ts'))}
  let draft = null
  const committed = []
  const root = createRoot(document.getElementById('root'))
  function render() {
    const synthetic = buildStreamingAssistantMessage(draft)
    root.render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/main', messages: [...committed, ...(synthetic ? [synthetic] : [])],
      isMobile: false, groupTools: false, showUsageBadge: false,
    }))
  }
  window.fixture = {
    install(snapshot) { draft = applyModelStreamSnapshot(snapshot); render() },
    update(event) { draft = applyModelStreamEvent(draft, event); render() },
    commitPrefix(message) { committed.push(message); draft = reconcileCommittedModelDraft(draft, message); render() },
    commit(message) { committed.push(message); draft = null; render() },
    parts() { return buildStreamingAssistantMessage(draft)?.parts },
  }
  render()
`

async function emitSseFrames() {
  const frames = new PassThrough()
  const events = []
  const emitter = createModelStreamEventEmitter({
    enabled: true, sessionId: 'browser-fixture/main', iteration: 0,
    llmRequestId: 'browser-fixture-request',
    currentSessionEffects: { notifySessionEvent: (_id, event) => events.push(event) },
  })
  emitter.reset()
  const collecting = collectOpenAIResponsesStream(frames, new AbortController().signal, {
    onProgress: snapshot => { emitter.emit(snapshot); emitter.flush() },
  })
  const frame = event => frames.write(`data: ${JSON.stringify(event)}\n\n`)
  frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } })
  frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Before drawing' })
  frame({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } })
  frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Drawing' })
  await new Promise(resolve => setImmediate(resolve))
  const snapshot = getModelStreamDraft('browser-fixture/main')
  assert.ok(snapshot?.parts?.length)
  emitter.commitPrefix(2)
  frame({ type: 'response.output_item.added', output_index: 2, item: { type: 'image_generation_call', status: 'in_progress' } })
  frame({ type: 'response.image_generation_call.generating', output_index: 2 })
  frame({ type: 'response.reasoning_summary_text.delta', output_index: 3, summary_index: 0, delta: 'After drawing' })
  frame({ type: 'response.output_item.added', output_index: 4, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } })
  frame({ type: 'response.output_text.delta', output_index: 4, content_index: 0, delta: 'Done' })
  frame({ type: 'response.completed', response: { id: 'synthetic', output: [], usage: { input_tokens: 1, output_tokens: 2 } } })
  frames.end()
  const completed = await collecting
  const lateSnapshot = getModelStreamDraft('browser-fixture/main')
  emitter.close()
  const trim = events.find(event => event.type === 'model-stream-update' && event.trimBeforeOutputIndex === 2)
  assert.ok(trim)
  const tail = events.filter(event => event.type === 'model-stream-update' && event.sequence > trim.sequence)
  const mergedTail = tail.reduce((previous, next) => mergeModelStreamDeltaEvents(previous, next), undefined)
  return { snapshot, trim, mergedTail, lateSnapshot, completed }
}

test('actual Responses SSE stream preserves browser reasoning boundaries across snapshot and canonical commit', async () => {
  const { snapshot, trim, mergedTail, lateSnapshot, completed } = await emitSseFrames()
  const bundle = await build({
    stdin: { contents: reactFixture, resolveDir: packageDir, sourcefile: 'ordered-responses-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
    await page.evaluate(snapshot => window.fixture.install(snapshot), snapshot)
    await page.waitForFunction(() => document.querySelector('[data-model-thread-card="reasoning"]'))
    assert.deepEqual(await page.evaluate(() => window.fixture.parts().map(part => part.thinking || part.text)),
      ['Before drawing', 'Drawing'])
    const prefix = { role: 'model', __meta: { seq: 1, timestamp: Date.now(), llmRequestId: 'browser-fixture-request',
      llmSegment: { outputStart: 0, outputEndExclusive: 2, complete: false } },
    parts: [{ thinking: 'Before drawing' }, { text: 'Drawing', phase: 'commentary' }] }
    await page.evaluate(message => window.fixture.commitPrefix(message), prefix)
    assert.equal(await page.evaluate(() => window.fixture.parts()), undefined)
    await page.evaluate(event => window.fixture.update(event), trim)
    await page.evaluate(event => window.fixture.update(event), mergedTail)
    await page.waitForFunction(() => document.querySelectorAll('[data-model-thread-card="reasoning"]').length === 2)
    assert.deepEqual(await page.evaluate(() => window.fixture.parts().map(part => part.thinking || part.text || part.system)),
      ['Generating image…', 'After drawing', 'Done'])
    // A late subscriber receives the already committed history row and only
    // the owner snapshot's uncommitted suffix; buffered covered deltas stay ignored.
    await page.evaluate(snapshot => window.fixture.install(snapshot), lateSnapshot)
    await page.evaluate(event => window.fixture.update(event), mergedTail)
    assert.deepEqual(await page.evaluate(() => window.fixture.parts().map(part => part.thinking || part.text || part.system)),
      ['Generating image…', 'After drawing', 'Done'])
    const final = { role: 'model', __meta: { seq: 2, timestamp: Date.now(), llmRequestId: 'browser-fixture-request' }, parts: [
      { thinking: completed.output[3].summary[0].text }, { text: completed.output[4].content[0].text, phase: 'final_answer' },
    ] }
    final.__meta.llmSegment = { outputStart: 2, outputEndExclusive: 5, complete: true }
    await page.evaluate(message => window.fixture.commit(message), final)
    await page.waitForFunction(() => document.querySelector('[data-chat-message-anchor-key="seq-local-2"]'))
    assert.equal(await page.$$eval('[data-model-thread-card="reasoning"]', nodes => nodes.length), 2)
    assert.equal(await page.$$eval('.foxwarm-assistant-message-card', nodes => nodes.filter(node => node.textContent.includes('Drawing')).length), 1)
    assert.equal(await page.$$eval('.foxwarm-assistant-message-card', nodes => nodes.filter(node => node.textContent.includes('Done')).length), 1)
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
