import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

let browser, page, server, url
before(async () => {
  const component = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
  const context = new URL('../src/components/ToolCallActivityContext.tsx', import.meta.url).pathname
  const activity = new URL('../src/toolCallActivity.ts', import.meta.url).pathname
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { InterleavedToolGroup } from ${JSON.stringify(component)}
      import { ToolCallActivityContext } from ${JSON.stringify(context)}
      import { applyToolCallActivity } from ${JSON.stringify(activity)}
      const root = createRoot(document.getElementById('root'))
      let activity, running = true, responses = []
      function render() {
        root.render(React.createElement(ToolCallActivityContext.Provider, {value:activity?.runningCallIds},
          React.createElement(InterleavedToolGroup, {
            msg: {role:'model', parts:['a','b','c'].map(id => ({functionCall:{id,name:'exec',args:{command:id}}}))},
            nextMsg: {role:'tool',parts:responses}, messageKeyPrefix:'batch', runningTool:running,
          })))
      }
      window.event = event => { activity = applyToolCallActivity(activity, event); render() }
      window.runtime = value => { running = value; render() }
      window.commit = () => { responses = ['a','b','c'].map(id => ({functionResponse:{tool_use_id:id,name:'exec',response:{output:'result-'+id}}})); render() }
      window.frames = []
      new MutationObserver(() => window.frames.push([...document.querySelectorAll('.foxwarm-tool-card')].map(node => node.textContent.includes('Running...')))).observe(document.getElementById('root'), {subtree:true,childList:true,characterData:true})
    `, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-call-running.tsx' },
    bundle: true, format: 'iife', platform: 'browser', write: false, target: 'chrome120',
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html'}); res.end(`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({executablePath:process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless:true, args:['--no-sandbox']})
  page = await browser.newPage()
})
after(async () => { await browser?.close(); if(server) await new Promise(resolve => server.close(resolve)) })
const snapshot = (runningCallIds, sequence = 0, activityId = 'owner') => ({type:'tool-call-snapshot', activityId, sequence, runningCallIds})
const state = (callId, status, sequence) => ({type:'tool-call-state', activityId:'owner', sequence, callId, status})
async function send(event, expected) {
  await page.evaluate(event => window.event(event), event)
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.foxwarm-tool-card')].map(node => node.textContent.includes('Running...'))) === JSON.stringify(expected), {}, expected)
}
async function running() { return page.$$eval('.foxwarm-tool-card', nodes => nodes.map(node => node.textContent.includes('Running...'))) }

test('sequential dispatch never marks queued or completed calls Running, including runtime transitions', async () => {
  await page.goto(url)
  await send(snapshot([]), [false,false,false])
  await send(state('a','running',1), [true,false,false])
  await send(state('a','finished',2), [false,false,false])
  await page.evaluate(() => window.runtime(false))
  await send(state('b','running',3), [false,true,false])
  await page.evaluate(() => window.runtime(true))
  await send(state('b','finished',4), [false,false,false])
  await send(state('c','running',5), [false,false,true])
  await send(state('c','finished',6), [false,false,false])
  assert.ok((await page.evaluate(() => window.frames)).every(frame => frame.filter(Boolean).length <= 1))
})

test('concurrent exec completion and Stop settle individual calls without reviving them', async () => {
  await page.goto(url)
  await send(snapshot([]), [false,false,false])
  await send(state('a','running',1), [true,false,false])
  await send(state('b','running',2), [true,true,false])
  await send(state('b','finished',3), [true,false,false])
  // The Session-wide runtime may change while the other exec is still dispatched.
  await page.evaluate(() => window.runtime(false))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await running(), [true,false,false])
  // Stop does not start the remaining call; the dispatched call settles first.
  await send(state('a','finished',4), [false,false,false])
  await page.evaluate(() => window.commit())
  await page.waitForFunction(() => document.body.textContent.includes('result-c'))
  assert.deepEqual(await running(), [false,false,false])
})

test('reconnect snapshot covers buffered events and canonical history wins after settlement', async () => {
  await page.goto(url)
  await send(snapshot(['b'],3), [false,true,false])
  await send(state('a','running',1), [false,true,false])
  await send(state('a','finished',2), [false,true,false])
  await send(state('b','running',3), [false,true,false])
  await send(state('b','finished',4), [false,false,false])
  await page.evaluate(() => window.commit())
  await page.waitForFunction(() => document.body.textContent.includes('result-a'))
  // Even a stale activity projection cannot override a canonical response.
  await send(snapshot(['a','b'],0,'replacement-owner'), [false,false,false])
})
