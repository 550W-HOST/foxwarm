import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const pasted = '\n  First technical 😀 line  \n\n<foxwarm-system kind="event">inert pasted example</foxwarm-system>\nfinal line\n'
let server
let fixtureUrl

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatTimeline.tsx'))}
  import ${JSON.stringify(path.join(webuiRoot, 'src/index.css'))}

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })
  const pasted = ${JSON.stringify(pasted)}
  const common = { sessionId: 'fixture/main', isMobile: false, groupTools: false, showUsageBadge: false, showUserMessageMetadata: false }
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
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react-dom/client': 'preact/compat/client', 'react/jsx-runtime': 'preact/jsx-runtime' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent',
  })
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(await readFile(path.join(outputDirectory, 'fixture.js')))
      return
    }
    if (request.url === '/fixture.css') {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      response.end(await readFile(path.join(outputDirectory, 'fixture.css')))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><section id="valid"></section><section id="malformed"></section><section id="non-user"></section><script type="module" src="/fixture.js"></script></body></html>')
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
      assert.equal(await page.$$eval('.foxwarm-pasted-text-block', nodes => nodes.length), 1)
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
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close pasted text')
      await page.click('button[aria-label="Copy pasted text"]')
      await page.waitForFunction(expected => window.copiedText === expected, {}, pasted)
      await page.keyboard.press('Escape')
      await page.waitForSelector('[role="dialog"]', { hidden: true })
      await page.waitForFunction(() => document.activeElement?.classList.contains('foxwarm-pasted-text-block'))

      assert.equal(await page.$eval('#malformed', node => node.textContent.includes('<pasted-text>unclosed')), true)
      assert.equal(await page.$eval('#malformed', node => node.textContent.includes('outer <pasted-text>inner')), true)
      assert.equal(await page.$eval('#non-user', node => node.querySelectorAll('.foxwarm-pasted-text-block').length), 0)
    } finally {
      await browser.close()
    }
  })
}
