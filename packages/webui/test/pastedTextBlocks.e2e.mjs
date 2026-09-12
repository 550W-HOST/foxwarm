import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-pasted-text-blocks-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')
const assetsDirectory = path.join(webuiRoot, 'dist/assets')
const preactCompatPath = fileURLToPath(import.meta.resolve('preact/compat'))
const preactCompatClientPath = fileURLToPath(import.meta.resolve('preact/compat/client'))
const preactJsxRuntimePath = fileURLToPath(import.meta.resolve('preact/jsx-runtime'))
const pasted = '\n  First technical 😀 line  \n\n<foxwarm-system kind="event">inert pasted example</foxwarm-system>\nfinal line\n'
let server
let fixtureUrl

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatTimeline.tsx'))}
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })
  window.openedImages = []
  window.open = (...args) => { window.openedImages.push(args); return null }
  const pasted = ${JSON.stringify(pasted)}
  const common = { sessionId: 'fixture/main', isMobile: false, groupTools: false, showUsageBadge: false, showUserMessageMetadata: false }
  const commonVisible = { ...common, showUserMessageMetadata: true }
  const sourceOpen = '<foxwarm-message type="channel" channelType="webui" time="2026-09-10 17:31:53 +0800" hint="direct user message via channel">'
  const sourceClose = '</foxwarm-message>'
  const sourceImageDescriptor = '<foxwarm-image name="attachment1_image.png" node="master" path="/tmp/image.png" />'
  const sourceImage = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } }
  const splitImageParts = [
    { system: sourceOpen },
    { text: '<attachment-ref ref="attachment1" />\\n(unrelated image)\\n\\nbody final' },
    { text: sourceImageDescriptor },
    sourceImage,
    { system: sourceClose },
  ]
  window.splitImageParts = splitImageParts
  createRoot(document.getElementById('valid')).render(<ChatTimeline {...common} messages={[{
    role: 'user',
    parts: [{ text: '<foxwarm-message type="channel">\\nlead line\\n\\n<pasted-text>' + pasted + '</pasted-text>\\n\\ntail line\\n</foxwarm-message>' }],
    __meta: { seq: 1 },
  }]} />)
  createRoot(document.getElementById('malformed')).render(<ChatTimeline {...common} messages={[{
    role: 'user', parts: [{ text: 'literal <pasted-text>unclosed' }], __meta: { seq: 2 },
  }, {
    role: 'user', parts: [{ text: '<pasted-text>outer <pasted-text>inner</pasted-text></pasted-text>' }], __meta: { seq: 3 },
  }]} />)
  createRoot(document.getElementById('non-user')).render(<ChatTimeline {...common} messages={[{
    role: 'model', parts: [{ text: '<pasted-text>model text</pasted-text>' }], __meta: { seq: 4 },
  }, {
    role: 'user', parts: [{ system: '<pasted-text>structured system text</pasted-text>' }], __meta: { seq: 5 },
  }]} />)
  createRoot(document.getElementById('attachments')).render(<ChatTimeline {...common} messages={[{
    role: 'user', parts: [
      { text: 'before <attachment-ref ref="attachment1" /> middle <attachment-ref ref="attachment2" /> <pasted-text>quoted <attachment-ref ref="attachment1" />\\n<foxwarm-file name="attachment1_quoted_wrong.txt" node="master" path="/quoted.txt" mime="text/plain" /></pasted-text> after <attachment-ref ref="attachment3" /> <attachment-ref ref="attachment4" />' },
      { text: '<foxwarm-image name="attachment1_same_name.png" node="master" path="/tmp/same.png" />' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } },
      { text: '<foxwarm-file name="attachment2_same_name.png" node="master" path="/tmp/same.txt" mime="text/plain" />' },
      { text: '<foxwarm-image name="attachment3_unsafe.svg" node="master" path="/tmp/unsafe.svg" />' },
      { inlineDataRef: { mimeType: 'image/svg+xml', apiPath: '/unsafe.svg' } },
      { text: '<foxwarm-image name="attachment4_missing.png" node="master" path="/tmp/missing.png" />' },
      { inlineDataUnavailable: { mimeType: 'image/png' } },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } },
    ], __meta: { seq: 6 },
  }, {
    role: 'user', parts: [{ text: 'literal <attachment-ref ref="unresolved" />' }], __meta: { seq: 7 },
  }]} />)
  const flowParts = [
    { text: 'A <attachment-ref ref="attachment1" /> B' },
    { text: '<foxwarm-file name="attachment1_flow.txt" node="master" path="/tmp/flow.txt" mime="text/plain" />' },
  ]
  createRoot(document.getElementById('canonical-flow')).render(<ChatTimeline {...common} messages={[{ role: 'user', parts: flowParts, __meta: { seq: 8 } }]} />)
  createRoot(document.getElementById('optimistic-flow')).render(<ChatTimeline {...common} messages={[{ role: 'user', parts: flowParts, __meta: { optimisticId: 'optimistic-flow' } }]} />)
  createRoot(document.getElementById('file-only')).render(<ChatTimeline {...common} messages={[{
    role: 'user',
    parts: [{ system: '<foxwarm-message type="channel" channelType="webui">\\n<attachment-ref ref="attachment1" />\\n<foxwarm-file name="attachment1_original_name.txt" node="master" path="/tmp/original.txt" mime="text/plain" />\\n</foxwarm-message>' }],
    __meta: { seq: 9 },
  }]} />)
  createRoot(document.getElementById('legacy-prefixed')).render(<ChatTimeline {...common} showUserMessageMetadata={true} messages={[{
    role: 'user', parts: [
      { text: '<foxwarm-file name="attachment1_legacy_file.txt" node="master" path="/tmp/legacy.txt" mime="text/plain" />' },
      { text: '<foxwarm-image name="attachment2_legacy_image.png" node="master" path="/tmp/legacy.png" />' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } },
    ], __meta: { seq: 10 },
  }]} />)
  createRoot(document.getElementById('split-image-visible')).render(<ChatTimeline {...commonVisible} messages={[{ role: 'user', parts: splitImageParts, __meta: { seq: 11 } }]} />)
  createRoot(document.getElementById('split-image-hidden')).render(<ChatTimeline {...common} messages={[{ role: 'user', parts: splitImageParts, __meta: { seq: 12 } }]} />)
  createRoot(document.getElementById('split-image-unwrapped')).render(<ChatTimeline {...common} messages={[{ role: 'user', parts: splitImageParts.slice(1, -1), __meta: { seq: 13 } }]} />)
  createRoot(document.getElementById('split-image-inline')).render(<ChatTimeline {...commonVisible} messages={[{ role: 'user', parts: [
    { system: sourceOpen }, { text: 'A <attachment-ref ref="attachment1" /> B' }, { text: sourceImageDescriptor }, sourceImage, { system: sourceClose },
  ], __meta: { seq: 14 } }]} />)
  createRoot(document.getElementById('source-pure')).render(<ChatTimeline {...commonVisible} messages={[{
    role: 'user', parts: [{ system: sourceOpen + '\\nplain body\\n' + sourceClose }], __meta: { seq: 15 },
  }]} />)
  createRoot(document.getElementById('source-file')).render(<ChatTimeline {...commonVisible} messages={[{
    role: 'user', parts: [{ system: sourceOpen + '\\n<attachment-ref ref="attachment1" />\\n<foxwarm-file name="attachment1_notes.txt" node="master" path="/tmp/notes.txt" mime="text/plain" />\\nfile body\\n' + sourceClose }], __meta: { seq: 16 },
  }]} />)
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: { react: preactCompatPath, 'react-dom': preactCompatPath, 'react-dom/client': preactCompatClientPath, 'react/jsx-runtime': preactJsxRuntimePath },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent',
  })
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running pasted-text history browser tests')
  const css = await readFile(path.join(assetsDirectory, cssAsset), 'utf8')
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(await readFile(path.join(outputDirectory, 'fixture.js')))
      return
    }
    if (request.url === '/fixture.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      response.end(css)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><section id="valid"></section><section id="malformed"></section><section id="non-user"></section><section id="attachments"></section><section id="canonical-flow"></section><section id="optimistic-flow"></section><section id="file-only"></section><section id="legacy-prefixed"></section><section id="split-image-visible"></section><section id="split-image-hidden"></section><section id="split-image-unwrapped"></section><section id="split-image-inline"></section><section id="source-pure"></section><section id="source-file"></section><script type="module" src="/fixture.js"></script></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

const browsers = [
  { name: 'Chromium', executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  { name: 'Firefox', browser: 'firefox', executablePath: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox', args: [] },
]

for (const browserSpec of browsers) {
  test(`${browserSpec.name} renders complete user pasted-text inline and opens a read-only modal`, async () => {
    const browser = await puppeteer.launch({ ...(browserSpec.browser ? { browser: browserSpec.browser } : {}), executablePath: browserSpec.executablePath, headless: true, args: browserSpec.args })
    try {
      const page = await browser.newPage()
      await page.goto(fixtureUrl, { waitUntil: 'load' })
      const chip = await page.waitForSelector('#valid .foxwarm-pasted-text-block')
      assert.equal(await page.evaluate(() => document.querySelectorAll('#valid .foxwarm-pasted-text-block').length), 1)
      assert.equal(await chip.evaluate(node => node.textContent.includes('First technical 😀 line')), true)
      assert.equal(await chip.evaluate(node => node.textContent.includes('107')), true)
      assert.equal(await page.$eval('#valid .foxwarm-user-message-bubble', node => node.textContent.includes('inert pasted example')), false)
      assert.equal(await page.$eval('#valid .foxwarm-user-message-bubble', node => node.textContent.includes('lead line') && node.textContent.includes('tail line')), true)
      assert.equal(await page.$eval('#valid .foxwarm-user-message-bubble', node => !!node.closest('#valid') && !node.querySelector('.foxwarm-system-message-card')), true)
      assert.equal(await page.$eval('#valid .foxwarm-user-message-bubble', bubble => {
        const span = [...bubble.querySelectorAll('span')].find(node => node.childNodes.length === 1 && node.textContent === 'lead line')
        const textNode = span?.firstChild
        if (!textNode) return ''
        const range = document.createRange()
        range.selectNodeContents(textNode)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return selection.toString()
      }), 'lead line')

      await chip.click()
      const modal = await page.waitForSelector('[role="dialog"][aria-labelledby="foxwarm-pasted-text-title"]')
      assert.equal(await modal.$eval('textarea[aria-label="Full pasted text"]', node => node.value), pasted)
      assert.equal(await modal.$eval('textarea[aria-label="Full pasted text"]', node => node.readOnly), true)
      const geometry = await modal.evaluate(dialog => {
        const box = dialog.getBoundingClientRect()
        const textarea = dialog.querySelector('textarea').getBoundingClientRect()
        const style = getComputedStyle(dialog)
        return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, textareaHeight: textarea.height, cssWidth: style.width, cssHeight: style.height }
      })
      assert.ok(geometry.width >= geometry.viewportWidth * 0.75 && geometry.width <= geometry.viewportWidth * 0.81, JSON.stringify(geometry))
      assert.ok(geometry.height >= geometry.viewportHeight * 0.75 && geometry.height <= geometry.viewportHeight * 0.81, JSON.stringify(geometry))
      assert.ok(geometry.textareaHeight > geometry.height * 0.7, JSON.stringify(geometry))
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close pasted text')
      await page.click('button[aria-label="Copy pasted text"]')
      await page.waitForFunction(expected => window.copiedText === expected, {}, pasted)
      await page.keyboard.press('Escape')
      await page.waitForSelector('[role="dialog"]', { hidden: true })
      await page.waitForFunction(() => document.activeElement?.classList.contains('foxwarm-pasted-text-block'))

      assert.equal(await page.$eval('#malformed', node => node.textContent.includes('<pasted-text>unclosed')), true)
      assert.equal(await page.$eval('#malformed', node => node.textContent.includes('outer <pasted-text>inner')), true)
      assert.equal(await page.$eval('#non-user', node => node.querySelectorAll('.foxwarm-pasted-text-block').length), 0)
      assert.deepEqual(await page.$$eval('#attachments .foxwarm-inline-history-attachment', nodes => nodes.map(node => node.dataset.attachmentRef)), [
        'attachment1', 'attachment2', 'attachment3', 'attachment4',
      ])
      assert.equal(await page.$eval('#attachments', node => node.textContent.includes('before') && node.textContent.includes('middle') && node.textContent.includes('after')), true)
      assert.equal(await page.$eval('#attachments', node => node.textContent.includes('<attachment-ref ref="unresolved" />')), true)
      assert.equal(await page.$$eval('#attachments img', nodes => nodes.length), 2)
      assert.equal(await page.$eval('#attachments [data-attachment-ref="attachment3"] a', link => link.textContent), 'Download image attachment')
      assert.match(await page.$eval('#attachments [data-attachment-ref="attachment4"]', node => node.textContent), /Image unavailable/)
      await page.click('#attachments [data-attachment-ref="attachment1"] button[aria-label="Open same_name.png"]')
      await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(() => window.openedImages.length), 2)
      assert.equal(await page.evaluate(() => window.openedImages.every(args => String(args[0]).startsWith('data:image/png;base64,') && args[1] === '_blank')), true)
      assert.equal(await page.$eval('#file-only [data-attachment-ref="attachment1"]', node => node.textContent.includes('original_name.txt')), true)
      assert.equal(await page.$eval('#file-only', node => node.textContent.includes('attachment1_original_name.txt')), false)
      await page.click('#attachments .foxwarm-pasted-text-block')
      assert.equal(await page.$eval('[role="dialog"] textarea', node => node.value), 'quoted <attachment-ref ref="attachment1" />\n<foxwarm-file name="attachment1_quoted_wrong.txt" node="master" path="/quoted.txt" mime="text/plain" />')
      await page.keyboard.press('Escape')
      assert.equal(await page.$$('#attachments [data-attachment-ref="attachment1"]').then(nodes => nodes.length), 1)
      assert.equal(await page.$eval('#attachments [data-attachment-ref="attachment1"]', node => node.textContent.includes('same_name.png') && !node.textContent.includes('quoted_wrong.txt')), true)
      assert.equal(await page.$$('#legacy-prefixed .foxwarm-inline-history-attachment').then(nodes => nodes.length), 0)
      assert.equal(await page.$eval('#legacy-prefixed', node => node.textContent.includes('attachment1_legacy_file.txt') && node.textContent.includes('attachment2_legacy_image.png')), true)
      assert.equal(await page.$$('#legacy-prefixed img').then(nodes => nodes.length), 1)

      for (const sectionId of ['canonical-flow', 'optimistic-flow']) {
        const inlineGeometry = await page.$eval(`#${sectionId}`, section => {
          const findTextRect = expected => {
            const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
            let node
            while ((node = walker.nextNode())) {
              if (node.textContent === expected) {
                const range = document.createRange(); range.selectNodeContents(node)
                return range.getBoundingClientRect()
              }
            }
            return null
          }
          const a = findTextRect('A ')
          const b = findTextRect(' B')
          const chip = section.querySelector('[data-attachment-ref="attachment1"]')?.getBoundingClientRect()
          return a && b && chip ? {
            aRight: a.right, aCenter: (a.top + a.bottom) / 2,
            chipLeft: chip.left, chipRight: chip.right, chipCenter: (chip.top + chip.bottom) / 2,
            bLeft: b.left, bCenter: (b.top + b.bottom) / 2,
          } : null
        })
        assert.ok(inlineGeometry, sectionId)
        assert.ok(inlineGeometry.aRight <= inlineGeometry.chipLeft + 1, JSON.stringify({ sectionId, inlineGeometry }))
        assert.ok(inlineGeometry.chipRight <= inlineGeometry.bLeft + 1, JSON.stringify({ sectionId, inlineGeometry }))
        assert.ok(Math.max(inlineGeometry.aCenter, inlineGeometry.chipCenter, inlineGeometry.bCenter) - Math.min(inlineGeometry.aCenter, inlineGeometry.chipCenter, inlineGeometry.bCenter) < 8, JSON.stringify({ sectionId, inlineGeometry }))
      }

      const splitPartsBefore = await page.evaluate(() => JSON.stringify(window.splitImageParts))
      for (const treatment of ['default-light', 'default-dark', 'console']) {
        await page.evaluate(value => {
          document.documentElement.classList.toggle('dark', value === 'default-dark')
          if (value === 'console') document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
          else document.documentElement.removeAttribute('data-foxwarm-component-treatment')
        }, treatment)
        const splitGeometry = await page.$eval('#split-image-visible', section => {
          const metadata = [...section.querySelectorAll('.foxwarm-lightweight-metadata-line')].map(node => node.getBoundingClientRect())
          const body = [...section.querySelectorAll('.foxwarm-user-rendered-line')]
            .filter(node => node.textContent.trim() === '(unrelated image)' || node.textContent.trim() === 'body final')
            .map(node => ({ text: node.textContent.trim(), rect: node.getBoundingClientRect() }))
          const chip = section.querySelector('[data-attachment-ref="attachment1"]').getBoundingClientRect()
          return {
            open: { top: metadata[0].top, bottom: metadata[0].bottom },
            close: { top: metadata.at(-1).top, bottom: metadata.at(-1).bottom },
            first: body.find(item => item.text === '(unrelated image)').rect.toJSON(),
            last: body.find(item => item.text === 'body final').rect.toJSON(),
            chip: chip.toJSON(),
          }
        })
        assert.ok(splitGeometry.open.bottom <= splitGeometry.chip.top + 1, JSON.stringify({ treatment, splitGeometry }))
        assert.ok(splitGeometry.last.bottom <= splitGeometry.close.top + 1, JSON.stringify({ treatment, splitGeometry }))
        assert.ok(splitGeometry.last.top - splitGeometry.first.top > 35, JSON.stringify({ treatment, splitGeometry }))

        const inlineSourceGeometry = await page.$eval('#split-image-inline', section => {
          const findText = expected => {
            const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
            let node
            while ((node = walker.nextNode())) {
              if (node.textContent === expected) { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON() }
            }
          }
          const metadata = [...section.querySelectorAll('.foxwarm-lightweight-metadata-line')].map(node => node.getBoundingClientRect().toJSON())
          return { a: findText('A '), b: findText(' B'), chip: section.querySelector('[data-attachment-ref]').getBoundingClientRect().toJSON(), metadata }
        })
        const centers = [inlineSourceGeometry.a, inlineSourceGeometry.chip, inlineSourceGeometry.b].map(rect => (rect.top + rect.bottom) / 2)
        assert.ok(Math.max(...centers) - Math.min(...centers) < 8, JSON.stringify({ treatment, inlineSourceGeometry }))
        assert.ok(inlineSourceGeometry.metadata[0].bottom <= inlineSourceGeometry.chip.top + 1, JSON.stringify({ treatment, inlineSourceGeometry }))
        assert.ok(inlineSourceGeometry.chip.bottom <= inlineSourceGeometry.metadata.at(-1).top + 1, JSON.stringify({ treatment, inlineSourceGeometry }))

        for (const sectionId of ['source-pure', 'source-file']) {
          const controls = await page.$eval(`#${sectionId}`, section => {
            const metadata = [...section.querySelectorAll('.foxwarm-lightweight-metadata-line')].map(node => node.getBoundingClientRect().toJSON())
            const chip = section.querySelector('[data-attachment-ref]')?.getBoundingClientRect().toJSON()
            const bodyLine = [...section.querySelectorAll('.foxwarm-user-rendered-line')].find(node => node.textContent.trim() === 'plain body' || node.textContent.trim() === 'file body')?.getBoundingClientRect().toJSON()
            return { metadata, chip, bodyLine }
          })
          const firstContent = controls.chip || controls.bodyLine
          assert.ok(controls.metadata[0].bottom <= firstContent.top + 1, JSON.stringify({ treatment, sectionId, controls }))
          assert.ok(controls.bodyLine.bottom <= controls.metadata.at(-1).top + 1, JSON.stringify({ treatment, sectionId, controls }))
        }
      }
      assert.equal(await page.evaluate(() => JSON.stringify(window.splitImageParts)), splitPartsBefore)
      const renderedSourceSelection = await page.$eval('#split-image-visible .foxwarm-user-message-bubble', bubble => {
        const range = document.createRange(); range.selectNodeContents(bubble)
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
        return selection.toString()
      })
      assert.match(renderedSourceSelection, /channel">\n/)
      assert.match(renderedSourceSelection, /body final\n+<\/foxwarm-message>/)
      assert.equal(await page.$$('#split-image-visible [data-user-wrapper-boundary]').then(nodes => nodes.length), 2)
      assert.equal(await page.$$('#source-pure [data-user-wrapper-boundary], #source-file [data-user-wrapper-boundary]').then(nodes => nodes.length), 0)
      assert.equal(await page.$eval('#split-image-hidden', section => section.querySelectorAll('.foxwarm-lightweight-metadata-line, [data-user-wrapper-boundary]').length), 0)
      assert.equal(await page.$eval('#split-image-hidden', section => section.textContent.includes('foxwarm-message')), false)
      const hiddenGeometry = await page.evaluate(() => {
        const measure = id => {
          const section = document.getElementById(id)
          const bubble = section.querySelector('.foxwarm-user-message-bubble').getBoundingClientRect()
          const chip = section.querySelector('[data-attachment-ref]').getBoundingClientRect()
          const body = [...section.querySelectorAll('.foxwarm-user-rendered-line')].find(node => node.textContent.trim() === '(unrelated image)').getBoundingClientRect()
          return { height: bubble.height, chipTop: chip.top - bubble.top, bodyTop: body.top - bubble.top }
        }
        return { hidden: measure('split-image-hidden'), unwrapped: measure('split-image-unwrapped') }
      })
      assert.ok(Math.abs(hiddenGeometry.hidden.height - hiddenGeometry.unwrapped.height) < 1, JSON.stringify(hiddenGeometry))
      assert.ok(Math.abs(hiddenGeometry.hidden.chipTop - hiddenGeometry.unwrapped.chipTop) < 1, JSON.stringify(hiddenGeometry))
      assert.ok(Math.abs(hiddenGeometry.hidden.bodyTop - hiddenGeometry.unwrapped.bodyTop) < 1, JSON.stringify(hiddenGeometry))
      assert.equal(await page.$$eval('#split-image-visible img', nodes => nodes.length), 1)
      assert.equal(await page.$eval('#split-image-visible [data-attachment-ref="attachment1"]', node => node.textContent.includes('image.png') && !node.textContent.includes('attachment1_')), true)
    } finally {
      await browser.close()
    }
  })
}
