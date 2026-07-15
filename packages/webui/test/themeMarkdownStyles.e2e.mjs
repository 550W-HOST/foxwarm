import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page

const fixtureMarkup = `
  <main>
    <section id="message-reasoning">
      <div class="foxwarm-markdown foxwarm-reasoning-body prose max-w-none prose-slate dark:prose-invert">
        <p>Inline <code>message_inline()</code></p>
        <pre><code class="language-js">const message = true;</code></pre>
      </div>
    </section>
    <section id="processing-reasoning">
      <div class="foxwarm-markdown foxwarm-reasoning-body prose max-w-none prose-blue dark:prose-invert">
        <p>Inline <code>processing_inline()</code></p>
        <pre><code class="language-js">const processing = true;</code></pre>
      </div>
    </section>
    <section id="context-block">
      <div class="foxwarm-markdown prose max-w-none prose-slate dark:prose-invert">
        <p>Inline <code>context_inline()</code></p>
        <pre><code class="language-js">const contextBlock = true;</code></pre>
      </div>
    </section>
    <section id="assistant-markdown" class="foxwarm-assistant-message-markdown">
      <div class="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100">
        <p>Inline <code>assistant_inline()</code></p>
        <pre><code class="language-js">const assistant = true;</code></pre>
      </div>
    </section>
  </main>
`

const parseRgb = (value) => {
  const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  assert.ok(match, `expected an rgb color, received ${value}`)
  return match.slice(1, 4).map(Number)
}

const relativeLuminance = (value) => {
  const channels = parseRgb(value).map(channel => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const contrastRatio = (foreground, background) => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

async function applyTheme({ style = 'default', dark = false }) {
  await page.evaluate(({ style, dark }) => {
    document.documentElement.classList.toggle('dark', dark)
    if (style === '550a') {
      document.documentElement.setAttribute('data-foxwarm-ui-style', '550a')
    } else {
      document.documentElement.removeAttribute('data-foxwarm-ui-style')
    }
  }, { style, dark })
}

async function readComputedStyles() {
  return page.evaluate(() => {
    const readSection = (id) => {
      const markdown = document.querySelector(`#${id} .foxwarm-markdown`)
      const inlineCode = markdown.querySelector('p code')
      const pre = markdown.querySelector('pre')
      const blockCode = markdown.querySelector('pre code')
      const styleOf = element => {
        const style = getComputedStyle(element)
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
        }
      }
      const markdownStyle = getComputedStyle(markdown)
      return {
        inlineCode: styleOf(inlineCode),
        pre: styleOf(pre),
        blockCode: styleOf(blockCode),
        prosePreCode: markdownStyle.getPropertyValue('--tw-prose-pre-code').trim(),
        prosePreBackground: markdownStyle.getPropertyValue('--tw-prose-pre-bg').trim(),
      }
    }

    const rootStyle = getComputedStyle(document.documentElement)
    return {
      theme: {
        textBright: rootStyle.getPropertyValue('--foxwarm-550a-text-bright').trim(),
        input: rootStyle.getPropertyValue('--foxwarm-550a-input').trim(),
      },
      message: readSection('message-reasoning'),
      processing: readSection('processing-reasoning'),
      contextBlock: readSection('context-block'),
      assistant: readSection('assistant-markdown'),
    }
  })
}

function assertReadable550aBlock(sample, expectedForeground, expectedBackground) {
  assert.equal(sample.prosePreCode, expectedForeground)
  assert.equal(sample.prosePreBackground, expectedBackground)
  assert.equal(sample.pre.color, sample.blockCode.color)
  assert.equal(sample.pre.backgroundColor, sample.blockCode.backgroundColor)
  assert.ok(
    contrastRatio(sample.blockCode.color, sample.blockCode.backgroundColor) >= 4.5,
    `expected readable block code, received ${sample.blockCode.color} on ${sample.blockCode.backgroundColor}`,
  )
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the theme style browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
  await page.setContent(fixtureMarkup)
  await page.addStyleTag({ content: css })
})

after(async () => {
  await browser?.close()
})

test('550A light pairs fenced-code foreground and background across Markdown surfaces', async () => {
  await applyTheme({ style: '550a', dark: false })
  const styles = await readComputedStyles()

  assert.equal(styles.theme.textBright, '#222222')
  assert.equal(styles.theme.input, '#fafaf8')
  for (const sample of [styles.message, styles.processing, styles.contextBlock]) {
    assertReadable550aBlock(sample, styles.theme.textBright, styles.theme.input)
    assert.equal(sample.inlineCode.color, 'rgb(34, 34, 34)')
    assert.equal(sample.inlineCode.backgroundColor, 'rgb(250, 250, 248)')
  }

  assert.equal(styles.assistant.pre.color, 'rgb(17, 24, 39)')
  assert.equal(styles.assistant.pre.backgroundColor, 'rgb(250, 250, 248)')
})

test('550A dark pairs fenced-code foreground and background across Markdown surfaces', async () => {
  await applyTheme({ style: '550a', dark: true })
  const styles = await readComputedStyles()

  assert.equal(styles.theme.textBright, '#cccccc')
  assert.equal(styles.theme.input, '#0a0a0a')
  for (const sample of [styles.message, styles.processing, styles.contextBlock]) {
    assertReadable550aBlock(sample, styles.theme.textBright, styles.theme.input)
    assert.equal(sample.inlineCode.color, 'rgb(204, 204, 204)')
    assert.equal(sample.inlineCode.backgroundColor, 'rgb(10, 10, 10)')
  }

  assert.equal(styles.assistant.pre.color, 'rgb(243, 244, 246)')
  assert.equal(styles.assistant.pre.backgroundColor, 'rgb(10, 10, 10)')
})

test('default light and dark retain their Typography and assistant code-block rules', async () => {
  await applyTheme({ style: 'default', dark: false })
  const light = await readComputedStyles()
  assert.deepEqual(
    [light.message.pre.color, light.message.pre.backgroundColor],
    ['rgb(226, 232, 240)', 'rgb(30, 41, 59)'],
  )
  assert.deepEqual(
    [light.processing.pre.color, light.processing.pre.backgroundColor],
    ['rgb(229, 231, 235)', 'rgb(31, 41, 55)'],
  )
  assert.deepEqual(
    [light.contextBlock.pre.color, light.contextBlock.pre.backgroundColor],
    ['rgb(226, 232, 240)', 'rgb(30, 41, 59)'],
  )
  assert.deepEqual(
    [light.assistant.pre.color, light.assistant.pre.backgroundColor],
    ['rgb(17, 24, 39)', 'rgb(243, 244, 246)'],
  )

  await applyTheme({ style: 'default', dark: true })
  const dark = await readComputedStyles()
  assert.deepEqual(
    [dark.message.pre.color, dark.message.pre.backgroundColor],
    ['rgb(203, 213, 225)', 'rgba(0, 0, 0, 0.5)'],
  )
  assert.deepEqual(
    [dark.processing.pre.color, dark.processing.pre.backgroundColor],
    ['rgb(209, 213, 219)', 'rgba(0, 0, 0, 0.5)'],
  )
  assert.deepEqual(
    [dark.contextBlock.pre.color, dark.contextBlock.pre.backgroundColor],
    ['rgb(203, 213, 225)', 'rgba(0, 0, 0, 0.5)'],
  )
  assert.deepEqual(
    [dark.assistant.pre.color, dark.assistant.pre.backgroundColor],
    ['rgb(243, 244, 246)', 'rgb(17, 24, 39)'],
  )
})