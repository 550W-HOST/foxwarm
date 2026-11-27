import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { createHostFixture } from './mainHostFixture.mjs'
import { createMainHostProxy } from './mainHostProxy.mjs'
import { restoreStateSnapshot, stateSnapshot } from './stateSeeds.mjs'

// The ImageParts component runs against an owned managed Main behind a recording proxy. Its Archive
// holds one referenced PNG at continuous-parent seq 150, which a scoped identity may read only there.
const fixture = await createHostFixture('image-parts')
const seed = await restoreStateSnapshot(stateSnapshot('continuous-history'), fixture.data)
const scopedSession = seed.parent, archiveSeq = '150'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const imagePartsEntry = new URL('../src/components/ImageParts.tsx', import.meta.url).pathname
const pngId = seed.image.blobId
const svgBytes = Buffer.from('<svg/>')
const svgId = createHash('sha256').update(svgBytes).digest('hex') + '.svg'
const missingId = `${'c'.repeat(64)}.png`
const blobPath = id => path.join(fixture.data, 'state/image-blobs', id.slice(0, 2), id)
const pngBytes = await readFile(blobPath(pngId))
const pngWidth = seed.image.width

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ImageParts, { WebUiImageSessionContext } from ${JSON.stringify(imagePartsEntry)}
    import { initializeThemeRuntime } from './src/theme/runtime'
    initializeThemeRuntime()

    const render = (id, ref, sessionId = null) => createRoot(document.getElementById(id)).render(
      React.createElement(WebUiImageSessionContext.Provider, { value: sessionId },
        React.createElement(ImageParts, { imageParts: [{ inlineDataRef: ref }], keyPrefix: id }))
    )
    render('safe', { blobId: '${pngId}', imageId: 'safe', mimeType: 'image/png', apiPath: '/blobs/${pngId}' })
    render('scoped', { blobId: '${pngId}', imageId: 'scoped', mimeType: 'image/png', apiPath: '/blobs/${pngId}?archiveSeq=${archiveSeq}' }, '${scopedSession}')
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
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  await mkdir(path.dirname(blobPath(svgId)), { recursive: true }); await writeFile(blobPath(svgId), svgBytes)
  const proxy = await createMainHostProxy({ target: fixture.origin, prefix: '/nested', page: () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="safe"></div><div id="scoped"></div><div id="unsafe"></div><div id="missing"></div><div id="large"></div><script>${bundle}</script></body></html>` })
  await writeFile(path.join(fixture.data, 'state/config.yaml'), JSON.stringify({ url: proxy.origin + '/nested', bot: { httpPort: fixture.port, enableTrigger: false }, vector: { enabled: false },
    access: { identities: { reader: { token: 'scoped-image-token', surfaces: { webui: { sessions: [scopedSession] } } } } } }))
  await fixture.start()
  const blobRequests = () => proxy.requests.filter(request => request.path.includes('/blobs/'))
  const requests = { some: check => blobRequests().some(check), findLast: check => blobRequests().findLast(check) }
  const signRecords = () => proxy.requests.filter(request => request.path.endsWith('/download'))
  const signRequests = { get length() { return signRecords().length }, at: index => signRecords().at(index) }
  const origin = proxy.origin
  let browser
  try {
    browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.setCookie({ name: 'foxwarm_token', value: fixture.token, url: `${origin}/nested/` })
    await page.goto(`${origin}/nested/`, { waitUntil: 'load' })
    await page.waitForFunction(width => {
      const image = document.querySelector('#safe img')
      return image?.complete && image.naturalWidth === width && document.querySelector('#missing')?.textContent?.includes('Image unavailable')
    }, {}, pngWidth)

    assert.equal(await page.$$('#safe img').then(nodes => nodes.length), 1)
    assert.equal(requests.some(request => request.url === `/nested/api/blobs/${pngId}` && request.cookie.includes('foxwarm_token=' + fixture.token)), true)
    assert.equal(await page.$$('#unsafe img').then(nodes => nodes.length), 0)
    assert.match(await page.$eval('#missing', element => element.textContent || ''), /Image unavailable/)
    assert.equal(await page.$eval('#unsafe button', button => button.type==='button'&&!button.disabled), true)
    let popups = 0
    page.on('popup', () => popups++)
    for (const viewport of [{width:1200,height:800},{width:390,height:844},{width:844,height:390}]) {
      await page.setViewport(viewport)
      await page.evaluate(() => window.scrollTo(0,0))
      await page.click('#safe button')
      await page.waitForSelector('[data-image-preview][open]')
      await page.waitForFunction(width => document.querySelector('[data-image-preview] img')?.naturalWidth === width, {}, pngWidth)
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
    // Keep actual native browser handoff separate from the presentation checks.
    const client=await browser.target().createCDPSession()
    const network=await page.createCDPSession()
    const downloads=await mkdtemp(path.join(process.env.fw_tmp || tmpdir(),'image-native-download-'))
    await client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true})
    await network.send('Fetch.enable',{patterns:[{urlPattern:'*/blobs/*/download',requestStage:'Response'}]})
    network.on('Fetch.requestPaused',async event=>{
      await page.deleteCookie({name:'foxwarm_token',url:origin+'/nested/'})
      await network.send('Fetch.continueRequest',{requestId:event.requestId})
    })
    try{
      for(const [id,token]of[['safe',fixture.token],['scoped','scoped-image-token']]){
        await page.setCookie({name:'foxwarm_token',value:token,url:origin+'/nested/'})
        const completed=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Image download did not finish')),10000)
          const progress=event=>{if(event.state==='completed'){clearTimeout(timer);client.off('Browser.downloadProgress',progress);resolve()}}
          client.on('Browser.downloadProgress',progress)
        })
        await page.click('#'+id+' button');await page.waitForSelector('[data-image-preview][open]')
        await page.click('[aria-label="Download Image 1"]');await completed
        assert.deepEqual(await readFile(path.join(downloads,'Image 1')),pngBytes)
        await rm(path.join(downloads,'Image 1'))
        assert.ok(signRequests.at(-1).cookie.includes('foxwarm_token='+token))
        const downloaded=requests.findLast(request=>request.url.includes('signature='))
        // The non-secret theme cookie is path-scoped and may accompany any same-path request; no other cookie, in particular no login token, may.
        assert.ok(downloaded);assert.deepEqual(downloaded.cookie.split(';').map(part=>part.split('=')[0].trim()).filter(name=>name&&name!=='foxwarm_canvas'),[])
        if(id==='scoped'){
          assert.ok(downloaded.url.startsWith(`/nested/api/sessions/${encodeURIComponent(scopedSession)}/blobs/`))
          assert.ok(requests.some(request=>request.url.includes(`/sessions/${encodeURIComponent(scopedSession)}/blobs/`)&&request.url.includes('archiveSeq='+archiveSeq)))
          assert.ok(signRecords().some(input=>input.method==='POST'&&JSON.parse(input.body||'{}').archiveSeq===archiveSeq),'Archive proof reaches signature issuance')
        }
        await page.click('[aria-label="Close image preview"]')
      }
    }finally{
      await network.send('Fetch.disable');await network.detach()
      await client.send('Browser.setDownloadBehavior',{behavior:'default'});await client.detach()
      await rm(downloads,{recursive:true,force:true})
    }
    await page.setCookie({name:'foxwarm_token',value:fixture.token,url:origin+'/nested/'})
    await page.evaluate(()=>{HTMLAnchorElement.prototype.click=function(){window.downloaded={url:this.href,name:this.download}}})
    await page.click('#safe button');await page.waitForSelector('[data-image-preview][open]')
    await page.click('[aria-label="Download Image 1"]');await page.waitForFunction(()=>!!window.downloaded)
    assert.equal(await page.evaluate(()=>window.downloaded.name),'Image 1')
    assert.match(await page.evaluate(()=>window.downloaded.url),/signature=/)
    await page.click('[aria-label="Close image preview"]')
    await page.evaluate(()=>{window.downloaded=null})
    await page.click('#unsafe button');await page.waitForFunction(()=>!!window.downloaded)
    const unsafeUrl=await page.evaluate(()=>window.downloaded.url)
    const unsafe=await fetch(unsafeUrl)
    assert.equal(unsafe.status,200);assert.equal(unsafe.headers.get('content-type'),'application/octet-stream')
    assert.match(unsafe.headers.get('content-disposition'),/^attachment/)
    assert.equal(await unsafe.text(),'<svg/>')
    await page.click('#safe button');await page.waitForSelector('[data-image-preview][open]')
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
      const beforeLocal=signRequests.length
      await page.evaluate(()=>{window.downloaded=null})
      await page.click('[aria-label="Download Image 1"]');await page.waitForFunction(()=>window.downloaded?.url.startsWith('data:'))
      assert.equal(signRequests.length,beforeLocal,'local data images do not request a signature')
      assert.equal(await page.$eval('[data-image-preview] img',img=>{const r=img.getBoundingClientRect(),s=img.parentElement.getBoundingClientRect();return r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom}),true,'large images fit inside the available stage without cropping')
      const imageSource=await page.$eval('[data-image-preview] img',img=>img.currentSrc)
      for(const actual of[false,true]){
        if(actual)await page.click('[aria-label="Actual size"]')
        const before=await page.$eval('[data-image-preview] img',img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height}))
        await page.evaluate(()=>{window.imageContext=null;document.addEventListener('contextmenu',event=>{window.imageContext={cancelled:event.defaultPrevented,target:event.target.tagName,source:event.target.currentSrc}},{once:true})})
        await page.click('[data-image-preview] img',{button:'right'})
        assert.deepEqual(await page.evaluate(()=>window.imageContext),{cancelled:false,target:'IMG',source:imageSource},'native right-click reaches the real image, not an overlay')
        assert.deepEqual(await page.$eval('[data-image-preview] img',img=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height})),before,'right-click does not toggle zoom')
        // Browser context-menu UI is outside the page; this verifies its entry
        // event is not cancelled, without pretending to automate the OS menu.
        assert.ok(await page.$('[data-image-preview][open]'))
        if(actual)await page.click('[aria-label="Fit image"]')
      }
      if(process.env.FOXWARM_IMAGE_PREVIEW_DIR){await mkdir(process.env.FOXWARM_IMAGE_PREVIEW_DIR,{recursive:true});await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-'+viewport.width+'.png'})}
      await page.click('[aria-label="Actual size"]')
      assert.equal(await page.$eval('.image-preview-stage',el=>el.scrollWidth>el.clientWidth&&el.scrollHeight>el.clientHeight),true)
      await page.focus('.image-preview-stage');await page.keyboard.press('PageDown')
      await page.waitForFunction(()=>document.querySelector('.image-preview-stage').scrollTop>0)
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
      assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'','StrictMode cleanup releases every scroll lock')
    }
    // CDP dispatches native browser touch input, not React handlers or DOM events.
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true})
    await page.evaluate(()=>window.renderLargeImage())
    await page.waitForSelector('#large button')
    await page.click('#large button')
    await page.waitForFunction(()=>document.querySelector('[data-image-preview] img')?.naturalWidth===1600)
    await page.waitForFunction(() => {
      const stage = document.querySelector('.image-preview-stage')
      const image = stage?.querySelector('img')
      const control = document.querySelector('[aria-label="Actual size"]')
      if (!stage || !image || !control || control.disabled || !image.naturalWidth || !image.naturalHeight) return false
      const style = getComputedStyle(stage)
      const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      const fit = Math.min(1, availableWidth / image.naturalWidth, availableHeight / image.naturalHeight)
      const rendered = image.getBoundingClientRect()
      return fit > 0
        && Math.abs(rendered.width - image.naturalWidth * fit) < 1
        && Math.abs(rendered.height - image.naturalHeight * fit) < 1
    })
    const touch=await page.createCDPSession()
    const input=async(type,points,settle=true)=>{
      await touch.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:4,radiusY:4}))})
      if(settle)await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    }
    const geometry=()=>page.$eval('.image-preview-stage',stage=>{
      const img=stage.querySelector('img'),r=img.getBoundingClientRect()
      return {left:r.left,top:r.top,width:r.width,height:r.height,x:stage.scrollLeft,y:stage.scrollTop,src:img.src,pageX:scrollX,pageY:scrollY,viewportScale:visualViewport.scale}
    })
    try {
      const before=await geometry()
      await input('touchStart',[[1,140,440],[2,200,440]])
      for(let distance=40;distance<=120;distance+=20)await input('touchMove',[[1,170-distance,440],[2,170+distance,440]])
      const zoomed=await geometry()
      assert.ok(Math.abs(zoomed.width/before.width-4)<.02,'two fingers zoom the image itself')
      assert.ok(Math.abs((170-before.left)/before.width-(170-zoomed.left)/zoomed.width)<.005,'pinch preserves the image point beneath its off-center midpoint')
      assert.ok(Math.abs((440-before.top)/before.height-(440-zoomed.top)/zoomed.height)<.005)
      await input('touchMove',[[1,40,430],[2,280,430]])
      const translated=await geometry()
      assert.ok(Math.abs(translated.width-zoomed.width)<1&&translated.x>zoomed.x+8&&translated.y>zoomed.y+8,'moving both fingers translates the image without changing scale')
      await input('touchEnd',[[2,280,430]])
      const panStart=await geometry()
      await input('touchMove',[[1,10,390]])
      await input('touchEnd',[])
      const panned=await geometry()
      assert.ok(Math.abs(panned.left-panStart.left+30)<1.5&&Math.abs(panned.top-panStart.top+40)<1.5,'remaining finger moves the image 1:1 in CSS pixels')
      assert.ok(await page.$('[data-image-preview][open]'),'ending a gesture does not close the viewer')
      assert.ok(await page.$('[data-actual-size]'),'ending a gesture does not trigger the image click toggle')
      assert.equal(panned.src,before.src,'touch gestures retain the original image source')
      assert.deepEqual([panned.pageX,panned.pageY,panned.viewportScale],[before.pageX,before.pageY,1],'the page neither pans nor zooms')
      if(process.env.FOXWARM_IMAGE_PREVIEW_DIR)await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-touch-zoom-pan.png'})
      // A fresh single-finger drag and cancellation remain inside the viewer.
      await input('touchStart',[[1,200,460]])
      await input('touchMove',[[1,150,430]])
      await input('touchCancel',[])
      assert.ok(await page.$('[data-actual-size]'))
      const dragged=await geometry()
      assert.ok(Math.abs(dragged.left-panned.left+50)<1.5&&Math.abs(dragged.top-panned.top+30)<1.5,'a fresh one-finger drag moves the image 1:1 in both axes')
      const panMeasurements=[]
      for(const zoom of ['pinched','intrinsic','fractional']) {
        if(zoom==='intrinsic') {
          await page.mouse.click(180,440)
          await page.click('[aria-label="Actual size"]')
          await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:3})
        } else if(zoom==='fractional') {
          await page.click('[aria-label="Fit image"]')
          await input('touchStart',[[1,170,440],[2,220,440]])
          await input('touchMove',[[1,40,440],[2,350,440]])
          await input('touchEnd',[])
        }
        await input('touchStart',[[1,150,440]])
        const fineStart=await geometry()
        if(zoom==='fractional'&&process.env.FOXWARM_IMAGE_PREVIEW_DIR)await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-pan-before.png'})
        for(let step=1;step<=80;step++)await input('touchMove',[[1,150+step*.25,440-step*.25]])
        const fineEnd=await geometry()
        await input('touchEnd',[])
        assert.ok(Math.abs(fineEnd.left-fineStart.left-20)<1.5&&Math.abs(fineEnd.top-fineStart.top+20)<1.5,`${zoom} fractional pan stays 1:1: ${fineEnd.left-fineStart.left}, ${fineEnd.top-fineStart.top} for 20, -20 CSS pixels`)
        assert.equal(fineEnd.viewportScale,1,'image zoom never becomes browser page zoom')
        panMeasurements.push({zoom,width:fineEnd.width,dpr:await page.evaluate(()=>devicePixelRatio),finger:[20,-20],image:[fineEnd.left-fineStart.left,fineEnd.top-fineStart.top],pageScale:fineEnd.viewportScale})
        if(zoom==='fractional'&&process.env.FOXWARM_IMAGE_PREVIEW_DIR)await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-pan-after.png'})
      }
      await input('touchStart',[[1,180,440]])
      const burstStart=await geometry()
      for(let step=1;step<=80;step++)await input('touchMove',[[1,180-step*.25,440+step*.25]],false)
      await input('touchEnd',[])
      const burstEnd=await geometry()
      assert.ok(Math.abs(burstEnd.left-burstStart.left+20)<1.5&&Math.abs(burstEnd.top-burstStart.top-20)<1.5,'unpaced native touch moves also retain their cumulative 1:1 displacement')
      panMeasurements.push({zoom:'unpaced',finger:[-20,20],image:[burstEnd.left-burstStart.left,burstEnd.top-burstStart.top]})
      console.info('Image pan CSS-pixel measurements:',JSON.stringify(panMeasurements))
      const selectionStyles=await page.$$eval('.image-preview-dialog, .image-preview-header h2, .image-preview-stage, .image-preview-stage img',els=>els.map(el=>getComputedStyle(el).webkitUserSelect))
      assert.ok(selectionStyles.every(value=>value==='none'),'the entire viewer suppresses WebKit selection, not only the image')
      await input('touchStart',[[1,180,440]])
      await new Promise(resolve=>setTimeout(resolve,800))
      const held=await geometry()
      await input('touchMove',[[1,200,420]])
      await input('touchEnd',[])
      const afterHold=await geometry()
      assert.ok(Math.abs(afterHold.left-held.left-20)<1.5&&Math.abs(afterHold.top-held.top+20)<1.5,'hold-then-drag remains 1:1')
      assert.equal(await page.evaluate(()=>getSelection()?.toString()),'','native touch hold does not create a text selection in Chromium')
      assert.equal(await page.$eval('[data-image-preview] img',img=>!img.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'touch'}))),true,'touch long-press remains suppressed for image gestures')
      assert.equal(await page.$eval('[data-image-preview] img',img=>img.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),true,'keyboard/legacy mouse context-menu events remain native without an active touch')
      await page.evaluate(()=>document.addEventListener('contextmenu',event=>{window.contextMenuCancelled=event.defaultPrevented},{once:true}))
      await page.mouse.click(180,440,{button:'right'})
      assert.equal(await page.evaluate(()=>window.contextMenuCancelled),false,'mouse right-click retains native image copy/save even after touch gestures')
      if(process.env.FOXWARM_IMAGE_PREVIEW_DIR)await page.screenshot({path:process.env.FOXWARM_IMAGE_PREVIEW_DIR+'/preview-fractional-pan-dpr3.png'})
      await page.mouse.click(180,440)
      assert.equal(await page.$('[data-actual-size]'),null,'a deliberate mouse click also works after a touch gesture')
      await page.click('[aria-label="Actual size"]')
      await input('touchStart',[[1,70,440],[2,310,440]])
      for(let distance=100;distance>=10;distance-=15)await input('touchMove',[[1,190-distance,440],[2,190+distance,440]])
      await input('touchEnd',[])
      assert.equal(await page.$('[data-actual-size]'),null,'pinch-in stops at fit rather than shrinking the image away')
      assert.ok(await page.$('[data-image-preview][open]'),'ending pinch-in at fit does not close the viewer')
      await page.click('[aria-label="Actual size"]')
      assert.ok(Math.abs((await geometry()).width-1600)<1,'Actual size still uses intrinsic image pixels')
      await page.setViewport({width:844,height:390,isMobile:true,hasTouch:true})
      assert.ok(Math.abs((await geometry()).width-1600)<1,'resizing does not change actual pixel size')
      await page.click('[aria-label="Fit image"]')
      await page.waitForFunction(()=>!document.querySelector('[data-actual-size]'))
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true})
      await page.waitForFunction(()=>document.querySelector('.image-preview-stage img').getBoundingClientRect().width<390)
      const fitAgain=await geometry()
      assert.ok(Math.abs(fitAgain.width-before.width)<1)
      // Swiping fit-mode empty space must not become a backdrop click.
      // Complete the swipe without inertia: Chromium consumes a tap that stops
      // an active fling before the image can receive its native click.
      await touch.send('Input.synthesizeScrollGesture', {
        x: 25, y: 150, yDistance: 50, gestureSourceType: 'touch', preventFling: true,
      })
      assert.ok(await page.$('[data-image-preview][open]'))
      // A subsequent deliberate tap still toggles and can reset to fit.
      await page.touchscreen.tap(180,440)
      await page.waitForSelector('[data-actual-size]')
      await page.click('[aria-label="Fit image"]')
      await page.touchscreen.tap(25,150)
      await page.waitForFunction(()=>!document.querySelector('[data-image-preview]'))
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#large button')),true)
      assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'')
    } finally { await touch.detach() }
  } finally {
    await browser?.close()
    await proxy.close()
    await fixture.cleanup()
  }
})

// Viewer interactions on a gallery of local images: no Main is needed, so the page is static.
async function buildGalleryBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { ImageItem } from ${JSON.stringify(imagePartsEntry)}
    import { ImageGalleryContext, useImageGalleryStore } from './src/components/imageGallery'
    import { initializeThemeRuntime } from './src/theme/runtime'
    initializeThemeRuntime()
    const image = (width, height, label, color) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height)
      context.fillStyle = '#ffffff'
      for (let x = 0; x < width; x += 100) context.fillRect(x, 0, 2, height)
      for (let y = 0; y < height; y += 100) context.fillRect(0, y, width, 2)
      context.font = 'bold 72px sans-serif'; context.fillText(label, 60, 120)
      return { inlineData: { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] } }
    }
    // The third entry cannot be decoded: its error must stay inside the viewer.
    const parts = [image(1600, 1000, 'First', '#3a7588'), image(640, 480, 'Second', '#8a4f7d'), { inlineData: { mimeType: 'image/png', data: 'AAAA' } }, image(1200, 900, 'Fourth', '#5f8a3a')]
    const titles = ['First', 'Second', 'Broken', 'Fourth']
    const entries = parts.map((part, index) => ({ key: 'g' + index, src: 'data:image/png;base64,' + part.inlineData.data, mimeType: 'image/png', title: titles[index] }))
    const keys = new WeakMap(parts.map((part, index) => [part, 'g' + index]))
    function Gallery() {
      const store = useImageGalleryStore(entries, keys)
      return React.createElement(ImageGalleryContext.Provider, { value: store },
        [0, 1, 3].map(index => React.createElement('div', { key: index, id: 'g' + index }, React.createElement(ImageItem, { part: parts[index], label: titles[index] }))))
    }
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Gallery)))
  `
  const result = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'image-gallery-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  return result.outputFiles[0].text
}

test('the viewer zooms at the pointer, pans with the mouse and switches images with keys, buttons and swipes', async () => {
  const bundle = await buildGalleryBundle()
  const assets = new URL('../dist/assets/', import.meta.url)
  const css = await readFile(new URL((await readdir(assets)).find(name => /^index-.*\.css$/.test(name)), assets), 'utf8')
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script></body></html>`
  const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(`${origin}/`)
    await page.waitForFunction(() => document.querySelectorAll('#root img').length === 3 && [...document.querySelectorAll('#root img')].every(img => img.complete && img.naturalWidth), { timeout: 5000 }).catch(error => { throw new Error(`${error.message}: ${errors.join('; ')}: ${page.url()}`) })
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const view = () => page.evaluate(() => {
      const dialog = document.querySelector('[data-image-preview]')
      const stage = dialog?.querySelector('.image-preview-stage'), image = stage?.querySelector('img')
      const box = image?.getBoundingClientRect()
      return {
        open: !!dialog?.open, title: dialog?.querySelector('h2')?.textContent, position: dialog?.querySelector('[data-image-preview-position]')?.textContent ?? null,
        actual: !!stage?.hasAttribute('data-actual-size'), status: stage?.querySelector('[role=status]')?.textContent ?? null,
        previous: dialog?.querySelector('[data-direction=previous]')?.disabled, next: dialog?.querySelector('[data-direction=next]')?.disabled,
        focus: dialog?.contains(document.activeElement) ? document.activeElement.dataset.previewControl ?? document.activeElement.className : null,
        width: box?.width, left: box?.left, top: box?.top, height: box?.height, scrollLeft: stage?.scrollLeft, scrollTop: stage?.scrollTop,
        natural: image?.naturalWidth, pageScale: visualViewport.scale, dpr: devicePixelRatio,
      }
    })
    const ready = width => page.waitForFunction(width => {
      const image = document.querySelector('[data-image-preview] .image-preview-stage img'), control = document.querySelector('[data-preview-control="size"]')
      return image?.naturalWidth === width && control && !control.disabled && image.getBoundingClientRect().width > 0
    }, {}, width)

    // Keys: ←/→ walk the sequence from the opener's own position and stop at both ends.
    await page.click('#g1 button'); await ready(640)
    assert.deepEqual(await view().then(v => [v.title, v.position, v.previous, v.next]), ['Second', '2 / 4', false, false])
    await page.keyboard.press('ArrowRight'); await settle()
    let state = await view()
    assert.deepEqual([state.title, state.position, state.status, state.open], ['Broken', '3 / 4', 'Image unavailable', true], 'a decode error stays inside the viewer')
    await page.keyboard.press('ArrowRight'); await ready(1200)
    assert.deepEqual(await view().then(v => [v.title, v.position, v.next]), ['Fourth', '4 / 4', true])
    await page.keyboard.press('ArrowRight'); await settle()
    assert.equal((await view()).position, '4 / 4', 'the last image stays')
    for (const expected of ['3 / 4', '2 / 4', '1 / 4']) { await page.keyboard.press('ArrowLeft'); await settle(); assert.equal((await view()).position, expected) }
    await ready(1600)
    assert.equal((await view()).previous, true)
    await page.keyboard.press('ArrowLeft'); await settle()
    assert.equal((await view()).position, '1 / 4', 'the first image stays')

    // Buttons: visible on hover, focus stays on the pressed control, and switching resets the view.
    await page.click('[aria-label="Actual size"]'); await settle()
    assert.equal((await view()).actual, true)
    await page.mouse.move(600, 400)
    assert.equal(await page.$eval('[data-direction=next]', button => getComputedStyle(button).opacity), '1', 'hovering the image area shows the buttons')
    await page.click('[data-direction=next]'); await ready(640)
    state = await view()
    assert.deepEqual([state.position, state.actual, state.focus], ['2 / 4', false, 'next'], 'a switched-to image opens at fit')
    await page.click('[data-direction=previous]'); await ready(1600)
    state = await view()
    assert.equal(state.position, '1 / 4')
    assert.ok(state.focus, 'focus stays in the viewer when the pressed button disappears at the end')

    // Ctrl + wheel zooms continuously around the pointer; the page itself never zooms.
    const fit = await view()
    // Whole pixels, as mouse events report them.
    const pointer = { x: Math.round(fit.left + fit.width * 0.4), y: Math.round(fit.top + fit.height * 0.45) }
    const imagePoint = () => page.$eval('[data-image-preview] .image-preview-stage img', (img, pointer) => { const r = img.getBoundingClientRect(); return { x: (pointer.x - r.left) / r.width, y: (pointer.y - r.top) / r.height, width: r.width } }, pointer)
    await page.mouse.move(pointer.x, pointer.y)
    const anchored = await imagePoint()
    await page.keyboard.down('Control')
    const steps = []
    for (let step = 0; step < 4; step++) { await page.mouse.wheel({ deltaY: -100 }); await settle(); steps.push(await imagePoint()) }
    // A trackpad pinch arrives in Chromium as many small ctrl + wheel deltas.
    for (let step = 0; step < 12; step++) { await page.mouse.wheel({ deltaY: -4 }); await settle() }
    steps.push(await imagePoint())
    await page.keyboard.up('Control')
    state = await view()
    assert.equal(state.actual, true)
    assert.ok(steps.at(-1).width > anchored.width * 2, `wheel zoom grows the image: ${anchored.width} → ${steps.at(-1).width}`)
    for (const step of steps) {
      assert.ok(Math.abs(step.x - anchored.x) * step.width < 1.5 && Math.abs(step.y - anchored.y) * step.width < 1.5, `the point under the pointer stays: ${JSON.stringify([anchored, step])}`)
    }
    assert.deepEqual([state.pageScale, state.dpr], [1, 1], 'ctrl + wheel never zooms the page')
    // A plain wheel scrolls the enlarged image natively.
    const scrolled = state.scrollTop
    await page.mouse.wheel({ deltaY: 120 }); await page.waitForFunction(top => document.querySelector('.image-preview-stage').scrollTop > top, {}, scrolled)
    assert.ok(Math.abs((await view()).width - state.width) < 0.5, 'a plain wheel does not zoom')

    // The left button drags an enlarged image one-to-one; the drag's click does not toggle the size.
    state = await view()
    await page.mouse.move(600, 420); await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(600 - step * 6, 420 - step * 4)
    await page.mouse.up(); await settle()
    const dragged = await view()
    assert.ok(Math.abs(dragged.scrollLeft - state.scrollLeft - 60) <= 1 && Math.abs(dragged.scrollTop - state.scrollTop - 40) <= 1, `mouse pan is 1:1: ${dragged.scrollLeft - state.scrollLeft}, ${dragged.scrollTop - state.scrollTop}`)
    assert.equal(dragged.actual, true, 'the click ending a drag does not return to fit')
    assert.equal(await page.evaluate(() => getSelection().toString()), '')
    // Keys keep native scrolling while the enlarged image is wider than the stage.
    await page.focus('.image-preview-stage'); await page.keyboard.press('ArrowRight'); await settle()
    assert.equal((await view()).position, '1 / 4')
    // Zooming out stops at fit, and a deliberate click still toggles.
    await page.keyboard.down('Control')
    for (let step = 0; step < 40; step++) await page.mouse.wheel({ deltaY: 100 })
    await page.keyboard.up('Control'); await settle()
    state = await view()
    assert.ok(!state.actual && Math.abs(state.width - fit.width) < 1, 'wheel zoom-out ends at fit')
    await page.keyboard.down('Control')
    for (let step = 0; step < 60; step++) await page.mouse.wheel({ deltaY: -100 })
    await page.keyboard.up('Control'); await settle()
    assert.ok(Math.abs((await view()).width - fit.width * 8) < 1, 'wheel zoom stops at eight times fit')
    await page.mouse.click(600, 420); await settle()
    assert.equal((await view()).actual, false, 'a click without a drag still toggles the size')

    // WebKit gesture events (Safari, the macOS Desktop host) cannot be produced by Chromium;
    // synthetic events with WebKit's fields check the handling: cumulative scale around the point.
    const gesture = await page.$eval('.image-preview-stage', (stage, pointer) => {
      const fire = (type, scale) => {
        const event = new UIEvent(type, { bubbles: true, cancelable: true })
        Object.defineProperties(event, { scale: { value: scale }, clientX: { value: pointer.x }, clientY: { value: pointer.y } })
        stage.dispatchEvent(event)
        return event.defaultPrevented
      }
      const image = stage.querySelector('img'), at = () => { const r = image.getBoundingClientRect(); return { x: (pointer.x - r.left) / r.width, y: (pointer.y - r.top) / r.height, width: r.width } }
      const before = at()
      const prevented = [fire('gesturestart', 1), fire('gesturechange', 1.5), fire('gesturechange', 2.5)]
      const after = at()
      prevented.push(fire('gestureend', 2.5))
      return { before, after, prevented }
    }, pointer)
    assert.deepEqual(gesture.prevented, [true, true, true, true], 'WebKit page zoom is suppressed')
    assert.ok(Math.abs(gesture.after.width / gesture.before.width - 2.5) < 0.01, 'the gesture scale is cumulative from its start')
    assert.ok(Math.abs(gesture.after.x - gesture.before.x) * gesture.after.width < 1.5 && Math.abs(gesture.after.y - gesture.before.y) * gesture.after.width < 1.5, 'the gesture keeps the point under the pointer')
    await page.click('[aria-label="Fit image"]'); await settle()

    // Closing returns focus to the original opener, after any number of switches.
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[data-image-preview]'))
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#g1 button')), true)
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '')

    // Touch (the viewport change reloads the page): a horizontal swipe at fit switches; a
    // vertical one, or one on an enlarged image, does not.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await page.waitForFunction(() => [...document.querySelectorAll('#root img')].filter(img => img.complete && img.naturalWidth).length === 3)
    await page.tap('#g0 button'); await ready(1600)
    assert.equal(await page.$eval('[data-direction=next]', button => getComputedStyle(button).opacity), '1', 'buttons stay visible on touch screens')
    const touch = await page.createCDPSession()
    const swipe = async (from, to) => {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: from[0], y: from[1] }] })
      for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: from[0] + (to[0] - from[0]) * step / 6, y: from[1] + (to[1] - from[1]) * step / 6 }] })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await settle()
    }
    try {
      await swipe([200, 420], [330, 430]); assert.equal((await view()).position, '1 / 4', 'no image before the first')
      await swipe([300, 420], [120, 430]); await ready(640); assert.equal((await view()).position, '2 / 4')
      await swipe([200, 300], [210, 520]); assert.equal((await view()).position, '2 / 4', 'a vertical swipe does not switch')
      await swipe([120, 420], [300, 410]); await ready(1600); assert.equal((await view()).position, '1 / 4')
      assert.equal((await view()).open, true, 'swipes neither close the viewer nor toggle the size')
      await page.click('[aria-label="Actual size"]'); await settle()
      await swipe([300, 420], [120, 430])
      state = await view()
      assert.deepEqual([state.position, state.actual], ['1 / 4', true], 'an enlarged image pans instead of switching')
    } finally { await touch.detach() }

    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[data-image-preview]'))
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#g0 button')), true)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    server.close()
  }
})
