import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import express from 'express'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'
const require=createRequire(import.meta.url)
const {HttpServer}=require('../../../lib/httpServer.js')
const {registerWebUiFileDownloads}=require('../../../lib/channels/webuiFileDownloads.js')
const dir=await mkdtemp(path.join(tmpdir(),'reply-file-browser-'))
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
const downloadRequests=[],signRequests=[]
let server,browser,url
const receipt=(id,name='report.png',extra={})=>({version:1,deliveryId:id,targetKind:'session',targetId:'demo/main',fileName:name,mimeType:name.endsWith('.png')?'image/png':'application/pdf',sizeBytes:2048,downloadPath:path.join(dir,name),downloadNodeId:'master',sourceNodeId:'remote-a',...extra})
const messages=[
 {role:'user',parts:[{text:'Create a report.'}],__meta:{seq:1}},
 {role:'model',parts:[{functionCall:{id:'send-a',name:'send_file',args:{filePath:'report.png'}}}],__meta:{seq:2}},
 {role:'tool',parts:[{functionResponse:{tool_use_id:'send-a',name:'send_file',response:{fullPath:path.join(dir,'report.png'),fileDelivery:receipt('one')}}}],__meta:{seq:3}},
 {role:'model',parts:[{text:'The first report is ready.',providerMeta:{openaiResponses:{outputItem:{phase:'final_answer'}}}}],__meta:{seq:4}},
 {role:'user',parts:[{text:'Add the supporting notes.'}],__meta:{seq:5}},
 {role:'model',parts:[{functionCall:{id:'send-b',name:'send_file',args:{filePath:'notes.pdf'}}}],__meta:{seq:6}},
 {role:'tool',parts:[{functionResponse:{tool_use_id:'send-b',name:'send_file',response:{fullPath:path.join(dir,'notes.pdf'),fileDelivery:receipt('two','notes.pdf')}}}],__meta:{seq:7}},
 {role:'model',parts:[{text:'The supporting notes are ready.',providerMeta:{openaiResponses:{outputItem:{phase:'final_answer'}}}}],__meta:{seq:8}},
]
before(async()=>{
 const cssName=(await readdir(new URL('../dist/assets/',import.meta.url))).find(name=>/^index-.*\.css$/.test(name))
 const css=await readFile(new URL('../dist/assets/'+cssName,import.meta.url),'utf8')
 const bundle=await build({stdin:{contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import ChatTimeline from './src/components/ChatTimeline';import{initializeThemeRuntime}from'./src/theme';initializeThemeRuntime();
 const initial=${JSON.stringify(messages)};
 function Fixture(){const[messages,setMessages]=useState(initial),[view,setView]=useState('conversation');window.fixture={messages:()=>messages,setView,tail:()=>setMessages(initial.slice(0,-1)),finish:()=>setMessages([...initial.slice(0,-1),{role:'model',parts:[{text:'Updated final reply.',providerMeta:{openaiResponses:{outputItem:{phase:'final_answer'}}}}],__meta:{seq:8}}]),missing:()=>setMessages([...initial,{role:'model',parts:[{functionCall:{id:'missing',name:'send_file',args:{filePath:'missing.pdf'}}}]},{role:'tool',parts:[{functionResponse:{tool_use_id:'missing',name:'send_file',response:{fileDelivery:${JSON.stringify(receipt('missing','missing.pdf'))}}}}]}]),duplicate:()=>setMessages([...initial,initial[6]])};return <ChatTimeline sessionId="demo/main" messages={messages} historyMessages={messages} timelineView={view} showUsageBadge={false} showTimeDividers={false} isMobile={innerWidth<768} renderMessageFooter={()=> <div data-queue-marker>1 queued</div>}/>};createRoot(document.getElementById('root')).render(<Fixture/>);
 `,loader:'tsx',resolveDir:new URL('..',import.meta.url).pathname},bundle:true,platform:'browser',format:'esm',write:false,jsx:'automatic'})
 await writeFile(path.join(dir,'report.png'),png)
 await writeFile(path.join(dir,'notes.pdf'),'downloaded supporting notes')
 const backend=new HttpServer(0,'synthetic-browser-download')
 backend.app.use((req,_res,next)=>{
  const record={method:req.method,cookie:req.headers.cookie||'',url:req.originalUrl}
  if(req.path==='/download')downloadRequests.push(record)
  if(req.path==='/api/download/sign')signRequests.push(record)
  next()
 })
 registerWebUiFileDownloads(backend,'synthetic-browser-download')
 backend.app.get('/fixture.css',(_req,res)=>res.type('css').send(css))
 backend.app.get('/fixture.js',(_req,res)=>res.type('js').send(bundle.outputFiles[0].text))
 backend.app.get('/',(_req,res)=>res.type('html').send('<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;background:var(--foxwarm-color-canvas);color:var(--foxwarm-color-text)"><main id="root" style="padding:16px;max-width:1000px"></main><script type="module" src="fixture.js"></script></body></html>'))
 const app=express();app.use('/nested',backend.app)
 server=createServer(app)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}/nested/`
 browser=await puppeteer.launch({executablePath:process.env.FOXWARM_E2E_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
})
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve));await rm(dir,{recursive:true,force:true})})
async function newPage(){const page=await browser.newPage();await page.setCookie({name:'foxwarm_token',value:'synthetic-browser-download',url});return page}

test('reply files remain visible outside Conversation process, in their own turns, on desktop/mobile and after reload/view changes',async()=>{
 for(const width of[1100,390]){
  const page=await newPage();await page.setViewport({width,height:900});await page.goto(url)
  try{
   await page.waitForSelector('[data-reply-files]');assert.equal((await page.$$('[data-reply-files]')).length,2)
   assert.equal(await page.$('[data-activity-details]'),null)
   const positions=await page.evaluate(()=>[...document.querySelectorAll('[data-reply-files]')].map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,width:el.scrollWidth,available:innerWidth-32})))
   assert.ok(positions.every(x=>x.width<=x.available));assert.ok(positions[0].bottom<positions[1].top)
   await page.waitForFunction(()=>document.querySelector('.reply-file-thumbnail img')?.naturalWidth>0)
   if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+`/reply-files-${width}.png`})}
   await page.click('[aria-label="Preview report.png"]');await page.waitForSelector('[data-image-preview][open]')
   assert.equal(await page.$eval('[data-image-preview]',el=>Math.abs(el.getBoundingClientRect().width-innerWidth)<1&&Math.abs(el.getBoundingClientRect().height-innerHeight)<1),true,'reply images use the same full-viewport viewer on desktop/mobile')
   await page.click('[aria-label="Close image preview"]');await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
   await page.evaluate(()=>window.fixture.setView('detailed'));await page.waitForFunction(()=>document.querySelectorAll('[data-delivery-id]').length===2)
   await page.evaluate(()=>window.fixture.setView('grouped'));await page.waitForFunction(()=>document.querySelectorAll('[data-delivery-id]').length===2)
   await page.reload();await page.waitForSelector('[data-reply-files]');assert.equal((await page.$$('[data-delivery-id]')).length,2)
  }finally{await page.close()}
 }
})
test('live file grids survive final reply arrival with an open preview; native focus, Escape and downloads remain usable',async()=>{
 const page=await newPage();await page.goto(url)
 try{
  await page.waitForSelector('[data-delivery-id="one"]');await page.evaluate(()=>window.fixture.tail())
  await page.waitForFunction(()=>!document.body.textContent.includes('supporting notes are ready'))
  await page.evaluate(()=>window.originalGrid=document.querySelector('[data-delivery-id="two"]').parentElement)
  await page.click('[aria-label="Preview report.png"]');await page.waitForSelector('dialog[open]');assert.equal(await page.$eval('dialog',el=>el.contains(document.activeElement)),true)
  await page.evaluate(()=>window.fixture.finish());await page.waitForFunction(()=>document.body.textContent.includes('Updated final reply.'))
  assert.equal(await page.evaluate(()=>window.originalGrid===document.querySelector('[data-delivery-id="two"]').parentElement),true)
  assert.ok(await page.$('dialog[open]'))
  await page.keyboard.press('Escape');await page.waitForSelector('dialog',{hidden:true});assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Preview report.png')
  await page.evaluate(()=>window.fixture.duplicate());await page.waitForFunction(()=>document.querySelectorAll('[data-delivery-id]').length===2)
  await page.evaluate(()=>{HTMLAnchorElement.prototype.click=function(){window.downloaded={href:this.href,name:this.download}}})
  await page.click('[aria-label="Download notes.pdf"]');await page.waitForFunction(()=>window.downloaded?.name==='notes.pdf');assert.match((await page.evaluate(()=>window.downloaded.href)),/filename=notes.pdf/)
  await page.evaluate(()=>window.fixture.missing());await page.waitForSelector('[data-delivery-id="missing"]')
  await page.click('[aria-label="Download missing.pdf"]');await page.waitForFunction(()=>[...document.querySelectorAll('[role=alert]')].some(el=>el.textContent==='File unavailable'))
  assert.equal(page.url(),url)
  assert.ok(await page.$('[data-queue-marker]'))
 }finally{await page.close()}
})

test('page issuance leads to an actual native browser download with no cookie under a deployment prefix',async()=>{
 const page=await newPage()
 const client=await browser.target().createCDPSession()
 const network=await page.createCDPSession()
 const downloads=path.join(dir,'downloads');await mkdir(downloads)
 await client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true})
 try{
  await page.goto(url);await page.waitForSelector('[aria-label="Download notes.pdf"]')
  const before=signRequests.length
  // Deliver the authenticated issuance response only after removing the cookie,
  // reproducing a browser download context that does not carry login credentials.
  await network.send('Fetch.enable',{patterns:[{urlPattern:'*/api/download/sign',requestStage:'Response'}]})
  network.on('Fetch.requestPaused',async event=>{
   await page.deleteCookie({name:'foxwarm_token',url})
   await network.send('Fetch.continueRequest',{requestId:event.requestId})
  })
  const completed=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Native download did not finish')),10000)
   const progress=event=>{if(event.state==='completed'){clearTimeout(timer);client.off('Browser.downloadProgress',progress);resolve()}else if(event.state==='canceled'){clearTimeout(timer);reject(new Error('Native download canceled'))}}
   client.on('Browser.downloadProgress',progress)
  })
  await page.click('[aria-label="Download notes.pdf"]');await completed
  assert.equal(await readFile(path.join(downloads,'notes.pdf'),'utf8'),'downloaded supporting notes')
  assert.equal(signRequests.length,before+1)
  assert.ok(signRequests.at(-1).cookie.includes('foxwarm_token=synthetic-browser-download'))
  const request=downloadRequests.findLast(item=>item.url.includes('signature=')&&item.method==='GET')
  assert.ok(request);assert.equal(request.cookie,'');assert.ok(request.url.startsWith('/nested/download?'))
  assert.equal(page.url(),url)
  // Download grants are action-local; the timeline input remains canonical.
  assert.equal(await page.evaluate(()=>JSON.stringify(window.fixture.messages()).includes('signature=')),false)
 }finally{await page.close();await client.send('Browser.setDownloadBehavior',{behavior:'default'});await client.detach()}
})

test('the expanded tool download action also requests a fresh signed URL',async()=>{
 const page=await newPage();await page.goto(url)
 try{
  await page.evaluate(()=>window.fixture.setView('detailed'))
  await page.waitForSelector('button[title="Download notes.pdf"]')
  await page.evaluate(()=>{HTMLAnchorElement.prototype.click=function(){window.downloaded={href:this.href,name:this.download}}})
  const before=signRequests.length
  await page.click('button[title="Download notes.pdf"]')
  await page.waitForFunction(()=>window.downloaded?.href.includes('signature='))
  assert.equal(signRequests.length,before+1)
  const signed=await page.evaluate(()=>window.downloaded.href)
  const response=await fetch(signed)
  assert.equal(response.status,200);assert.equal(await response.text(),'downloaded supporting notes')
 }finally{await page.close()}
})
