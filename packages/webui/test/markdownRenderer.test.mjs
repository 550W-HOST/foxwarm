import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-markdown-test-'))
const bundledRendererPath = path.join(tempDir, 'markdownRenderer.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/components/markdownRenderer.ts')],
  outfile: bundledRendererPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { renderMarkdownWithSanitizer } = await import(pathToFileURL(bundledRendererPath).href)
const identitySanitizer = (html) => html

test('inline \\(...\\) math renders KaTeX HTML', () => {
  const html = renderMarkdownWithSanitizer('Euler: \\(e^{i\\pi}+1=0\\)', identitySanitizer)

  assert.match(html, /class="katex"/)
  assert.match(html, /e\^{i\\pi}\+1=0/)
  assert.doesNotMatch(html, /FOXWARM_MATH/)
})

test('display \\[...\\] math renders display KaTeX HTML', () => {
  const html = renderMarkdownWithSanitizer('\\[E=mc^2\\]', identitySanitizer)

  assert.match(html, /class="katex-display"/)
  assert.match(html, /E=mc\^2/)
})

test('standalone multiline display math is claimed before Markdown block parsing', () => {
  const html = renderMarkdownWithSanitizer(`\\[
c_{\\text{self}}
=
\\frac{0.813}{3,000,000}
\\approx 2.71\\times10^{-7}\\text{ seconds/byte}
\\]`, identitySanitizer)

  assert.match(html, /class="katex-display"/)
  assert.match(html, /c_\{\\text\{self\}\}/)
  assert.doesNotMatch(html, /<h1>/)
  assert.doesNotMatch(html, /FOXWARM_MATH/)
})

test('standalone display math keeps Markdown block interrupters opaque', () => {
  const cases = [
    ['minus', '\\[\na\n-\nb\n\\]'],
    ['blank line', '\\[\na\n\nb\n\\]'],
    ['heading marker', '\\[\na\n# b\n\\]'],
    ['list marker', '\\[\na\n- b\n\\]'],
    ['blockquote marker', '\\[\na\n> b\n\\]'],
    ['fence marker', '\\[\na\n```\nb\n```\n\\]'],
  ]

  for (const [label, source] of cases) {
    const html = renderMarkdownWithSanitizer(source, identitySanitizer)
    assert.match(html, /class="(?:katex-display|katex-error)"/, `${label} should stay math-owned`)
    assert.doesNotMatch(html, /<(?:h[1-6]|ul|ol|blockquote|pre)>/, `${label} should not become a Markdown block`)
  }
})

test('standalone display math supports LF, CRLF, and up to three leading spaces', () => {
  const lfHtml = renderMarkdownWithSanitizer('\\[\na+b\nc+d\n\\]', identitySanitizer)
  const crlfHtml = renderMarkdownWithSanitizer('  \\[ \t\r\na+b\r\n   \\]\t\r\n', identitySanitizer)

  assert.match(lfHtml, /class="katex-display"/)
  assert.match(crlfHtml, /class="katex-display"/)
  assert.doesNotMatch(lfHtml, /^<p>/)
  assert.doesNotMatch(crlfHtml, /^<p>/)
})

test('embedded same-line display math remains supported', () => {
  const html = renderMarkdownWithSanitizer('Before \\[E=mc^2\\] after', identitySanitizer)

  assert.match(html, /class="katex-display"/)
  assert.match(html, /Before /)
  assert.match(html, / after/)
})

test('dollar delimiters are not rendered as math', () => {
  const html = renderMarkdownWithSanitizer('$x$', identitySanitizer)

  assert.doesNotMatch(html, /class="katex"/)
  assert.match(html, /\$x\$/)
})

test('math delimiters inside code span and fenced code block are not rendered', () => {
  const inlineHtml = renderMarkdownWithSanitizer('`\\(x\\)`', identitySanitizer)
  const displayInlineHtml = renderMarkdownWithSanitizer('`\\[\nx+y\n\\]`', identitySanitizer)
  const blockHtml = renderMarkdownWithSanitizer('```\n\\(x\\)\n```', identitySanitizer)
  const displayBlockHtml = renderMarkdownWithSanitizer('```\n\\[\nx\n=\ny\n\\]\n```', identitySanitizer)

  assert.doesNotMatch(inlineHtml, /class="katex"/)
  assert.match(inlineHtml, /<code>\\\(x\\\)<\/code>/)
  assert.doesNotMatch(displayInlineHtml, /class="katex"/)
  assert.match(displayInlineHtml, /<code>\\\[ x\+y \\\]<\/code>/)
  assert.doesNotMatch(blockHtml, /class="katex"/)
  assert.match(blockHtml, /<pre><code>\\\(x\\\)\n<\/code><\/pre>/)
  assert.doesNotMatch(displayBlockHtml, /class="katex"/)
  assert.match(displayBlockHtml, /<pre><code>\\\[\nx\n=\ny\n\\\]\n<\/code><\/pre>/)
})

test('non-block display forms preserve existing fallbacks', () => {
  const cases = [
    ['unclosed', '\\[\nx'],
    ['empty', '\\[\n\\]'],
    ['four-space indent', '    \\[\n    x\n    \\]'],
  ]

  for (const [label, source] of cases) {
    const html = renderMarkdownWithSanitizer(source, identitySanitizer)
    assert.doesNotMatch(html, /class="katex-display"/, `${label} should not be claimed as a display block`)
  }

  for (const source of ['\\[ x\ny\n\\]', '\\[\nx\n\\] after']) {
    const html = renderMarkdownWithSanitizer(source, identitySanitizer)
    assert.match(html, /^<p><span class="katex-display"/)
  }

  const headingHtml = renderMarkdownWithSanitizer('# Heading\n\nEscaped \\[ bracket', identitySanitizer)
  assert.match(headingHtml, /<h1>Heading<\/h1>/)
  assert.match(headingHtml, /Escaped \[ bracket/)
  assert.doesNotMatch(headingHtml, /class="katex/)
})

test('math HTML crosses the sanitizer boundary only through placeholders', () => {
  let sanitizerInput = ''
  const html = renderMarkdownWithSanitizer('\\[\na=b\n\\]', (value) => {
    sanitizerInput = value
    return value
  })

  assert.match(sanitizerInput, /FOXWARM_MATH/)
  assert.doesNotMatch(sanitizerInput, /class="katex/)
  assert.match(html, /class="katex-display"/)
  assert.doesNotMatch(html, /FOXWARM_MATH/)
})

test('malformed TeX does not crash and still outputs safe content', () => {
  assert.doesNotThrow(() => renderMarkdownWithSanitizer('Bad: \\(\\frac{\\)', identitySanitizer))

  const html = renderMarkdownWithSanitizer('Bad: \\(\\frac{\\)', identitySanitizer)
  assert.match(html, /\\frac\{/)
  assert.doesNotMatch(html, /<script/i)
})

test('GFM tables retain semantic table markup for the scrollable Markdown style', () => {
  const html = renderMarkdownWithSanitizer('| left | right |\n| --- | --- |\n| a | b |', identitySanitizer)

  assert.match(html, /<table>/)
  assert.match(html, /<thead>/)
  assert.match(html, /<tbody>/)
  assert.match(html, /<th>left<\/th>/)
  assert.match(html, /<td>b<\/td>/)
})
