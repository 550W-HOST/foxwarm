import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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

    const render = (id, ref) => createRoot(document.getElementById(id)).render(
      React.createElement(ImageParts, { imageParts: [{ inlineDataRef: ref }], keyPrefix: id })
    )
    render('safe', { blobId: '${pngId}', imageId: 'safe', mimeType: 'image/png', apiPath: '/blobs/${pngId}' })
    render('unsafe', { blobId: '${svgId}', imageId: 'unsafe', mimeType: 'image/svg+xml', apiPath: '/blobs/${svgId}' })
    render('missing', { blobId: '${missingId}', imageId: 'missing', mimeType: 'image/png', apiPath: '/blobs/${missingId}' })
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
    response.end(`<!doctype html><html><body><div id="safe"></div><div id="unsafe"></div><div id="missing"></div><script>${bundle}</script></body></html>`)
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
  } finally {
    await browser?.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})
