import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

test('build checks distinguish real updates from authentication failures and support dismissal and guarded reload', async () => {
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Notice from './src/components/BuildUpdateNotice';createRoot(document.getElementById('root')).render(React.createElement(Notice));`,resolveDir:process.cwd()+'/packages/webui',loader:'tsx'},bundle:true,jsx:'automatic',format:'iife',write:false,define:{'process.env.NODE_ENV':'"test"'}})
 let version='one', login=false, requests=0
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/nested/assets/')) {res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);return}
  requests++;res.setHeader('Content-Type','text/html');res.end(login?'<form id="loginForm"></form>':`<div id="root"></div><script type="module" src="./assets/${version}.js"></script>`)
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const browser=await puppeteer.launch({executablePath:'/snap/bin/chromium',args:['--no-sandbox']})
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>console.log('page-error',e.message));page.on('console',m=>{if(m.type()==='error')console.log('console',m.text())})
  await page.evaluateOnNewDocument(()=>{const original=Date.now;let offset=0;window.advanceCheck=()=>{offset+=16000;window.dispatchEvent(new Event('focus'))};Date.now=()=>original()+offset})
  await page.goto(`http://127.0.0.1:${server.address().port}/nested/`)
  await new Promise(r=>setTimeout(r,200));assert.equal(await page.$('[role=status]'),null)
  login=true;await page.evaluate(()=>window.advanceCheck());await new Promise(r=>setTimeout(r,200));assert.equal(await page.$('[role=status]'),null)
  login=false;version='two';await page.evaluate(()=>window.advanceCheck());await page.waitForSelector('[role=status]')
  assert.match(await page.$eval('[role=status]',e=>e.textContent),/new version/)
  await page.evaluate(()=>window.addEventListener('foxwarm-before-update-reload',e=>e.preventDefault(),{once:true}))
  await page.$eval('button',e=>e.click());await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Finish sending'))
  await page.$$eval('button',buttons=>buttons.find(b=>b.textContent==='Later').click());assert.equal(await page.$('[role=status]'),null)
  await page.evaluate(()=>window.advanceCheck());await new Promise(r=>setTimeout(r,200));assert.equal(await page.$('[role=status]'),null)
  version='three';await page.evaluate(()=>window.advanceCheck());await page.waitForSelector('[role=status]')
  page.once('dialog',d=>d.accept());await page.$eval('button',e=>e.click());await page.waitForFunction(()=>document.querySelector('script[type=module]').src.endsWith('three.js'))
  assert(requests>=5)
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
})
