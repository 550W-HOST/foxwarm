import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'
import { readdir, readFile, mkdir } from 'node:fs/promises'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const composerEntry = fileURLToPath(new URL('../src/components/ChatComposer.tsx', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
let browser, server, fixtureUrl

before(async () => {
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { initializeThemeRuntime } from ${JSON.stringify(fileURLToPath(new URL('../src/theme/runtime.ts', import.meta.url)))}
    initializeThemeRuntime()
    import ChatComposer from ${JSON.stringify(composerEntry)}
    window.sentPayloads = []; window.acceptSends = false
    window.fetch = async input => String(input).includes('/commands') ? new Response(JSON.stringify({commands:[]}), {status:200}) : new Response('{}', {status:404})
    function Fixture(){
      const [sessionId,setSessionId]=useState('fixture/a')
      const [running,setRunning]=useState(false); window.fixtureSetRunning=setRunning; window.stops=0
      return <><button data-session="a" onClick={()=>setSessionId('fixture/a')}>A</button><button data-session="b" onClick={()=>setSessionId('fixture/b')}>B</button><div data-active-session>{sessionId}</div><ChatComposer
        sessionId={sessionId} sessionMissing={false} loading={false} sessionRunning={running} onStop={()=>window.stops++} asrAvailable={false} modelOptions={[]}
        onChangeModel={async()=>{}} onChangeChildModel={async()=>{}} onChangeEffort={async()=>{}} onChangeChildEffort={async()=>{}} onRefreshModels={async()=>{}} onOpenModelSettings={()=>{}}
        onSend={async payload=>{window.sentPayloads.push({sessionId, refs:payload.attachments.map(item=>item.ref), names:payload.attachments.map(item=>item.file.name), text:payload.text}); return window.acceptSends}}
        onTranscribeAudio={async()=>({text:'',status:200,rawLength:0,textLength:0,responsePreview:''})} onCreateStreamingTranscriber={async()=>({sendAudioChunk(){},stop(){},cancel(){}})} /></>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const result = await build({ stdin:{contents:source,resolveDir:packageDir,sourcefile:'fixture.tsx',loader:'tsx'}, bundle:true, format:'iife', platform:'browser', target:'chrome120', write:false, define:{'process.env.NODE_ENV':JSON.stringify('test')}, logLevel:'silent' })
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${result.outputFiles[0].text}</script>`)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); fixtureUrl=`http://127.0.0.1:${server.address().port}`
  browser=await puppeteer.launch({executablePath:chromiumPath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox']})
})
after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve))})

async function upload(page,name,body){await page.$eval('#file-upload',(input,payload)=>{const transfer=new DataTransfer();transfer.items.add(new File([payload.body],payload.name,{type:'text/plain'}));Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('change',{bubbles:true}))},{name,body});await page.waitForFunction(()=>document.querySelectorAll('.foxwarm-composer-attachment-chip').length>0)}
test('inline attachment refs preserve File identity by Session and clear only after accepted send', async()=>{
  const page=await browser.newPage();await page.goto(fixtureUrl,{waitUntil:'load'})
  const editor='[role="textbox"][aria-label="Message"]'
  await page.type(editor,'before after')
  await page.evaluate(()=>{
    const root=document.querySelector('[role="textbox"][aria-label="Message"]');const text=[...root.childNodes].find(node=>node.nodeType===Node.TEXT_NODE)
    const range=document.createRange();range.setStart(text,7);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
  })
  await upload(page,'duplicate.txt','first')
  const firstRef=await page.$eval('.foxwarm-composer-attachment-chip',node=>node.dataset.composerAttachmentRef)
  assert.equal(firstRef,'attachment1')
  assert.match(await page.evaluate(()=>localStorage.getItem('composer_draft_v1_fixture/a')),new RegExp(firstRef))
  assert.equal(await page.evaluate(()=>window.sentPayloads.length),0)
  assert.equal(await page.evaluate(()=>document.querySelector('button[aria-label="Send message"]').disabled),false)

  await page.click('[data-session="b"]');await page.waitForFunction(()=>document.querySelector('[data-active-session]').textContent==='fixture/b'&&document.querySelector('[role="textbox"]')?.textContent==='')
  await page.click('[data-session="a"]');await page.waitForFunction(ref=>document.querySelector('.foxwarm-composer-attachment-chip')?.dataset.composerAttachmentRef===ref,{},firstRef)

  await page.click('button[aria-label="Send message"]');await page.waitForFunction(()=>window.sentPayloads.length===1)
  assert.deepEqual(await page.evaluate(()=>window.sentPayloads[0].names),['duplicate.txt'])
  assert.deepEqual(await page.evaluate(()=>window.sentPayloads[0].refs),[firstRef])
  assert.match(await page.evaluate(()=>window.sentPayloads[0].text),new RegExp(`<attachment-ref ref="${firstRef}" />`))
  assert.equal(await page.evaluate(()=>window.sentPayloads[0].text),`before <attachment-ref ref="${firstRef}" />after`)
  assert.equal(await page.$$('.foxwarm-composer-attachment-chip').then(items=>items.length),1)

  await page.evaluate(()=>{window.acceptSends=true})
  await page.click('button[aria-label="Send message"]');await page.waitForFunction(()=>window.sentPayloads.length===2)
  await page.waitForFunction(()=>document.querySelectorAll('.foxwarm-composer-attachment-chip').length===0)
  assert.equal(await page.evaluate(()=>localStorage.getItem('composer_draft_v1_fixture/a')),null)
  await page.close()
})

test('numbered attachment previews form a grid above the editor on desktop and mobile without changing refs or undo', async()=>{
  for (const width of [900,390]) {
    const page=await browser.newPage();await page.setViewport({width,height:844});await page.goto(fixtureUrl,{waitUntil:'load'})
    await page.waitForSelector('[role="textbox"]')
    assert.equal(await page.$eval('[role="textbox"]',el=>!!el.dataset.placeholder),width>=768,'mobile omits the ordinary composer hint')
    await page.evaluate(()=>window.fixtureSetRunning(true))
    await page.waitForSelector('[data-composer-action="stop"]')
    await page.$eval('#file-upload',input=>{
      const files=new DataTransfer()
      files.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'image.png',{type:'image/png'}))
      files.items.add(new File(['notes'],'notes.txt',{type:'text/plain'}))
      files.items.add(new File(['document'],'document.pdf',{type:'application/pdf'}))
      Object.defineProperty(input,'files',{configurable:true,value:files.files});input.dispatchEvent(new Event('change',{bubbles:true}))
    })
    await page.waitForFunction(()=>document.querySelectorAll('[data-attachment-preview-ref]').length===3 && document.querySelector('.composer-attachment-preview img')?.naturalWidth>0)
    await page.waitForSelector('[data-composer-action="send"]:not([disabled])')
    const layout=await page.evaluate(()=>{
      const grid=document.querySelector('.composer-attachment-grid'),editor=document.querySelector('[role="textbox"]'),tiles=[...grid.querySelectorAll('[data-attachment-preview-ref]')]
      return {numbers:[...grid.querySelectorAll('[data-attachment-number]')].map(el=>el.textContent),inline:[...editor.querySelectorAll('.foxwarm-composer-attachment-chip')].map(el=>el.textContent),images:editor.querySelectorAll('img').length,above:grid.getBoundingClientRect().bottom<=editor.getBoundingClientRect().top,grid:getComputedStyle(grid).display,bounded:tiles.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),refs:tiles.map(el=>el.dataset.attachmentPreviewRef)}
    })
    assert.deepEqual(layout.numbers,['1','2','3']);assert.deepEqual(layout.inline,['FILE 1','FILE 2','FILE 3']);assert.equal(layout.images,0);assert.equal(layout.grid,'grid');assert.ok(layout.above&&layout.bounded,JSON.stringify(layout))
    if(process.env.FOXWARM_E2E_SCREENSHOT_DIR){await mkdir(process.env.FOXWARM_E2E_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_E2E_SCREENSHOT_DIR+'/attachment-grid-'+width+'.png'})}
    const previewButton='[aria-label="Preview attachment 1: image.png"]'
    await page.click(previewButton);await page.waitForSelector('[data-image-preview][open]')
    assert.equal(await page.$eval('[data-image-preview]',el=>Math.abs(el.getBoundingClientRect().width-innerWidth)<1&&Math.abs(el.getBoundingClientRect().height-innerHeight)<1),true)
    assert.ok(await page.$('[data-image-preview] img[src^="blob:"]'))
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
    assert.equal(await page.evaluate(selector=>document.activeElement===document.querySelector(selector),previewButton),true)
    await page.click('[aria-label="Remove attachment notes.txt"]')
    await page.waitForFunction(()=>document.querySelectorAll('[data-attachment-preview-ref]').length===2)
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip',els=>els.map(el=>[el.dataset.composerAttachmentRef,el.textContent])),[[layout.refs[0],'FILE 1'],[layout.refs[2],'FILE 2']])
    await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control')
    await page.waitForFunction(()=>document.querySelectorAll('[data-attachment-preview-ref]').length===3)
    await page.click('[aria-label="Send message"]');await page.waitForFunction(()=>window.sentPayloads.length===1)
    assert.deepEqual(await page.evaluate(()=>window.sentPayloads[0].refs),layout.refs)
    assert.equal(await page.$$eval('[data-attachment-preview-ref]',els=>els.length),3)
    await page.evaluate(()=>window.acceptSends=true);await page.click('[aria-label="Send message"]')
    await page.waitForFunction(()=>window.sentPayloads.length===2&&!document.querySelector('.composer-attachment-grid'))
    await page.waitForSelector('[data-composer-action="stop"]')
    await page.close()
  }
})

test('active composition displays Send without committing interim text or accidentally stopping', async()=>{
  const page=await browser.newPage();await page.goto(fixtureUrl,{waitUntil:'load'});await page.waitForSelector('[role="textbox"]')
  await page.evaluate(()=>window.fixtureSetRunning(true));await page.waitForSelector('[data-composer-action="stop"]')
  await page.focus('[role="textbox"]');await page.$eval('[role="textbox"]',el=>{
    el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
    el.append(document.createTextNode('测试'))
    el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'测试',isComposing:true}))
  })
  await page.waitForSelector('[data-composer-action="send"]:not([disabled])')
  await page.click('[aria-label="Send message"]');await page.waitForFunction(()=>window.sentPayloads.length===1)
  assert.equal(await page.evaluate(()=>window.sentPayloads[0].text),'测试')
  assert.equal(await page.evaluate(()=>window.stops),0)
  await page.close()
})
