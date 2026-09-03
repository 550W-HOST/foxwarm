import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const longWord = 'model_' + 'x'.repeat(220)
const longCode = 'const prose = "' + 'code block prose '.repeat(34) + '";'
const longPath = '/workspace/' + 'deep-segment/'.repeat(18) + 'message-overflow.tsx'

let browser
let page
let css

const tableHead = Array.from({ length: 10 }, (_, index) => `<th>column-${index}-heading</th>`).join('')
const tableBody = Array.from({ length: 10 }, (_, index) => `<td>cell-${index}-wide-value</td>`).join('')

const fixtureMarkup = `
  <main id="viewport" class="foxwarm-chat-messages w-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto p-4">
    <section id="timeline-defense" class="foxwarm-chat-timeline min-w-0 max-w-full">
      <div id="intentional-oversized-child" style="width: 2400px; height: 1px"></div>
    </section>
    <div class="flex w-full min-w-0 max-w-full">
      <article id="assistant" class="foxwarm-assistant-message-card min-w-0 max-w-full w-full rounded-lg border px-2">
        <div class="foxwarm-assistant-message-markdown min-w-0 max-w-full">
          <div class="foxwarm-markdown prose prose-sm max-w-none">
            <p id="assistant-long-word">${longWord}</p>
            <pre id="assistant-code"><code>${longCode}</code></pre>
            <table id="assistant-table"><thead><tr>${tableHead}</tr></thead><tbody><tr>${tableBody}</tr></tbody></table>
          </div>
        </div>
      </article>
    </div>
    <section id="reasoning" class="foxwarm-reasoning-card min-w-0 max-w-full w-full">
      <div class="foxwarm-markdown foxwarm-reasoning-body prose max-w-none"><p>${longWord}</p></div>
    </section>
    <section id="context-block" class="min-w-0 max-w-full w-full">
      <div class="foxwarm-markdown prose max-w-none"><p>${longWord}</p></div>
    </section>
    <section id="tool-card" class="foxwarm-tool-card min-w-0 max-w-full w-full text-xs font-mono">
      <div id="tool-line" class="flex min-w-0 max-w-full items-start">
        <span id="tool-code-path" class="foxwarm-tool-code-path min-w-0 max-w-full whitespace-normal break-words text-left">${longPath}</span>
      </div>
    </section>
  </main>
`

async function installFixture({ width, height, style, dark }) {
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 768, hasTouch: width < 768 })
  await page.setContent(fixtureMarkup)
  await page.addStyleTag({ content: css })
  await page.evaluate(({ style, dark }) => {
    document.documentElement.classList.toggle('dark', dark)
    if (style === '550a') document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
    else document.documentElement.removeAttribute('data-foxwarm-component-treatment')
  }, { style, dark })
}

async function readLayout() {
  return page.evaluate(() => {
    const viewport = document.querySelector('#viewport')
    const assistant = document.querySelector('#assistant')
    const longWord = document.querySelector('#assistant-long-word')
    const code = document.querySelector('#assistant-code')
    const table = document.querySelector('#assistant-table')
    const toolLine = document.querySelector('#tool-line')
    const toolPath = document.querySelector('#tool-code-path')
    const reasoning = document.querySelector('#reasoning')
    const contextBlock = document.querySelector('#context-block')
    const timelineDefense = document.querySelector('#timeline-defense')
    const style = (element) => getComputedStyle(element)

    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      outerDefense: {
        overflowX: style(viewport).overflowX,
        overflowY: style(viewport).overflowY,
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
      },
      assistantOverflow: assistant.scrollWidth - assistant.clientWidth,
      reasoningOverflow: reasoning.scrollWidth - reasoning.clientWidth,
      contextOverflow: contextBlock.scrollWidth - contextBlock.clientWidth,
      timelineDefense: {
        overflowX: style(timelineDefense).overflowX,
        scrollWidth: timelineDefense.scrollWidth,
        clientWidth: timelineDefense.clientWidth,
        right: timelineDefense.getBoundingClientRect().right,
      },
      wordOverflowWrap: style(longWord).overflowWrap,
      code: {
        overflowX: style(code).overflowX,
        whiteSpace: style(code).whiteSpace,
        overflowWrap: style(code).overflowWrap,
        scrollWidth: code.scrollWidth,
        clientWidth: code.clientWidth,
        scrollHeight: code.scrollHeight,
        clientHeight: code.clientHeight,
      },
      table: {
        display: style(table).display,
        overflowX: style(table).overflowX,
        scrollWidth: table.scrollWidth,
        clientWidth: table.clientWidth,
      },
      tool: {
        fontSize: Number.parseFloat(style(toolPath).fontSize),
        surroundingFontSize: Number.parseFloat(style(toolLine).fontSize),
        overflowWrap: style(toolPath).overflowWrap,
        width: toolPath.getBoundingClientRect().width,
        lineWidth: toolLine.getBoundingClientRect().width,
        height: toolPath.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style(toolPath).lineHeight),
        overflow: toolLine.scrollWidth - toolLine.clientWidth,
      },
    }
  })
}

function assertContainedLayout(layout) {
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `document overflowed by ${layout.documentWidth - layout.viewportWidth}px`)
  assert.equal(layout.outerDefense.overflowX, 'hidden')
  assert.equal(layout.outerDefense.overflowY, 'auto')
  assert.ok(layout.outerDefense.scrollWidth > layout.outerDefense.clientWidth + 1000, 'outer scroller must own the deliberately oversized future child')
  assert.ok(layout.assistantOverflow <= 1, `assistant overflowed by ${layout.assistantOverflow}px`)
  assert.ok(layout.reasoningOverflow <= 1, `reasoning overflowed by ${layout.reasoningOverflow}px`)
  assert.ok(layout.contextOverflow <= 1, `CTX-BLOCK overflowed by ${layout.contextOverflow}px`)
  assert.equal(layout.timelineDefense.overflowX, 'visible')
  assert.ok(layout.timelineDefense.scrollWidth > layout.timelineDefense.clientWidth + 1000, 'fixture must contain a deliberately oversized future child')
  assert.ok(layout.timelineDefense.right <= layout.viewportWidth + 1, 'timeline boundary itself must stay in the viewport')
  assert.equal(layout.wordOverflowWrap, 'anywhere')

  assert.equal(layout.code.whiteSpace, 'pre-wrap')
  assert.equal(layout.code.overflowWrap, 'anywhere')
  assert.notEqual(layout.code.overflowX, 'auto')
  assert.ok(layout.code.scrollWidth <= layout.code.clientWidth + 1, 'fenced code should wrap instead of scrolling horizontally')
  assert.ok(layout.code.scrollHeight > layout.code.clientHeight || layout.code.clientHeight > 40, 'long fenced code should occupy wrapped lines')

  assert.equal(layout.table.display, 'block')
  assert.equal(layout.table.overflowX, 'auto')
  assert.ok(layout.table.scrollWidth > layout.table.clientWidth + 1, 'wide table should own horizontal scrolling')

  assert.ok(layout.tool.fontSize <= layout.tool.surroundingFontSize + 0.01, `Code path font ${layout.tool.fontSize}px must not be larger than surrounding tool text ${layout.tool.surroundingFontSize}px`)
  assert.ok(['anywhere', 'break-word'].includes(layout.tool.overflowWrap))
  assert.ok(layout.tool.width <= layout.tool.lineWidth + 1, 'Code path must stay within the tool line')
  assert.ok(layout.tool.height > layout.tool.lineHeight * 1.5, 'long Code path should wrap onto multiple lines')
  assert.ok(layout.tool.overflow <= 1, `tool line overflowed by ${layout.tool.overflow}px`)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the message overflow browser test')
  css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
})

test('desktop model Markdown and tool Code paths contain overflow', async () => {
  await installFixture({ width: 1024, height: 800, style: 'default', dark: false })
  assertContainedLayout(await readLayout())
})

test('mobile 550A model Markdown and tool Code paths contain overflow', async () => {
  await installFixture({ width: 390, height: 844, style: '550a', dark: true })
  assertContainedLayout(await readLayout())
})