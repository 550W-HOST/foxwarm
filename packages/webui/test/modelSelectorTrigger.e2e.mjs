import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-model-trigger-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')
const assetsDirectory = path.join(webuiRoot, 'dist/assets')
let server
let browser
let page
let fixtureUrl

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  window.fetch = async () => ({ ok: true, json: async () => ({ commands: [] }) })
  const noop = async () => {}
  const props = {
    sessionId: 'fixture/main', sessionMissing: false, loading: false, asrAvailable: false,
    modelOptions: [],
    currentModelKey: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates',
    sessionModel: 'provider/a-very-long-current-model-label-that-needs-room-before-it-truncates',
    defaultModelKey: 'default/model',
    childModelDefault: 'provider/an-equally-long-child-model-label-that-must-not-overflow',
    effectiveChildModelKey: 'provider/an-equally-long-child-model-label-that-must-not-overflow',
    effectiveEffort: 'xhigh', effectiveChildEffort: 'medium',
    onChangeModel: noop, onChangeChildModel: noop, onChangeEffort: noop, onChangeChildEffort: noop,
    onRefreshModels: noop, onOpenModelSettings: () => {}, onSend: async () => false,
    onTranscribeAudio: async () => ({ text: '', status: 200, rawLength: 0, textLength: 0, responsePreview: '' }),
    onCreateStreamingTranscriber: async () => ({ sendAudioChunk() {}, stop() {}, cancel() {} }),
  }
  createRoot(document.getElementById('root')).render(<div id="host" style={{ width: '900px', maxWidth: '100%' }}><ChatComposer {...props} /></div>)
  window.setHostWidth = width => { document.getElementById('host').style.width = width + 'px' }
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react-dom/client': 'preact/compat/client', 'react/jsx-runtime': 'preact/jsx-runtime' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent',
  })
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the model trigger browser test')
  const css = await readFile(path.join(assetsDirectory, cssAsset), 'utf8')
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(path.join(outputDirectory, 'fixture.js'))); return }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-model-selector-trigger')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

test('model trigger grows to 30rem for long current and child labels', async () => {
  const geometry = await page.$eval('.foxwarm-model-selector-root', node => ({ width: node.getBoundingClientRect().width, maxWidth: getComputedStyle(node).maxWidth }))
  assert.equal(geometry.maxWidth, '480px')
  assert.ok(geometry.width > 304 && geometry.width <= 480, JSON.stringify(geometry))
})

test('model trigger shrinks and ellipsizes without horizontal overflow in a narrow composer', async () => {
  await page.setViewport({ width: 360, height: 700 })
  await page.evaluate(() => { document.getElementById('host').style.width = '100%' })
  const geometry = await page.evaluate(() => {
    const host = document.getElementById('host').getBoundingClientRect()
    const root = document.querySelector('.foxwarm-model-selector-root').getBoundingClientRect()
    const trigger = document.querySelector('.foxwarm-model-selector-trigger')
    const labels = [...trigger.querySelectorAll('.truncate')]
    return {
      hostRight: host.right, rootRight: root.right, rootWidth: root.width,
      triggerClientWidth: trigger.clientWidth, triggerScrollWidth: trigger.scrollWidth,
      labelClipped: labels.some(label => label.scrollWidth > label.clientWidth),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sendVisible: !!document.querySelector('button[type="submit"]'),
    }
  })
  assert.ok(geometry.rootRight <= geometry.hostRight + 0.5, JSON.stringify(geometry))
  assert.ok(geometry.rootWidth <= 300, JSON.stringify(geometry))
  assert.equal(geometry.labelClipped, true)
  assert.ok(geometry.documentOverflow <= 0, JSON.stringify(geometry))
  assert.equal(geometry.sendVisible, true)
})
