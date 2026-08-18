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
const reviewerResourceRequests = []

const latexRaw = '\\[\nx^2 + y^2 = z^2\n\\]\n'
const mermaidRaw = '```mermaid\nflowchart LR\n  A --> B\n```\n'
const invalidMermaidRaw = '```mermaid\nflowchart TD\n  A -- broken\n```\n'
const ordinaryCodeRaw = '```js\nconst compact = true\n```\n'

await writeFile(entryPath, `
  import { createRoot } from 'react-dom/client'
  import SpecialBlock, { MermaidDiagram, sanitizeMermaidSvg } from ${JSON.stringify(path.join(webuiRoot, 'src/components/SpecialBlock.tsx'))}
  import { renderAssistantMarkdownSegments } from ${JSON.stringify(path.join(webuiRoot, 'src/components/markdownRenderer.ts'))}
  import ${JSON.stringify(path.join(webuiRoot, 'src/index.css'))}

  const latexRaw = ${JSON.stringify(latexRaw)}
  const mermaidRaw = ${JSON.stringify(mermaidRaw)}
  const invalidMermaidRaw = ${JSON.stringify(invalidMermaidRaw)}
  const ordinaryCodeRaw = ${JSON.stringify(ordinaryCodeRaw)}
  const sanitizedSegments = renderAssistantMarkdownSegments('<img src=x onerror=alert(1)>\\n\\n[bad](javascript:alert(2))')
  const nestedMermaid = '- Diagram:\\n\\n  \`\`\`mermaid\\n  flowchart LR\\n    A --> B\\n  \`\`\`\\n- After'
  const nestedMath = '> Formula:\\n> \\\\[\\n> x = y\\n> \\\\]\\n'
  const oneLineListMath = '- first \\\\[x\\\\]\\n- second'
  const mixedSpecials = 'Top\\n\\n\`\`\`mermaid\\nflowchart LR\\nA-->B\\n\`\`\`\\n\\n- nested\\n\\n  \`\`\`mermaid\\n  flowchart LR\\n  B-->C\\n  \`\`\`\\n\\n\\\\[\\nz=1\\n\\\\]'
  const unsafeMermaidSources = [
    'flowchart LR\\nA@{ img: "https://reviewer.invalid/node.png" }',
    'flowchart LR\\nA@{ img: "/reviewer-image.png" }',
    '%%{init: {"themeCSS":"rect{fill:url(/reviewer-theme.png)}"}}%%\\nflowchart LR\\nA-->B',
    'flowchart LR\\nA-->B\\nclick A href "https://reviewer.invalid/click"',
    '---\\nconfig:\\n  themeCSS: "rect{fill:url(https://reviewer.invalid/frontmatter.png)}"\\n---\\nflowchart LR\\nA-->B',
    'flowchart LR\\nA-->B\\nstyle A fill:url(https://reviewer.invalid/direct-css.png)',
    'flowchart LR\\nA-->B\\nclassDef custom fill:#fff',
    'flowchart TD\\nA@{ label: "}", img: "https://example.invalid/brace-bypass.png", pos: "t", h: 60 }',
    'flowchart TD\\nA@{ label: "}", img: "/reviewer-bypass.png", pos: "t", h: 60 }',
    'flowchart TD\\nA@{ "\\\\x69mg": "https://example.invalid/x-key.png" }',
    "flowchart TD\\nA@{ 'i\\\\x6dg': '/reviewer-x-key.png' }",
    'flowchart TD\\nX["@{"]\\nA@{ img: "https://example.invalid/after-literal.png", label: "remote" }',
    'flowchart TD\\n%% comment containing @{ before resource\\nA@{ img: "/reviewer-after-comment.png", label: "remote" }',
  ]
  const benignMermaidSources = [
    'flowchart LR\\nclick[Click guide] --> B',
    'flowchart LR\\nhref[Href guide] --> B',
    'sequenceDiagram\\nA->>B: Call url(foo) safely',
    'flowchart TD\\nX["@{"]\\nX-->B',
    'flowchart TD\\n%% comment containing @{ only\\nX-->B',
  ]
  const postSanitizedSvg = sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>@import "https://reviewer.invalid/theme.css";.bad{fill:url(https://reviewer.invalid/a.png)}.ok{marker-end:url(#arrow)}</style><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><a href="https://reviewer.invalid/link"><text>kept text</text></a><image href="/reviewer-image.png"/><use xlink:href="https://reviewer.invalid/xlink.svg#shape"/><rect onclick="alert(1)" fill="javascript:alert(1)" style="fill:url(https://reviewer.invalid/b.png)" marker-end="url(#arrow)"/></svg>')

  const AssistantSegments = ({ id, source }) => {
    const segments = renderAssistantMarkdownSegments(source)
    return <div id={id} className="foxwarm-markdown prose prose-sm max-w-none">
      {segments.map((segment, index) => segment.kind === 'html' ? (
        <div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} />
      ) : segment.kind === 'latex' ? (
        <SpecialBlock key={index} kind="latex" label="LaTeX" raw={segment.raw}>
          <div dangerouslySetInnerHTML={{ __html: segment.html }} />
        </SpecialBlock>
      ) : (
        <SpecialBlock key={index} kind="mermaid" label="Mermaid" raw={segment.raw}>
          <MermaidDiagram source={segment.source} />
        </SpecialBlock>
      ))}
    </div>
  }

  createRoot(document.getElementById('root')).render(
    <main className="foxwarm-chat-messages w-full min-w-0 max-w-full overflow-x-hidden p-4">
      <div className="w-full min-w-0 max-w-[80%]">
        <div id="latex-layout-fixture">
          <SpecialBlock kind="latex" label="LaTeX" raw={latexRaw}>
            <span className="katex-display"><span className="katex" data-latex-fixture>rendered latex</span></span>
          </SpecialBlock>
        </div>
        <div id="mermaid-layout-fixture">
          <SpecialBlock kind="mermaid" label="Mermaid" raw={mermaidRaw}>
            <MermaidDiagram source={'flowchart LR\\n  A --> B'} />
          </SpecialBlock>
        </div>
        <SpecialBlock kind="mermaid" label="Mermaid" raw={invalidMermaidRaw}>
          <MermaidDiagram source={'flowchart TD\\n  A -- broken'} />
        </SpecialBlock>
        <AssistantSegments id="ordinary-code-fixture" source={ordinaryCodeRaw} />
        <div id="sanitizer-fixture">
          {sanitizedSegments.map((segment, index) => segment.kind === 'html' ? <div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} /> : null)}
        </div>
        <AssistantSegments id="nested-mermaid-fixture" source={nestedMermaid} />
        <AssistantSegments id="nested-math-fixture" source={nestedMath} />
        <AssistantSegments id="one-line-list-math-fixture" source={oneLineListMath} />
        <AssistantSegments id="mixed-specials-fixture" source={mixedSpecials} />
        <div id="security-fixtures">
          {unsafeMermaidSources.map((source, index) => (
            <SpecialBlock key={index} kind="mermaid" label="Mermaid" raw={source}>
              <MermaidDiagram source={source} />
            </SpecialBlock>
          ))}
        </div>
        <div id="benign-policy-fixtures">
          {benignMermaidSources.map((source, index) => (
            <SpecialBlock key={index} kind="mermaid" label="Mermaid" raw={source}>
              <MermaidDiagram source={source} />
            </SpecialBlock>
          ))}
        </div>
        <div id="post-sanitized-svg" dangerouslySetInnerHTML={{ __html: postSanitizedSvg }} />
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
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (/reviewer\.invalid|example\.invalid|reviewer-(?:image|theme|bypass)|brace-bypass/.test(request.url())) {
      reviewerResourceRequests.push(request.url())
      void request.abort()
      return
    }
    void request.continue()
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

test('ordinary code and special-block chrome keep their compact spacing and hover visibility', async () => {
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

  const initial = await page.evaluate(() => {
    const code = document.querySelector('#ordinary-code-fixture pre')
    const latex = document.querySelector('#latex-layout-fixture [data-special-block]')
    const mermaid = document.querySelector('#mermaid-layout-fixture [data-special-block]')
    const latexRendered = latex.querySelector('[data-special-block-rendered]')
    const latexDisplay = latex.querySelector('.katex-display')
    const mermaidRendered = mermaid.querySelector('[data-special-block-rendered]')
    return {
      codeMarginTop: getComputedStyle(code).marginTop,
      codeMarginBottom: getComputedStyle(code).marginBottom,
      latexHeaders: latex.querySelectorAll('[data-special-block-header]').length,
      latexHasBorderClass: latex.classList.contains('border'),
      latexBorderTopWidth: getComputedStyle(latex).borderTopWidth,
      latexBackgroundColor: getComputedStyle(latex).backgroundColor,
      latexPaddingTop: getComputedStyle(latexRendered).paddingTop,
      latexPaddingBottom: getComputedStyle(latexRendered).paddingBottom,
      latexDisplayMarginTop: getComputedStyle(latexDisplay).marginTop,
      latexDisplayMarginBottom: getComputedStyle(latexDisplay).marginBottom,
      mermaidHeader: mermaid.querySelector('[data-special-block-header]')?.textContent?.trim(),
      mermaidHasBorderClass: mermaid.classList.contains('border'),
      mermaidHasBackgroundClass: mermaid.classList.contains('bg-slate-50/60'),
      mermaidPaddingTop: getComputedStyle(mermaidRendered).paddingTop,
      mermaidPaddingBottom: getComputedStyle(mermaidRendered).paddingBottom,
      latexControlsOpacity: getComputedStyle(latex.querySelector('[data-special-block-controls]')).opacity,
      mermaidControlsOpacity: getComputedStyle(mermaid.querySelector('[data-special-block-controls]')).opacity,
    }
  })

  assert.equal(initial.codeMarginTop, '8px')
  assert.equal(initial.codeMarginBottom, '8px')
  assert.equal(initial.latexHeaders, 0)
  assert.equal(initial.latexHasBorderClass, false)
  assert.equal(initial.latexBorderTopWidth, '0px')
  assert.equal(initial.latexBackgroundColor, 'rgba(0, 0, 0, 0)')
  assert.equal(initial.latexPaddingTop, initial.latexPaddingBottom)
  assert.equal(initial.latexPaddingTop, '8px')
  assert.equal(initial.latexDisplayMarginTop, '0px')
  assert.equal(initial.latexDisplayMarginBottom, '0px')
  assert.equal(initial.mermaidHeader, 'Mermaid')
  assert.equal(initial.mermaidHasBorderClass, true)
  assert.equal(initial.mermaidHasBackgroundClass, true)
  assert.equal(initial.mermaidPaddingTop, '32px')
  assert.equal(initial.mermaidPaddingBottom, '8px')
  assert.equal(initial.latexControlsOpacity, '0')
  assert.equal(initial.mermaidControlsOpacity, '0')

  for (const fixture of ['#latex-layout-fixture', '#mermaid-layout-fixture']) {
    await page.$eval(`${fixture} [data-special-block]`, element => element.scrollIntoView({ block: 'center' }))
    await page.hover(`${fixture} [data-special-block]`)
    await page.waitForFunction(selector => (
      getComputedStyle(document.querySelector(`${selector} [data-special-block-controls]`)).opacity === '1'
    ), {}, fixture)
  }

  await page.$eval('#latex-layout-fixture button[title="Raw LaTeX"]', button => button.click())
  await page.$eval('#mermaid-layout-fixture button[title="Raw Mermaid"]', button => button.click())
  const rawSpacing = await page.evaluate(() => {
    const latex = getComputedStyle(document.querySelector('#latex-layout-fixture [data-special-block-raw]'))
    const mermaid = getComputedStyle(document.querySelector('#mermaid-layout-fixture [data-special-block-raw]'))
    return {
      latexTop: latex.paddingTop,
      latexBottom: latex.paddingBottom,
      mermaidTop: mermaid.paddingTop,
      mermaidBottom: mermaid.paddingBottom,
    }
  })
  assert.deepEqual(rawSpacing, {
    latexTop: '8px',
    latexBottom: '8px',
    mermaidTop: '32px',
    mermaidBottom: '8px',
  })
  await page.$eval('#latex-layout-fixture button[title="Rendered LaTeX"]', button => button.click())
  await page.$eval('#mermaid-layout-fixture button[title="Rendered Mermaid"]', button => button.click())
  await page.waitForSelector('#mermaid-layout-fixture [data-mermaid-diagram] svg', { timeout: 15_000 })
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
  const lightSvg = await page.$eval('#mermaid-layout-fixture [data-mermaid-diagram] svg', element => element.innerHTML)

  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.waitForFunction(previous => {
    const svg = document.querySelector('#mermaid-layout-fixture [data-mermaid-diagram] svg')
    return svg && svg.innerHTML !== previous
  }, { timeout: 15_000 }, lightSvg)

  const darkLayout = await page.$eval('#mermaid-layout-fixture [data-mermaid-diagram] svg', element => ({
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

test('nested Mermaid and LaTeX retain their valid Markdown ancestry in the actual DOM', async () => {
  const structure = await page.evaluate(() => ({
    nestedMermaid: {
      lists: document.querySelectorAll('#nested-mermaid-fixture > div > ul').length,
      items: document.querySelectorAll('#nested-mermaid-fixture li').length,
      codeInFirstItem: !!document.querySelector('#nested-mermaid-fixture li:first-child pre code.language-mermaid'),
      controls: document.querySelectorAll('#nested-mermaid-fixture [data-special-block]').length,
    },
    nestedMath: {
      blockquotes: document.querySelectorAll('#nested-math-fixture blockquote').length,
      formulaInQuote: !!document.querySelector('#nested-math-fixture blockquote .katex-display'),
      controls: document.querySelectorAll('#nested-math-fixture [data-special-block]').length,
    },
    listMath: {
      lists: document.querySelectorAll('#one-line-list-math-fixture ul').length,
      items: document.querySelectorAll('#one-line-list-math-fixture li').length,
      formulaInFirstItem: !!document.querySelector('#one-line-list-math-fixture li:first-child .katex-display'),
      controls: document.querySelectorAll('#one-line-list-math-fixture [data-special-block]').length,
    },
    mixed: {
      controls: document.querySelectorAll('#mixed-specials-fixture > [data-special-block]').length,
      nestedCode: !!document.querySelector('#mixed-specials-fixture li pre code.language-mermaid'),
      listCount: document.querySelectorAll('#mixed-specials-fixture ul').length,
    },
  }))

  assert.deepEqual(structure.nestedMermaid, { lists: 1, items: 2, codeInFirstItem: true, controls: 0 })
  assert.deepEqual(structure.nestedMath, { blockquotes: 1, formulaInQuote: true, controls: 0 })
  assert.deepEqual(structure.listMath, { lists: 1, items: 2, formulaInFirstItem: true, controls: 0 })
  assert.deepEqual(structure.mixed, { controls: 2, nestedCode: true, listCount: 1 })
})

test('unsafe Mermaid resources and links are rejected before any network request', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#security-fixtures [data-mermaid-error]').length === 13)
  assert.deepEqual(reviewerResourceRequests, [])

  const errors = await page.$$eval('#security-fixtures [data-mermaid-error]', elements => elements.map(element => element.textContent))
  assert.match(errors[0], /image and link resources are disabled/i)
  assert.match(errors[1], /image and link resources are disabled/i)
  assert.match(errors[2], /configuration directives are disabled/i)
  assert.match(errors[3], /interactive Mermaid links are disabled/i)
  assert.match(errors[4], /frontmatter is disabled/i)
  assert.match(errors[5], /styling directives are disabled/i)
  assert.match(errors[6], /styling directives are disabled/i)
  assert.match(errors[7], /image and link resources are disabled/i)
  assert.match(errors[8], /image and link resources are disabled/i)
  assert.match(errors[9], /escaped or unrecognized Mermaid metadata property keys are disabled/i)
  assert.match(errors[10], /escaped or unrecognized Mermaid metadata property keys are disabled/i)
  assert.match(errors[11], /image and link resources are disabled/i)
  assert.match(errors[12], /image and link resources are disabled/i)

  const clickBlock = (await page.$$('#security-fixtures [data-special-block]'))[3]
  await clickBlock.$eval('button[title="Raw Mermaid"]', button => button.click())
  assert.match(await clickBlock.$eval('[data-special-block-raw]', element => element.textContent), /^flowchart LR[\s\S]*click A href/)
})

test('legal IDs, label text, and quoted/comment metadata literals still render as Mermaid', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#benign-policy-fixtures [data-mermaid-diagram] svg').length === 5)
  assert.equal((await page.$$('#benign-policy-fixtures [data-mermaid-error]')).length, 0)
  assert.deepEqual(reviewerResourceRequests, [])
})

test('Mermaid-specific SVG sanitizer removes resources and interaction but keeps local markers', async () => {
  const state = await page.$eval('#post-sanitized-svg', element => ({
    forbiddenElements: element.querySelectorAll('script, foreignObject, image, a, link').length,
    hrefs: element.querySelectorAll('[href], [xlink\\:href]').length,
    eventAttributes: Array.from(element.querySelectorAll('*')).some(node => Array.from(node.attributes).some(attribute => attribute.name.toLowerCase().startsWith('on'))),
    html: element.innerHTML,
    keptText: element.textContent,
    localMarker: element.querySelector('rect')?.getAttribute('marker-end'),
  }))

  assert.equal(state.forbiddenElements, 0)
  assert.equal(state.hrefs, 0)
  assert.equal(state.eventAttributes, false)
  assert.doesNotMatch(state.html, /reviewer\.invalid|reviewer-image|@import|javascript:/i)
  assert.match(state.keptText, /kept text/)
  assert.equal(state.localMarker, 'url(#arrow)')
})
