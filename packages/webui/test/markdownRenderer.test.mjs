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

test('dollar delimiters are not rendered as math', () => {
  const html = renderMarkdownWithSanitizer('$x$', identitySanitizer)

  assert.doesNotMatch(html, /class="katex"/)
  assert.match(html, /\$x\$/)
})

test('math delimiters inside code span and fenced code block are not rendered', () => {
  const inlineHtml = renderMarkdownWithSanitizer('`\\(x\\)`', identitySanitizer)
  const displayInlineHtml = renderMarkdownWithSanitizer('`\\[x\\]`', identitySanitizer)
  const blockHtml = renderMarkdownWithSanitizer('```\n\\(x\\)\n```', identitySanitizer)
  const displayBlockHtml = renderMarkdownWithSanitizer('```\n\\[x\\]\n```', identitySanitizer)

  assert.doesNotMatch(inlineHtml, /class="katex"/)
  assert.match(inlineHtml, /<code>\\\(x\\\)<\/code>/)
  assert.doesNotMatch(displayInlineHtml, /class="katex"/)
  assert.match(displayInlineHtml, /<code>\\\[x\\\]<\/code>/)
  assert.doesNotMatch(blockHtml, /class="katex"/)
  assert.match(blockHtml, /<pre><code>\\\(x\\\)\n<\/code><\/pre>/)
  assert.doesNotMatch(displayBlockHtml, /class="katex"/)
  assert.match(displayBlockHtml, /<pre><code>\\\[x\\\]\n<\/code><\/pre>/)
})

test('malformed TeX does not crash and still outputs safe content', () => {
  assert.doesNotThrow(() => renderMarkdownWithSanitizer('Bad: \\(\\frac{\\)', identitySanitizer))

  const html = renderMarkdownWithSanitizer('Bad: \\(\\frac{\\)', identitySanitizer)
  assert.match(html, /\\frac\{/)
  assert.doesNotMatch(html, /<script/i)
})
