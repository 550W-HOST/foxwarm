import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const pngId = `${'d'.repeat(64)}.png`
const missingId = `${'e'.repeat(64)}.png`
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    const pngRef = { blobId: '${pngId}', imageId: 'ig_pure', mimeType: 'image/png', apiPath: '/blobs/${pngId}' }
    const missingRef = { blobId: '${missingId}', imageId: 'ig_missing', mimeType: 'image/png', apiPath: '/blobs/${missingId}' }

    const render = (id, messages) => createRoot(document.getElementById(id)).render(
      React.createElement(ChatTimeline, {
        sessionId: 'fixture-session',
        messages,
        isMobile: false,
        groupTools: false,
        showUsageBadge: false,
      })
    )

    // A model turn that produced only an image, with no text at all.
    render('pure', [
      { role: 'user', parts: [{ text: 'DRAW_MARKER' }] },
      { role: 'model', parts: [{ inlineDataRef: pngRef }], __meta: { modelId: 'p/model' } },
    ])

    // Mixed text plus image, to confirm stable ordering.
    render('mixed', [
      { role: 'model', parts: [{ text: 'HERE_IS_TEXT' }, { inlineDataRef: pngRef }], __meta: { modelId: 'p/model' } },
    ])

    // A generated image whose Blob is gone (for example after a restore).
    render('missing', [
      { role: 'model', parts: [{ inlineDataRef: missingRef }], __meta: { modelId: 'p/model' } },
    ])
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'image-generation-timeline-fixture.tsx' },
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

test('a text-free model message still renders its generated image through the authenticated blob route', async () => {
  const bundle = await buildFixtureBundle()
  const requests = []
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
    response.end(`<!doctype html><html><body><div id="pure"></div><div id="mixed"></div><div id="missing"></div><script>${bundle}</script></body></html>`)
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
      const pure = document.querySelector('#pure img')
      const mixed = document.querySelector('#mixed img')
      return pure?.complete && pure.naturalWidth === 1
        && mixed?.complete && mixed.naturalWidth === 1
        && document.querySelector('#missing')?.textContent?.includes('Image unavailable')
    })

    // The pure-image turn is not dropped and its image loaded.
    assert.equal(await page.$$('#pure img').then(nodes => nodes.length), 1)
    assert.equal(await page.$eval('#pure img', image => image.naturalWidth), 1)
    assert.equal(requests.some(request => request.url === `/nested/api/blobs/${pngId}` && request.cookie.includes('foxwarm_token=fixture-token')), true)
    // No assistant text card is fabricated for it.
    assert.equal((await page.$eval('#pure', element => element.textContent || '')).includes('HERE_IS_TEXT'), false)

    // Mixed content keeps text before the image.
    assert.match(await page.$eval('#mixed', element => element.textContent || ''), /HERE_IS_TEXT/)
    const order = await page.$eval('#mixed', element => {
      const text = Array.from(element.querySelectorAll('*')).find(node => node.textContent?.trim() === 'HERE_IS_TEXT')
      const image = element.querySelector('img')
      if (!text || !image) return 'missing'
      return (text.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'text-first' : 'image-first'
    })
    assert.equal(order, 'text-first')

    // A missing Blob renders an explicit placeholder instead of dropping the turn.
    assert.match(await page.$eval('#missing', element => element.textContent || ''), /Image unavailable/)
  } finally {
    await browser?.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})
