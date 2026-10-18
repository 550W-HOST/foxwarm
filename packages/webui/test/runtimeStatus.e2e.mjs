import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import { webuiReactAliases } from './reactRendererAliases.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, url
before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const bundle = await build({
    stdin: { contents: `
      import React, { StrictMode, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import ProcessingStatus from './src/components/ProcessingStatus'
      import SystemEventCard from './src/components/SystemEventCard'
      import { initializeThemeRuntime } from './src/theme'
      initializeThemeRuntime()
      const active = (state, extra = {}) => ({ state, queueLength: 0, busy: ['requesting-model','running-tool'].includes(state), ...extra })
      const examples = [
        ['request', active('requesting-model', {active: {phase: 'normal-turn', modelKey: 'Demo model'}})],
        ['tool', active('running-tool', {tool: {name: 'exec', source: 'node', executionNode: 'compute-node', argsPreview: 'python benchmark.py', startedAt: 1, index: 0, total: 2}})],
        ['read', active('running-tool', {tool: {name: 'read', source: 'node', target: 'report.md', executionNode: 'master', argsPreview: 'docs/report.md', startedAt: 1}})],
        ['compact', active('requesting-model', {active: {phase: 'compaction'}, compaction: {operationId: 'demo', phase: 'planning', background: false}})],
        ['waiting', active('waiting', {waiting: {waitId: 'demo-wait', waitingFor: 'all-sessions', waitAllSessions: ['analysis','review'], satisfiedSessions: [], pendingSessions: ['analysis','review'], reason: 'Review results'}})],
        ['retry', active('requesting-model', {retry: {attempt: 1, nextAttempt: 2, maxAttempts: 6, retryAt: Date.now()+60000, reason: 'Temporary connection error'}})],
        ['stopping', active('running-tool', {stopping: true})],
        ['interrupted', active('idle')],
        ['error', active('idle')],
        ['unknown', active('requesting-model', {active: {phase: 'unknown'}, note: 'The current phase is unavailable.'})],
      ]
      function Fixture() {
        const [pending, setPending] = useState(null)
        window.fixture.setPending = setPending
        return <main className="p-6 mx-auto max-w-5xl">
          <h1 className="text-lg font-medium mb-2">Runtime status</h1>
          <div className="runtime-examples grid grid-cols-1 gap-x-12 gap-y-2">
            {examples.map(([id, state]) => <div key={id} data-example={id} className="min-w-0">
              <ProcessingStatus sessionBusy={state.busy} runtimeState={state} sessionQueueLength={0} turnIncomplete={id==='interrupted'||id==='error'} loading={false}
                isMobile={innerWidth<768} timelineView="conversation" pendingControl={id==='tool'?pending:null}
                failure={id==='error'?{title:'Request failed',details:'The connection closed before the response completed.'}:null}
                onContinue={() => window.fixture.continues++} onCancelCompaction={() => window.fixture.cancels++} />
            </div>)}
          </div>
          <h2 className="text-lg font-medium mt-8 mb-4">System event</h2>
          <SystemEventCard notice={{version:1,id:'demo-error',source:'compaction',severity:'error',title:'Compaction failed',summary:'Could not prepare a compaction plan.',details:'No valid compaction plan was produced after 15 planning rounds.\\nThe supplied segments do not contain a legal merge range.'}} />
          <button id="after" className="mt-3">Next control</button>
        </main>
      }
      window.fixture = {continues:0,cancels:0}
      createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>)
    `, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'runtime-status-fixture.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    alias: webuiReactAliases, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'})
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}@media(min-width:700px){.runtime-examples{grid-template-columns:repeat(2,minmax(0,1fr))}}body{background:var(--foxwarm-color-canvas);color:var(--foxwarm-color-text);font-family:system-ui}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}`
  browser=await puppeteer.launch({executablePath:process.env.FOXWARM_E2E_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
})
after(async()=>{await browser?.close();if(server) await new Promise(resolve=>server.close(resolve))})
async function open(width=1100,reduced=false){const page=await browser.newPage();await page.setViewport({width,height:1000});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]);await page.goto(url);await page.waitForSelector('[data-example="tool"] [data-runtime-fox="tool"]');return page}

test('semantic model/tool colors, distinct poses and explicit execution labels',async()=>{
 const page=await open()
 try{
  const result=await page.evaluate(()=>{
   const get=id=>{const el=document.querySelector('[data-example="'+id+'"] [data-runtime-presentation]');return {kind:el.dataset.runtimePresentation,color:getComputedStyle(el.querySelector('button,div:not(.sr-only)')).color,text:el.textContent}}
   return {model:get('request'),tool:get('tool'),read:get('read'),compact:get('compact'),waiting:get('waiting'),retry:get('retry'),stopping:get('stopping'),idle:get('interrupted'),error:get('error'),unknown:get('unknown'),overflow:document.documentElement.scrollWidth>innerWidth}
  })
  assert.equal(result.model.kind,'request');assert.equal(result.tool.kind,'tool');assert.notEqual(result.model.color,result.tool.color)
  assert.match(result.tool.text,/Executing exec/);assert.match(result.read.text,/Reading report.md/);assert.equal(result.compact.kind,'compact');assert.match(result.waiting.text,/Waiting for 2 sessions/)
  assert.equal(result.retry.kind,'retry');assert.equal(result.stopping.kind,'stopping');assert.equal(result.idle.kind,'interrupted');assert.equal(result.error.kind,'error');assert.equal(result.unknown.kind,'unknown');assert.equal(result.overflow,false)
  if(process.env.FOXWARM_RUNTIME_ARTIFACT_DIR){await mkdir(process.env.FOXWARM_RUNTIME_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_RUNTIME_ARTIFACT_DIR+'/runtime-status-desktop.png',fullPage:true})}
 }finally{await page.close()}
})

test('runtime details work by keyboard, keep real tool identity, cancel explicitly, and restore focus',async()=>{
 const page=await open()
 try{
  await page.focus('[data-example="tool"] button[aria-haspopup="dialog"]');await page.keyboard.press('Enter');await page.waitForSelector('[data-runtime-details]')
  const content=await page.$eval('[data-runtime-details]',el=>el.innerText);assert.match(content,/compute-node/);assert.match(content,/python benchmark.py/);assert.match(content,/1\/2/)
  await page.waitForFunction(()=>document.activeElement===document.querySelector('[data-runtime-details]'))
  assert.equal(await page.$eval('[data-runtime-details]',el=>document.activeElement===el),true)
  await page.keyboard.press('Escape');assert.equal(await page.$('[data-runtime-details]'),null);assert.equal(await page.$eval('[data-example="tool"] button',el=>document.activeElement===el),true)
  await page.click('[data-example="compact"] button');await page.waitForSelector('[data-runtime-details]');await page.click('[data-runtime-details] button');assert.equal(await page.evaluate(()=>window.fixture.cancels),1)
 }finally{await page.close()}
})

test('system errors have their own static block with collapsed native diagnostics',async()=>{
 const page=await open(390)
 try{
  assert.equal(await page.$eval('[data-event-details]',el=>el.open),false)
  assert.equal(await page.$eval('[data-system-event]',el=>el.getAnimations({subtree:true}).length),0)
  await page.focus('[data-event-details] summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('[data-event-details]',el=>el.open),true)
  assert.match(await page.$eval('[data-event-details] pre',el=>el.textContent),/15 planning rounds/)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  if(process.env.FOXWARM_RUNTIME_ARTIFACT_DIR)await page.screenshot({path:process.env.FOXWARM_RUNTIME_ARTIFACT_DIR+'/runtime-status-mobile.png',fullPage:true})
 }finally{await page.close()}
})

test('reduced motion disables every pose without dropping the status or actions',async()=>{
 const page=await open(390,true)
 try{
  assert.equal(await page.evaluate(()=>Array.from(document.querySelectorAll('[data-runtime-fox]')).flatMap(el=>el.getAnimations({subtree:true})).filter(a=>a.playState==='running').length),0)
  assert.match(await page.$eval('[data-example="waiting"]',el=>el.innerText),/Waiting for 2 sessions/)
  await page.click('[data-example="interrupted"] button');assert.equal(await page.evaluate(()=>window.fixture.continues),1)
 }finally{await page.close()}
})
