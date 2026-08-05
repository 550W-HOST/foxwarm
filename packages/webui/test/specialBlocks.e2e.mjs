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
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-special-blocks-e2e-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')

let browser
let page
let server
let baseUrl

const latexRaw = '\\[\nx^2 + y^2 = z^2\n\\]\n'
const mermaidRaw = '```mermaid\nflowchart LR\n  A --> B\n```\n'
const invalidMermaidRaw = '```mermaid\nflowchart TD\n  A -- broken\n```\n'

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import SpecialBlock, { MermaidDiagram } from ${JSON.stringify(path.join(webuiRoot, 'src/components/SpecialBlock.tsx'))}
  import { renderAssistantMarkdownSegments } from ${JSON.stringify(path.join(webuiRoot, 'src/components/markdownRenderer.ts'))}
  import ${JSON.stringify(path.join(webuiRoot, 'src/index.css'))}

  const latexRaw = ${JSON.stringify(latexRaw)}
  const mermaidRaw = ${JSON.stringify(mermaidRaw)}
  const invalidMermaidRaw = ${JSON.stringify(invalidMermaidRaw)}
  const sanitizedSegments = renderAssistantMarkdownSegments('<img src=x onerror=alert(1)>\\n\\n[bad](javascript:alert(2))')

  createRoot(document.getElementById('root')).render(
    <main className="foxwarm-chat-timeline w-full min-w-0 max-w-full overflow-x-hidden p-4">
      <div className="w-full min-w-0 max-w-[80%]">
        <SpecialBlock kind="latex" label="LaTeX" raw={latexRaw}>
          <div data-latex-fixture>rendered latex</div>
        </SpecialBlock>
        <SpecialBlock kind="mermaid" label="Mermaid" raw={mermaidRaw}>
          <MermaidDiagram source={'flowchart LR\\n  A --> B'} />
        </SpecialBlock>
        <SpecialBlock kind="mermaid" label="Mermaid" raw={invalidMermaidRaw}>
          <MermaidDiagram source={'flowchart TD\\n  A -- broken'} />
        </SpecialBlock>
        <div id="sanitizer-fixture">
          {sanitizedSegments.map((segment, index) => segment.kind === 'html' ? <div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} /> : null)}
        </div>
      </div>
    </main>,
  )
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath],
    outdir: outputDirectory,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
    loader: { '.css': 'css' },
    logLevel: 'silent',
  })

  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'
  server = createServer(async (request, response) => {
    const requestedPath = request.url === '/' ? null : request.url?.slice(1)
    if (!requestedPath) {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(html)
      return
    }
    if (requestedPath === 'favicon.ico') {
      response.statusCode = 204
      response.end()
      return
    }
    try {
      const body = await readFile(path.join(outputDirectory, requestedPath))
      response.setHeader('content-type', requestedPath.endsWith('.css') ? 'text/css' : 'text/javascript')
      response.end(body)
    } catch {
      response.statusCode = 404
      response.end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
  page.on('console', message => console.error(`[browser:${message.type()}] ${message.text()}`))
  page.on('pageerror', error => console.error(`[browser:pageerror] ${error.stack || error.message}`))
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copiedSpecialBlockRaw = text } },
    })
  })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-special-block-kind="latex"]', { timeout: 10_000 })
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

test('shared special block toggles exact raw source and copies with feedback', async () => {
  const latexBlock = await page.$('[data-special-block-kind="latex"]')
  assert.ok(latexBlock)
  assert.ok(await latexBlock.$('[data-special-block-rendered]'))

  await latexBlock.$eval('button[title="Raw LaTeX"]', button => button.click())
  const raw = await latexBlock.$eval('[data-special-block-raw]', element => element.textContent)
  assert.equal(raw, latexRaw)

  await latexBlock.$eval('button[title="Copy Raw LaTeX"]', button => button.click())
  await page.waitForFunction(() => document.querySelector('[data-special-block-kind="latex"] button[title="Copied"]'))
  assert.equal(await page.evaluate(() => window.__copiedSpecialBlockRaw), latexRaw)

  await latexBlock.$eval('button[title="Rendered LaTeX"]', button => button.click())
  assert.ok(await latexBlock.$('[data-latex-fixture]'))
})

test('Mermaid lazy renderer produces bounded strict SVG output', async () => {
  const validBlock = (await page.$$('[data-special-block-kind="mermaid"]'))[0]
  await validBlock.waitForSelector('[data-mermaid-diagram] svg', { timeout: 15_000 })

  const layout = await validBlock.evaluate(element => {
    const svg = element.querySelector('svg')
    return {
      blockWidth: element.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      svgWidth: svg.getBoundingClientRect().width,
      hasScript: !!svg.querySelector('script'),
      hasEventHandler: Array.from(svg.querySelectorAll('*')).some(node => Array.from(node.attributes).some(attribute => attribute.name.toLowerCase().startsWith('on'))),
    }
  })

  assert.ok(layout.blockWidth <= layout.viewportWidth + 1)
  assert.ok(layout.svgWidth <= layout.blockWidth + 1)
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1)
  assert.equal(layout.hasScript, false)
  assert.equal(layout.hasEventHandler, false)
})

test('Mermaid diagrams re-render readably when the WebUI switches to dark mode', async () => {
  const validBlock = (await page.$$('[data-special-block-kind="mermaid"]'))[0]
  const lightSvg = await validBlock.$eval('[data-mermaid-diagram] svg', element => element.innerHTML)

  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.waitForFunction(previous => {
    const svg = document.querySelector('[data-special-block-kind="mermaid"] [data-mermaid-diagram] svg')
    return svg && svg.innerHTML !== previous
  }, { timeout: 15_000 }, lightSvg)

  const darkLayout = await validBlock.$eval('[data-mermaid-diagram] svg', element => ({
    width: element.getBoundingClientRect().width,
    blockWidth: element.closest('[data-special-block]').getBoundingClientRect().width,
  }))
  assert.ok(darkLayout.width <= darkLayout.blockWidth + 1)
})

test('Mermaid syntax failures stay bounded and recoverable through Raw', async () => {
  const invalidBlock = (await page.$$('[data-special-block-kind="mermaid"]'))[1]
  await invalidBlock.waitForSelector('[data-mermaid-error]', { timeout: 15_000 })

  const errorLayout = await invalidBlock.$eval('[data-mermaid-error]', element => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    text: element.textContent,
  }))
  assert.match(errorLayout.text, /could not render/i)
  assert.ok(errorLayout.height <= 160 + 1)

  await invalidBlock.$eval('button[title="Raw Mermaid"]', button => button.click())
  assert.equal(await invalidBlock.$eval('[data-special-block-raw]', element => element.textContent), invalidMermaidRaw)
})

test('assistant segment rendering keeps the production Markdown sanitizer intact', async () => {
  const sanitizerState = await page.$eval('#sanitizer-fixture', element => ({
    html: element.innerHTML,
    images: element.querySelectorAll('img').length,
    scripts: element.querySelectorAll('script').length,
    javascriptLinks: element.querySelectorAll('a[href^="javascript:"]').length,
  }))

  assert.equal(sanitizerState.images, 0)
  assert.equal(sanitizerState.scripts, 0)
  assert.equal(sanitizerState.javascriptLinks, 0)
  assert.doesNotMatch(sanitizerState.html, /onerror|javascript:/i)
})
