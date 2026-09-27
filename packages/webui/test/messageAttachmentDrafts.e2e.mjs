import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const composerEntry = fileURLToPath(new URL('../src/components/ChatComposer.tsx', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
let browser, server, fixtureUrl

before(async () => {
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatComposer from ${JSON.stringify(composerEntry)}
    window.sentPayloads = []; window.acceptSends = false
    window.fetch = async input => String(input).includes('/commands') ? new Response(JSON.stringify({commands:[]}), {status:200}) : new Response('{}', {status:404})
    function Fixture(){
      const [sessionId,setSessionId]=useState('fixture/a')
      return <><button data-session="a" onClick={()=>setSessionId('fixture/a')}>A</button><button data-session="b" onClick={()=>setSessionId('fixture/b')}>B</button><div data-active-session>{sessionId}</div><ChatComposer
        sessionId={sessionId} sessionMissing={false} loading={false} asrAvailable={false} modelOptions={[]}
        onChangeModel={async()=>{}} onChangeChildModel={async()=>{}} onChangeEffort={async()=>{}} onChangeChildEffort={async()=>{}} onRefreshModels={async()=>{}} onOpenModelSettings={()=>{}}
        onSend={async payload=>{window.sentPayloads.push({sessionId, refs:payload.attachments.map(item=>item.ref), names:payload.attachments.map(item=>item.file.name), text:payload.text}); return window.acceptSends}}
        onTranscribeAudio={async()=>({text:'',status:200,rawLength:0,textLength:0,responsePreview:''})} onCreateStreamingTranscriber={async()=>({sendAudioChunk(){},stop(){},cancel(){}})} /></>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const result = await build({ stdin:{contents:source,resolveDir:packageDir,sourcefile:'fixture.tsx',loader:'tsx'}, bundle:true, format:'iife', platform:'browser', target:'chrome120', write:false, define:{'process.env.NODE_ENV':JSON.stringify('test')}, logLevel:'silent' })
  server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><div id="root"></div><script>${result.outputFiles[0].text}</script>`)})
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
