import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,readdir,mkdir,mkdtemp,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {build} from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'
const require=createRequire(import.meta.url)
const {prepareArtifact}=require('../../../lib/artifacts/prepare.js')
let server,browser,url
const records=new Map()
const receipt=(id,type,title)=>({protocolVersion:1,artifactId:`art_${id.repeat(32)}`,revision:1,sessionId:'demo/main',type,title})
const chart=JSON.parse(await readFile(new URL('../../../skills/data-visualization/examples/training-metrics.json',import.meta.url),'utf8'))
const react=JSON.parse(await readFile(new URL('../../../skills/react-artifacts/examples/sorting.json',import.meta.url),'utf8'))
const refs=[receipt('a','chart',chart.title),receipt('b','react',react.title)]
const imageRef=receipt('c','image','Geometric illustration')
let png
const marker=r=>`<foxwarm-artifact id="${r.artifactId}" revision="${r.revision}" />`
const inlineText=`Before the chart.\n\n${marker(refs[0])}\n\nBetween chart and image.\n\n${marker(imageRef)}\n\nBefore the animation.\n\n${marker(refs[1])}\n\nAfter all figures.`
const messages=[{role:'user',parts:[{text:'Show training metrics and an interactive sorting demonstration.'}],__meta:{seq:1}},...refs.flatMap((r,i)=>[
 {role:'model',parts:[{functionCall:{id:`a${i}`,name:'artifact',args:{action:'publish',filePath:'manifest.json'}}}],__meta:{seq:i*2+2}},
 {role:'tool',parts:[{functionResponse:{name:'artifact',tool_use_id:`a${i}`,response:{output:'Published',artifact:r}}}],__meta:{seq:i*2+3}},
]),{role:'model',parts:[{text:'Explore the data and step through the algorithm.'}],__meta:{seq:6}}]
before(async()=>{
 png=await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"><g font-family="sans-serif" text-anchor="middle"><rect x="20" y="35" width="220" height="150" rx="14" fill="#e7effd"/><text x="130" y="110" font-size="24" fill="#35517a">Input data</text><text x="130" y="145" font-size="15" fill="#627897">Snapshot</text><path d="M270 110h55m-12-9 12 9-12 9" fill="none" stroke="#8b9aad" stroke-width="3"/><rect x="340" y="35" width="220" height="150" rx="14" fill="#eee9fb"/><text x="450" y="110" font-size="24" fill="#5d4a89">Analysis</text><text x="450" y="145" font-size="15" fill="#807198">Figure + explanation</text><path d="M590 110h55m-12-9 12 9-12 9" fill="none" stroke="#8b9aad" stroke-width="3"/><rect x="660" y="35" width="220" height="150" rx="14" fill="#e4f4ec"/><text x="770" y="110" font-size="24" fill="#426d55">Result</text><text x="770" y="145" font-size="15" fill="#718e7d">Continue the prose</text></g></svg>')).png().toBuffer()

 records.set(refs[0].artifactId,{receipt:refs[0],createdAt:'2026-01-01T00:00:00Z',document:chart})
 records.set(refs[1].artifactId,{receipt:refs[1],createdAt:'2026-01-01T00:00:00Z',document:react,...await prepareArtifact(react)})
 const hostile={type:'react',schemaVersion:1,title:'Sandbox probe',entry:'App.tsx',files:{'App.tsx':`import React,{useEffect,useState} from 'react';export default function App(){const [count,set]=useState(0);useEffect(()=>{let isolated=false,storage=false;try{void parent.document.body}catch{isolated=true}try{localStorage.getItem('foxwarm_token')}catch{storage=true}document.body.dataset.isolated=String(isolated&&storage);fetch('https://artifact-denied.invalid/probe').catch(()=>{document.body.dataset.network='blocked'})},[]);return <div><button id="count" onClick={()=>set(count+1)}>{count}</button><button id="navigate" onClick={()=>location.href='https://artifact-denied.invalid/navigation'}>Navigate</button></div>}`}}
 records.set(imageRef.artifactId,{receipt:imageRef,document:{type:'image',schemaVersion:1,title:imageRef.title,mimeType:'image/png',width:900,height:220,alt:'A synthetic illustration'},resources:{image:{mimeType:'image/png',sizeBytes:png.length}}})
 records.set('hostile',{receipt:refs[1],document:hostile,...await prepareArtifact(hostile)})
 const css=(await readdir(new URL('../dist/assets/',import.meta.url))).find(n=>/^index-.*\.css$/.test(n))
 const styles=await readFile(new URL('../dist/assets/'+css,import.meta.url),'utf8')
 const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import ChatTimeline from './src/components/ChatTimeline';import{initializeThemeRuntime}from'./src/theme';initializeThemeRuntime();const initial=${JSON.stringify(messages)};function Fixture(){const [messages,set]=useState(initial),[view,setView]=useState('conversation');window.fixture={setView,setMessages:set,inline:()=>set([{role:'user',parts:[{text:'Inline examples'}],__meta:{seq:10}},{role:'tool',parts:[{functionResponse:{name:'artifact',response:{preparedArtifact:${JSON.stringify(imageRef)},marker:${JSON.stringify(marker(imageRef))}}}}],__meta:{seq:11}},{role:'model',parts:[{text:${JSON.stringify(inlineText)}}],__meta:{seq:12}}]),finish:()=>set([...initial.slice(0,-1),{role:'model',parts:[{text:'Updated final text.'}],__meta:{seq:6}}])};return <ChatTimeline sessionId="demo/main" messages={messages} historyMessages={messages} timelineView={view} showUsageBadge={false} showTimeDividers={false} isMobile={innerWidth<768}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:new URL('..',import.meta.url).pathname},bundle:true,platform:'browser',format:'esm',write:false,jsx:'automatic'})
 server=createServer((req,res)=>{
  if(req.url==='/nested/fixture.css'){res.setHeader('Content-Type','text/css');return res.end(styles)}
  if(req.url==='/nested/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text)}
  if(req.url.endsWith('/resources/image')){res.setHeader('Content-Type','image/png');return res.end(png)}
  if(req.url.includes('/api/sessions/')){let r=records.get(req.url.split('/').at(-2));if(req.headers.cookie?.includes('hostile=true')&&r?.receipt.type==='react')r=records.get('hostile');res.setHeader('Content-Type','application/json');res.statusCode=r?200:404;return res.end(JSON.stringify(r||{error:'Missing'}))}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;background:var(--foxwarm-color-canvas);color:var(--foxwarm-color-text)"><input id="draft" aria-label="Composer focus fixture" style="position:fixed;bottom:0;left:0;opacity:0;pointer-events:none"><main id="root" style="padding:16px;max-width:1000px;margin:auto"></main><script type="module" src="fixture.js"></script></body></html>')
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/nested/`
 browser=await puppeteer.launch({executablePath:process.env.FOXWARM_E2E_CHROMIUM||'/snap/bin/chromium',headless:true,args:['--no-sandbox']})
})
after(async()=>{await browser?.close();await new Promise(r=>server?.close(r))})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function innerFrame(page,selector='h1') {try { await page.waitForFunction(()=>document.querySelector('iframe[data-ready="true"]'),{timeout:8000}); } catch(e) { console.log('FRAME FAILURE',await page.evaluate(()=>({alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent),iframes:document.querySelectorAll('iframe').length})));for(const f of page.frames())console.log('FRAME',f.url().slice(0,80),await f.evaluate(()=>document.body?.innerText?.slice(0,500)).catch(()=>''));throw e; }const f=page.frames().find(f=>f.url().startsWith('blob:'));if(!f)throw new Error('Inner sandbox not found');await f.waitForSelector(selector);return f}
test('charts and React render in reply across mobile and desktop; native expansion preserves interactive state',async()=>{
 for(const width of[1200,390]){
  const page=await browser.newPage();page.on('console',m=>{if(m.type()==='error')console.log('BROWSER',m.text().slice(0,800))});page.on('pageerror',e=>console.log('PAGE ERROR',e.message));await page.setViewport({width,height:950});await page.goto(url);await page.focus('#draft')
  try{
   await page.waitForSelector('.artifact-chart-plot svg');assert.equal((await page.$$('[data-artifact-id]')).length,2)
   assert.ok(await page.$('.artifact-metrics strong'));assert.equal(await page.evaluate(()=>document.activeElement.id),'draft','inline load must not steal composer focus')
   await page.$eval('[aria-label="Smoothing window"]',el=>{el.value='40';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})
   await page.click('.artifact-range input');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
   await page.$eval('.artifact-react',el=>el.scrollIntoView({block:'center'}));await page.click('.artifact-run-placeholder')
   let f=await innerFrame(page);await f.waitForSelector('button');assert.equal(await f.$eval('h1',el=>el.textContent),'Insertion sort')
   await f.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Step').click());const text=await f.$eval('output',el=>el.textContent)
   const frameId=f._id;await page.evaluate(()=>window.fixture.finish());await sleep(150)
   f=await innerFrame(page);assert.equal(f._id,frameId,'final text does not remount sandbox')
   await page.click('[data-artifact-id="'+refs[1].artifactId+'"] [aria-label="Expand artifact"]')
   f=await innerFrame(page);assert.equal(f._id,frameId,'expand keeps frame instance');assert.equal(await f.$eval('output',el=>el.textContent),text)
   if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+`/react-expanded-${width}.png`})}
   await page.click('[aria-label="Close artifact"]');assert.equal(await page.evaluate(()=>!!document.querySelector('dialog:modal')),false)
   for(const view of['detailed','grouped','conversation']){await page.evaluate(v=>window.fixture.setView(v),view);await sleep(100);assert.equal((await page.$$('[data-artifact-id]')).length,2)}
   await page.reload();await page.waitForSelector('.artifact-chart-plot svg');assert.ok(await page.$('.artifact-run-placeholder'),'reload does not autoexecute React')
   if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true});await (await page.$('.artifact-view')).screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+`/chart-${width}.png`})}
  }finally{await page.close()}
 }
})
test('opaque sandbox cannot read host/storage, fetch or self-navigate to external URLs; interaction still works',async()=>{
 const page=await browser.newPage(),external=[]
 await page.setCookie({name:'hostile',value:'true',url});page.on('request',r=>{if(r.url().startsWith('https://artifact-denied'))external.push(r.url())})
 await page.goto(url);await page.waitForSelector('.artifact-run-placeholder');await page.$eval('.artifact-run-placeholder',el=>el.scrollIntoView());await page.click('.artifact-run-placeholder')
 try{
  const f=await innerFrame(page,'#count');await f.waitForFunction(()=>document.body.dataset.network==='blocked');assert.equal(await f.evaluate(()=>document.body.dataset.isolated),'true')
  await f.click('#count');assert.equal(await f.$eval('#count',el=>el.textContent),'1')
  await page.evaluate(()=>document.documentElement.style.setProperty('--foxwarm-color-accent','#ee7700'))
  await f.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--artifact-accent').trim()==='#ee7700')
  assert.equal(await f.$eval('#count',el=>el.textContent),'1','theme changes preserve interaction state')
  const scroll=await f.evaluate(()=>{const d=document.createElement('div');d.style.height='1600px';document.body.append(d);window.scrollTo(0,200);return{top:document.scrollingElement.scrollTop,width:getComputedStyle(document.documentElement).scrollbarWidth,bar:getComputedStyle(document.documentElement,'::-webkit-scrollbar').display}})
  assert.ok(scroll.top>0);assert.equal(scroll.width,'none');assert.equal(scroll.bar,'none')
  await f.click('#navigate');await sleep(300);assert.deepEqual(external,[]);assert.equal(page.url(),url)
 }finally{await page.deleteCookie({name:'hostile',url});await page.close()}
})

test('source download uses the exact immutable snapshot; native Escape and reduced motion remain usable',async()=>{
 const page=await browser.newPage(),client=await browser.target().createCDPSession()
 const dir=await mkdtemp(path.join(process.env.fw_tmp||os.tmpdir(),'artifact-browser-download-'))
 try{
  await client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir,eventsEnabled:true})
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.goto(url);await page.waitForSelector('.artifact-chart-plot svg')
  const completed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Download timeout')),10000);const listener=e=>{if(e.state==='completed'){clearTimeout(timer);client.off('Browser.downloadProgress',listener);resolve()}};client.on('Browser.downloadProgress',listener)})
  await page.click('.artifact-view [aria-label="Download artifact"]');await completed
  const downloaded=JSON.parse(await readFile(path.join(dir,refs[0].artifactId+'-r1.json'),'utf8'))
  assert.deepEqual(downloaded,chart)
  assert.equal(await page.$('[aria-label="View source"]'),null);assert.equal(await page.$('.artifact-revision'),null);assert.equal(await page.$('.artifact-data'),null);assert.equal(await page.$('.artifact-source'),null)
  await page.click('.artifact-view [aria-label="Expand artifact"]');assert.equal(await page.evaluate(()=>document.activeElement.closest('dialog')?.matches(':modal')),true)
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>!!document.querySelector('dialog:modal')),false)
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Expand artifact')
 }finally{await page.close();await client.detach();await rm(dir,{recursive:true,force:true})}
})

test('desktop cards have balanced gutters and bounded expansion; phone remains edge-to-edge',async()=>{
 for(const width of [1800,1000,390]){
  const page=await browser.newPage();await page.setViewport({width,height:1000});await page.goto(url);await page.waitForSelector('.artifact-chart-plot svg')
  try{
   await page.evaluate(()=>{document.getElementById('root').style.maxWidth='none'})
   await sleep(100)
   const rect=await page.$eval('.artifact-view',el=>{const r=el.getBoundingClientRect(),p=el.closest('.foxwarm-chat-timeline').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,parentLeft:p.left,parentRight:p.right}})
   assert.ok(Math.abs((rect.left-rect.parentLeft)-(rect.parentRight-rect.right))<2)
   if(width>=768){assert.ok(rect.width<=1096);assert.ok(rect.left-rect.parentLeft>=12)}
   else assert.ok(rect.width>=width-34)
   await page.click('.artifact-view [aria-label="Expand artifact"]')
   const expanded=await page.$eval('dialog:modal',el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width}})
   assert.equal(await page.$eval('dialog:modal',el=>getComputedStyle(el).scrollbarWidth),'none')
   if(width>=768){assert.ok(expanded.width<=1281);assert.ok(expanded.left>=31);assert.ok(Math.abs(expanded.left-(width-expanded.right))<2)}
   else assert.equal(expanded.width,width)
  }finally{await page.close()}
 }
})

test('body references interleave chart/image/React with prose, keep stream state and reuse the full-screen image viewer',async()=>{
 const page=await browser.newPage();await page.setViewport({width:1200,height:1000});await page.goto(url);await page.waitForSelector('.artifact-chart-plot svg')
 try{
  await page.evaluate(()=>window.fixture.inline());await page.waitForSelector('.artifact-image-preview img')
  await page.waitForFunction(()=>document.querySelector('.artifact-image-preview img')?.naturalWidth>0)
  assert.equal((await page.$$('[data-artifact-id]')).length,3)
  const order=await page.evaluate(()=>[...document.querySelector('.foxwarm-assistant-message-markdown').querySelectorAll('.foxwarm-markdown-html-segment,[data-artifact-id]')].map(el=>el.dataset.artifactId||el.textContent.trim()).filter(Boolean))
  // Verify DOM position rather than relying on CSS order or reply-end projection.
  assert.equal(await page.evaluate(()=>{const root=document.querySelector('.foxwarm-assistant-message-markdown');const text=root.textContent;return text.indexOf('Before the chart.')<text.indexOf('Training success rate')&&text.indexOf('Training success rate')<text.indexOf('Between chart and image.')&&!!root.querySelector('.artifact-image-preview')&&text.indexOf('Insertion sort playground')<text.indexOf('After all figures.')}),true,JSON.stringify(order))
  for(const width of[1200,390]){
   await page.setViewport({width,height:1000})
   const appearance=await page.$eval('[data-artifact-id="'+imageRef.artifactId+'"]',el=>{const s=getComputedStyle(el),button=el.querySelector('.artifact-image-preview');return{border:s.borderTopWidth,padding:s.padding,background:s.backgroundColor,header:!!el.querySelector(':scope > header'),buttonBackground:getComputedStyle(button).backgroundColor}})
   assert.deepEqual(appearance,{border:'0px',padding:'0px',background:'rgba(0, 0, 0, 0)',header:false,buttonBackground:'rgba(0, 0, 0, 0)'})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  }
  await page.setViewport({width:1200,height:1000})
  await page.click('.artifact-image-preview');await page.waitForSelector('[data-image-preview]');await page.keyboard.press('Escape');await page.waitForSelector('[data-image-preview]',{hidden:true})
  await page.$eval('.artifact-run-placeholder',el=>el.scrollIntoView());await page.click('.artifact-run-placeholder');let frame=await innerFrame(page);const frameId=frame._id
  await page.evaluate(text=>window.fixture.setMessages([{role:'model',parts:[{text}],__meta:{seq:12,streaming:true}}]),inlineText+' More streamed prose.')
  frame=await innerFrame(page);assert.equal(frame._id,frameId)
  await page.evaluate(text=>window.fixture.setMessages([{role:'model',parts:[{text}],__meta:{seq:12}}]),inlineText+' More streamed prose. Final.')
  frame=await innerFrame(page);assert.equal(frame._id,frameId)
  if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){
   await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true})
   await page.evaluate(text=>window.fixture.setMessages([{role:'model',parts:[{text}],__meta:{seq:12}}]),inlineText)
   await page.setViewport({width:1200,height:1800})
   await page.evaluate(()=>{for(const el of document.querySelectorAll('*'))if(el.scrollTop)el.scrollTop=0});await sleep(150)
   const prose=await page.$('.foxwarm-assistant-message-markdown');await prose.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+'/inline-desktop.png'})
  }
  for(const view of['detailed','grouped','conversation']){await page.evaluate(v=>window.fixture.setView(v),view);await sleep(100);assert.equal((await page.$$('[data-artifact-id]')).length,3)}
  await page.evaluate(({text,ref})=>window.fixture.setMessages([{role:'tool',parts:[{functionResponse:{name:'artifact',response:{artifact:ref}}}],__meta:{seq:11}},{role:'model',parts:[{text}],__meta:{seq:12}}]),{text:inlineText,ref:refs[0]})
  assert.equal((await page.$$('[data-artifact-id]')).length,3,'a referenced published card is not duplicated at reply end')
  await page.setViewport({width:390,height:900});await sleep(150);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+'/inline-mobile.png',fullPage:true})}
 }finally{await page.close()}
})
test('user/tool/fenced references are inert and a split stream marker mounts only after it is complete',async()=>{
 const page=await browser.newPage();await page.goto(url);await page.waitForSelector('.artifact-chart-plot svg')
 try{
  await page.evaluate(m=>window.fixture.setMessages([{role:'user',parts:[{text:m}],__meta:{seq:20}},{role:'tool',parts:[{functionResponse:{name:'read',response:{output:m}}}],__meta:{seq:21}},{role:'model',parts:[{text:'```xml\n'+m+'\n```'}],__meta:{seq:22}}]),marker(refs[0]))
  await sleep(100);assert.equal((await page.$$('[data-artifact-id]')).length,0)
  await page.evaluate(m=>window.fixture.setMessages([{role:'model',parts:[{text:'Before.\n\n'+m.slice(0,-5)}],__meta:{seq:23,streaming:true}}]),marker(refs[0]));await sleep(100)
  assert.equal((await page.$$('[data-artifact-id]')).length,0)
  await page.evaluate(m=>window.fixture.setMessages([{role:'model',parts:[{text:'Before.\n\n'+m+'\n\nAfter.'}],__meta:{seq:23}}]),marker(refs[0]));await page.waitForSelector('.artifact-chart-plot svg')
  assert.equal((await page.$$('[data-artifact-id]')).length,1)
 }finally{await page.close()}
})
