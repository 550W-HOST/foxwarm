import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const imagePartsEntry = new URL('../src/components/ImageParts.tsx', import.meta.url).pathname
const pngId = `${'a'.repeat(64)}.png`
const svgId = `${'b'.repeat(64)}.svg`
const missingId = `${'c'.repeat(64)}.png`
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ImageParts from ${JSON.stringify(imagePartsEntry)}
    import { initializeThemeRuntime } from './src/theme/runtime'
    initializeThemeRuntime()

    const render = (id, ref) => createRoot(document.getElementById(id)).render(
      React.createElement(ImageParts, { imageParts: [{ inlineDataRef: ref }], keyPrefix: id })
    )
    render('safe', { blobId: '${pngId}', imageId: 'safe', mimeType: 'image/png', apiPath: '/blobs/${pngId}' })
    render('unsafe', { blobId: '${svgId}', imageId: 'unsafe', mimeType: 'image/svg+xml', apiPath: '/blobs/${svgId}' })
    render('missing', { blobId: '${missingId}', imageId: 'missing', mimeType: 'image/png', apiPath: '/blobs/${missingId}' })
    window.renderLargeImage = () => {
      const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1000
      const ctx=canvas.getContext('2d');ctx.fillStyle='#e9eef2';ctx.fillRect(0,0,1600,1000)
      ctx.fillStyle='#20394b';ctx.font='bold 56px sans-serif';ctx.fillText('Image preview',100,130)
      ctx.font='28px sans-serif';ctx.fillText('Synthetic chart',100,190)
      for(let i=0;i<6;i++){ctx.fillStyle=i%2?'#6096ab':'#3a7588';ctx.fillRect(120+i*220,800-(i+1)*85,130,(i+1)*85)}
      const part={inlineData:{mimeType:'image/png',data:canvas.toDataURL('image/png').split(',')[1]}}
      createRoot(document.getElementById('large')).render(React.createElement(React.StrictMode,null,React.createElement(ImageParts,{imageParts:[part],keyPrefix:'large'})))
    }

  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'image-parts-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

test('ImageParts uses authenticated deployment-relative blob URLs and never renders active formats inline', async () => {
  const bundle = await buildFixtureBundle()
  const requests = []
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const server = createServer((request, response) => {
    if (request.url === `/nested/api/blobs/${pngId}`) {
      requests.push({ url: request.url, cookie: request.headers.cookie || '' })
      if (!String(request.headers.cookie || '').includes('foxwarm_token=fixture-token')) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end('{"error":"Unauthorized"}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(pngBytes)
      return
    }
    if (request.url === `/nested/api/blobs/${missingId}`) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":"Not found"}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="safe"></div><div id="unsafe"></div><div id="missing"></div><div id="large"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.setCookie({ name: 'foxwarm_token', value: 'fixture-token', url: `${origin}/nested/` })
    await page.goto(`${origin}/nested/`, { waitUntil: 'load' })
    await page.waitForFunction(() => {
      const image = document.querySelector('#safe img')
      return image?.complete && image.naturalWidth === 1 && document.querySelector('#missing')?.textContent?.includes('Image unavailable')
    })

    assert.equal(await page.$$('#safe img').then(nodes => nodes.length), 1)
    assert.equal(requests.some(request => request.url === `/nested/api/blobs/${pngId}` && request.cookie.includes('foxwarm_token=fixture-token')), true)
    assert.equal(await page.$$('#unsafe img').then(nodes => nodes.length), 0)
    assert.equal(await page.$eval('#unsafe a', link => link.href), `${origin}/nested/api/blobs/${svgId}`)
    assert.match(await page.$eval('#missing', element => element.textContent || ''), /Image unavailable/)
    assert.equal(await page.$eval('#unsafe a', link => link.hasAttribute('download') && !link.target), true)
    let popups = 0
    page.on('popup', () => popups++)
    for (const viewport of [{width:1200,height:800},{width:390,height:844},{width:844,height:390}]) {
      await page.setViewport(viewport)
      await page.evaluate(() => window.scrollTo(0,0))
      await page.click('#safe button')
      await page.waitForSelector('[data-image-preview][open]')
      await page.waitForFunction(() => document.querySelector('[data-image-preview] img')?.naturalWidth === 1)
      const geometry = await page.$eval('[data-image-preview]', dialog => {
        const box=dialog.getBoundingClientRect(),image=dialog.querySelector('img').getBoundingClientRect(),header=dialog.querySelector('header').getBoundingClientRect()
        return {full:box.x===0&&box.y===0&&Math.abs(box.width-innerWidth)<1&&Math.abs(box.height-innerHeight)<1,contained:image.left>=0&&image.right<=innerWidth&&image.top>=header.bottom&&image.bottom<=innerHeight,focus:dialog.contains(document.activeElement),locked:document.documentElement.style.overflow==='hidden'}
      })
      assert.deepEqual(geometry,{full:true,contained:true,focus:true,locked:true})
      await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab')
      assert.equal(await page.$eval('[data-image-preview]', dialog => dialog.contains(document.activeElement)),true)
      await page.click('[aria-label="Actual size"]');await page.waitForSelector('[data-actual-size]')
      await page.click('[aria-label="Fit image"]');await page.waitForFunction(()=>!document.querySelector('[data-actual-size]'))
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#safe button')),true)
      assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'')
      assert.equal(page.url(),`${origin}/nested/`)
    }
    assert.equal(popups,0)
    await page.evaluate(()=>{HTMLAnchorElement.prototype.click=function(){window.downloaded={url:this.href,name:this.download}}})
    await page.click('#safe button');await page.waitForSelector('[data-image-preview][open]')
    await page.click('[aria-label="Download Image 1"]');await page.waitForFunction(()=>!!window.downloaded)
    assert.equal(await page.evaluate(()=>window.downloaded.name),'Image 1')
    await page.click('[aria-label="Close image preview"]')
    await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
    await page.click('#safe button');await page.waitForSelector('[data-image-preview][open]')
    await page.click('.image-preview-stage',{offset:{x:20,y:20}})
    await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
    await page.evaluate(()=>window.renderLargeImage())
    await page.waitForSelector('#large button')
    for (const viewport of [{width:1200,height:800},{width:390,height:844}]) {
      await page.setViewport(viewport);await page.click('#large button')
      await page.waitForFunction(()=>document.querySelector('[data-image-preview] img')?.naturalWidth===1600)
      assert.equal(await page.$eval('[data-image-preview] img',img=>{const r=img.getBoundingClientRect(),s=img.parentElement.getBoundingClientRect();return r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom}),true,'large images fit inside the available stage without cropping')
      if(process.env.FOXWARM_IMAGE_PREVIEW_DIR){await mkdir(process.env.FOXWARM_IMAGE_PREVIEW_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-'+viewport.width+'.png'})}
      await page.click('[aria-label="Actual size"]')
      assert.equal(await page.$eval('.image-preview-stage',el=>el.scrollWidth>el.clientWidth&&el.scrollHeight>el.clientHeight),true)
      await page.focus('.image-preview-stage');await page.keyboard.press('PageDown')
      await page.waitForFunction(()=>document.querySelector('.image-preview-stage').scrollTop>0)
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
      assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'','StrictMode cleanup releases every scroll lock')
    }
  } finally {
    await browser?.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})
