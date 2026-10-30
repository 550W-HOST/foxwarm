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

const {
  assistantArtifactReferences,
  renderAssistantMarkdownSegmentsWithSanitizer,
  renderMarkdownSegmentsWithSanitizer,
  renderMarkdownWithSanitizer,
} = await import(pathToFileURL(bundledRendererPath).href)
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

test('standalone display math interrupts an adjacent ordinary paragraph', () => {
  const html = renderMarkdownWithSanitizer('Before\n\\[\na\n=\nb\n\\]\nAfter', identitySanitizer)

  assert.match(html, /^<p>Before<\/p>\n<span class="katex-display"/)
  assert.match(html, /<\/span><p>After<\/p>\n$/)
  assert.doesNotMatch(html, /<h1>/)
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
  const displayInlineHtml = renderMarkdownWithSanitizer('`code\n\\[\nx+y\n\\]\n`', identitySanitizer)
  const blockHtml = renderMarkdownWithSanitizer('```\n\\(x\\)\n```', identitySanitizer)
  const displayBlockHtml = renderMarkdownWithSanitizer('```\n\\[\nx\n=\ny\n\\]\n```', identitySanitizer)

  assert.doesNotMatch(inlineHtml, /class="katex"/)
  assert.match(inlineHtml, /<code>\\\(x\\\)<\/code>/)
  assert.doesNotMatch(displayInlineHtml, /class="katex"/)
  assert.match(displayInlineHtml, /<code>code \\\[ x\+y \\\] <\/code>/)
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

test('incomplete display candidates do not split ordinary paragraphs', () => {
  for (const source of ['Before\n\\[\nx\nAfter', 'Before\n\\[\n\\]\nAfter']) {
    const html = renderMarkdownWithSanitizer(source, identitySanitizer)
    assert.equal((html.match(/<p>/g) ?? []).length, 1)
    assert.match(html, /^<p>Before<br>/)
    assert.doesNotMatch(html, /class="katex/)
  }
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

test('assistant GFM tables retain table semantics inside their local scroll surface', () => {
  const source = '| left | right |\n| --- | --- |\n| a | b |'
  const ordinary = renderMarkdownWithSanitizer(source, identitySanitizer)
  const assistant = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)[0].html

  assert.doesNotMatch(ordinary, /foxwarm-markdown-table-scroll/)
  assert.match(assistant, /^<div class="foxwarm-markdown-table-scroll"><table>[\s\S]*<\/table>\s*<\/div>$/)
  assert.match(assistant, /<thead>[\s\S]*<th>left<\/th>/)
  assert.match(assistant, /<tbody>[\s\S]*<td>b<\/td>/)
})

test('ordinary Markdown segments preserve stable top-level token positions', () => {
  const initial = renderMarkdownSegmentsWithSanitizer('First paragraph.\n\nSecond paragraph.', identitySanitizer)
  const extendedTail = renderMarkdownSegmentsWithSanitizer('First paragraph.\n\nSecond paragraph grows.', identitySanitizer)
  const appendedBlock = renderMarkdownSegmentsWithSanitizer('First paragraph.\n\nSecond paragraph grows.\n\nThird paragraph.', identitySanitizer)

  assert.deepEqual(initial.map(segment => segment.tokenIndex), [0, 2])
  assert.deepEqual(extendedTail.map(segment => segment.tokenIndex), [0, 2])
  assert.deepEqual(appendedBlock.map(segment => segment.tokenIndex), [0, 2, 4])
  assert.equal(initial[0].html, extendedTail[0].html)
  assert.equal(extendedTail[0].html, appendedBlock[0].html)
  assert.notEqual(initial[1].html, extendedTail[1].html)
})

test('segmented rendering retains complete Markdown semantics', () => {
  const sources = [
    '[ref]: https://example.com\n\nUse [link][ref].',
    'Use [link][ref].\n\n[ref]: https://example.com',
    '- one\n- two\n\nafter',
    '> quote one\n>\n> quote two\n\nafter',
    '```js\nconst value = 1\n```\n\nInline \\(x\\).',
    '| left | right |\n| --- | --- |\n| a | b |',
  ]

  for (const source of sources) {
    const segmented = renderMarkdownSegmentsWithSanitizer(source, identitySanitizer).map(segment => segment.html).join('')
    assert.equal(segmented, renderMarkdownWithSanitizer(source, identitySanitizer), source)
  }
})

test('later reference definitions update the affected earlier token without shifting its identity', () => {
  const unresolved = renderMarkdownSegmentsWithSanitizer('Use [link][ref].', identitySanitizer)
  const resolved = renderMarkdownSegmentsWithSanitizer('Use [link][ref].\n\n[ref]: https://example.com', identitySanitizer)

  assert.equal(unresolved[0].tokenIndex, 0)
  assert.equal(resolved[0].tokenIndex, 0)
  assert.doesNotMatch(unresolved[0].html, /<a /)
  assert.match(resolved[0].html, /<a [^>]*href="https:\/\/example.com"[^>]*>link<\/a>/)
})

test('assistant Mermaid fences become special blocks with exact raw source', () => {
  const source = 'Before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter'
  const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)

  assert.deepEqual(segments.map(segment => segment.kind), ['html', 'mermaid', 'html'])
  assert.match(segments[0].html, /<p>Before<\/p>/)
  assert.equal(segments[1].source, 'graph TD\n  A --> B')
  assert.equal(segments[1].raw, '```mermaid\ngraph TD\n  A --> B\n```')
  assert.match(segments[2].html, /<p>After<\/p>/)
})

test('non-Mermaid fences and near-match languages retain ordinary code rendering', () => {
  for (const language of ['', 'js', 'mermaid-js', 'diagram']) {
    const source = `\`\`\`${language}\nmermaid\n\\[x\\]\n\`\`\``
    const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)

    assert.deepEqual(segments.map(segment => segment.kind), ['html'])
    assert.match(segments[0].html, /<pre><code/)
    assert.doesNotMatch(segments[0].html, /class="katex/)
  }
})

test('multiple Mermaid and display-math blocks preserve mixed source order', () => {
  const source = [
    'Inline \\(x\\) stays inline.',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '\\[',
    'y = x^2',
    '\\]',
    '```mermaid',
    'sequenceDiagram',
    '  A->>B: Hi',
    '```',
  ].join('\n')
  const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)

  assert.deepEqual(segments.map(segment => segment.kind), ['html', 'mermaid', 'latex', 'mermaid'])
  assert.match(segments[0].html, /class="katex"/)
  assert.doesNotMatch(segments[0].html, /katex-display/)
  assert.equal(segments[1].source, 'flowchart LR\n  A --> B')
  assert.equal(segments[2].source, 'y = x^2')
  assert.match(segments[2].raw, /^\\\[\ny = x\^2\n\\\]\n$/)
  assert.equal(segments[3].source, 'sequenceDiagram\n  A->>B: Hi')
})

test('only top-level multiline display math becomes a special block', () => {
  const source = 'Embedded \\[a=b\\] compatibility and inline \\(c=d\\).\n\n\\[E=mc^2\\]'
  const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)

  assert.deepEqual(segments.map(segment => segment.kind), ['html', 'html'])
  const html = segments.map(segment => segment.html).join('')
  assert.match(html, /katex-display/)
  assert.match(html, /class="katex"/)
})

test('special-block extraction stays behind the ordinary Markdown sanitizer', () => {
  const sanitizerInputs = []
  const source = '<script>alert(1)</script>\n\n```mermaid\ngraph TD\nA-->B\n```\n\n[bad](javascript:alert(2))'
  const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, (html) => {
    sanitizerInputs.push(html)
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/href="javascript:[^"]*"/gi, '')
  })

  assert.equal(sanitizerInputs.length, 3)
  assert.doesNotMatch(sanitizerInputs.join(''), /<pre><code class="language-mermaid"/)
  assert.deepEqual(segments.map(segment => segment.kind), ['html', 'mermaid', 'html'])
  const ordinaryHtml = segments.filter(segment => segment.kind === 'html').map(segment => segment.html).join('')
  assert.doesNotMatch(ordinaryHtml, /<script|javascript:/i)
  assert.equal(segments[1].source, 'graph TD\nA-->B')
})

test('assistant special extraction keeps nested Markdown in complete baseline HTML trees', () => {
  const nestedMermaid = '- Diagram:\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```\n- After'
  const nestedMath = '> Formula:\n> \\[\n> x = y\n> \\]\n'
  const oneLineListMath = '- first \\[x\\]\n- second'

  for (const source of [nestedMermaid, nestedMath, oneLineListMath]) {
    const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)
    assert.deepEqual(segments.map(segment => segment.kind), ['html'])
    assert.equal(segments[0].html, renderMarkdownWithSanitizer(source, identitySanitizer))
  }

  const listHtml = renderAssistantMarkdownSegmentsWithSanitizer(nestedMermaid, identitySanitizer)[0].html
  assert.equal((listHtml.match(/<ul>/g) ?? []).length, 1)
  assert.equal((listHtml.match(/<li>/g) ?? []).length, 2)
  assert.match(listHtml, /<li><p>Diagram:<\/p>[\s\S]*<pre><code class="language-mermaid">[\s\S]*<\/code><\/pre>[\s\S]*<\/li>/)

  const quoteHtml = renderAssistantMarkdownSegmentsWithSanitizer(nestedMath, identitySanitizer)[0].html
  assert.match(quoteHtml, /^<blockquote>[\s\S]*class="katex-display"[\s\S]*<\/blockquote>\n$/)

  const oneLineHtml = renderAssistantMarkdownSegmentsWithSanitizer(oneLineListMath, identitySanitizer)[0].html
  assert.equal((oneLineHtml.match(/<ul>/g) ?? []).length, 1)
  assert.match(oneLineHtml, /<li>first [\s\S]*class="katex-display"[\s\S]*<\/li>\n<li>second<\/li>/)
})

test('mixed top-level and nested specials extract only complete top-level tokens', () => {
  const source = [
    'Top',
    '',
    '```mermaid',
    'flowchart LR',
    'A-->B',
    '```',
    '',
    '- nested',
    '',
    '  ```mermaid',
    '  flowchart LR',
    '  B-->C',
    '  ```',
    '',
    '\\[',
    'z=1',
    '\\]',
  ].join('\n')
  const segments = renderAssistantMarkdownSegmentsWithSanitizer(source, identitySanitizer)

  assert.deepEqual(segments.map(segment => segment.kind), ['html', 'mermaid', 'html', 'latex'])
  assert.match(segments[2].html, /^<ul>[\s\S]*language-mermaid[\s\S]*<\/ul>\n$/)
})


test('later display math preserves preceding artifact identity and reference projection', () => {
  const marker = '<foxwarm-artifact id="art_00000000000000000000000000000001" revision="1" />'
  const prefix = 'Before figure.\n\n' + marker + '\n\n*Caption.*\n\n'
  const formula = '\\[\nx=1\n\\]'
  const initial = renderAssistantMarkdownSegmentsWithSanitizer(prefix, identitySanitizer, {enabled:true,streaming:true})
  const expected = initial.find(segment => segment.kind === 'artifact')
  assert.ok(expected)
  for (let length = 0; length <= formula.length; length++) {
    const text = prefix + formula.slice(0, length)
    const segments = renderAssistantMarkdownSegmentsWithSanitizer(text, identitySanitizer, {enabled:true,streaming:true})
    assert.deepEqual(segments.filter(segment => segment.kind === 'artifact'), [expected])
    assert.deepEqual(assistantArtifactReferences(text), [expected.reference])
    assert.ok(!segments.some(segment => segment.kind === 'html' && segment.html.includes('&lt;foxwarm-artifact')))
  }
  const complete = renderAssistantMarkdownSegmentsWithSanitizer(prefix + formula + '\n\nAfter.', identitySanitizer, {enabled:true})
  assert.deepEqual(complete.find(segment => segment.kind === 'artifact'), expected)
  assert.equal(complete.filter(segment => segment.kind === 'latex').length, 1)
  for (const nested of ['> ' + marker, '    ' + marker, '```xml\n' + marker + '\n```']) {
    const text = nested + '\n\n' + formula
    assert.deepEqual(assistantArtifactReferences(text), [])
    assert.ok(!renderAssistantMarkdownSegmentsWithSanitizer(text, identitySanitizer, {enabled:true}).some(segment => segment.kind === 'artifact'))
  }
})

const citationMarker = '\uE200cite\uE202turn0search3\uE201'
const citationHtml = (text, annotations = [], streaming = false, extra = {}) => renderAssistantMarkdownSegmentsWithSanitizer(text, identitySanitizer, { enabled: true, streaming }, { annotations, ...extra }).filter(segment => segment.kind === 'html').map(segment => segment.html).join('')

test('assistant citations retain unknown reference IDs without guessing a URL', () => {
  const raw = '\uE200cite\uE202turn0search3\uE202turn0search3\uE202turn2search7\uE201'
  const html = citationHtml(`Claim ${raw}`)
  assert.match(html, /data-web-search-ref="unresolved"/)
  assert.match(html, /title="turn0search3, turn0search3, turn2search7"/)
  assert.match(html, /\[source\?\]/)
  assert.doesNotMatch(html, /<a\b/)
  assert.match(html, /data-citation-raw="/)
  assert.match(renderMarkdownWithSanitizer(`Claim ${raw}`, identitySanitizer), /\uE200cite/)
  assert.doesNotMatch(renderMarkdownWithSanitizer(raw, identitySanitizer), /data-web-search-ref/)
})

test('only exact current-part annotation spans resolve citations, including Unicode offsets', () => {
  const prefix = '😀 中文 claim '
  const text = `${prefix}${citationMarker} and ${citationMarker}`
  for (const start of [prefix.length, [...prefix].length]) {
    const html = citationHtml(text, [{ type: 'url_citation', start_index: start, end_index: start + citationMarker.length, url: 'https://example.com/exact', title: 'Exact source' }])
    assert.equal((html.match(/data-web-search-ref="resolved"/g) || []).length, 1)
    assert.equal((html.match(/data-web-search-ref="unresolved"/g) || []).length, 1)
    assert.match(html, /href="https:\/\/example.com\/exact"/)
  }
  for (const annotations of [
    [{ type: 'url_citation', url: 'https://example.com/no-span' }],
    [{ type: 'url_citation', start_index: 0, end_index: text.length, url: 'https://example.com/whole-claim' }],
    [{ type: 'other', start_index: prefix.length, end_index: prefix.length + citationMarker.length, url: 'https://example.com/wrong-type' }],
    [{ type: 'url_citation', start_index: prefix.length + 1, end_index: prefix.length + citationMarker.length, url: 'https://example.com/partial' }],
  ]) assert.doesNotMatch(citationHtml(text, annotations), /data-web-search-ref="resolved"/)
})

test('nested annotations, repeated annotations and split markdown retain exact positions', () => {
  const prefix = 'intro\n<foxwarm-commit node="master" path="/repo" id="abcdef123" />\n'
  const fragment = `After ${citationMarker}`
  const annotation = { type: 'url_citation', url_citation: { start_index: prefix.length + 6, end_index: prefix.length + 6 + citationMarker.length, url: 'https://example.com/nested', title: 'Nested' } }
  const html = citationHtml(fragment, [annotation, annotation], false, { sourceText: prefix + fragment, sourceOffset: prefix.length })
  assert.equal((html.match(/data-web-search-ref="resolved"/g) || []).length, 1)
  assert.doesNotMatch(citationHtml(fragment, [annotation], false, { sourceText: prefix + fragment, sourceOffset: 0 }), /data-web-search-ref="resolved"/)
  const quoted = `> 😀 ${citationMarker}\n\n- ${citationMarker}`
  const start = quoted.lastIndexOf(citationMarker)
  const nestedHtml = citationHtml(quoted, [{ type: 'url_citation', start_index: start, end_index: start + citationMarker.length, url: 'https://example.com/list' }])
  assert.match(nestedHtml, /<blockquote>[\s\S]*data-web-search-ref="unresolved"/)
  assert.match(nestedHtml, /<li><a[^>]*data-web-search-ref="resolved"/)
})

test('citation links reject unsafe URLs and escape reference IDs and titles', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//example.com', 'https://', 'https://example.com\\@evil.com', 'https://example.com\n.evil.com', 'https://user:pass@example.com']) {
    assert.doesNotMatch(citationHtml(citationMarker, [{ type: 'url_citation', start_index: 0, end_index: citationMarker.length, url }]), /<a\b/)
  }
  const html = citationHtml(citationMarker, [{ type: 'url_citation', start_index: 0, end_index: citationMarker.length, url: 'https://example.com/?a=1&b=2', title: '\"><img src=x onerror=alert(1)>' }])
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&quot;&gt;&lt;img/)
  assert.doesNotMatch(citationHtml('\uE200cite\uE202\"><script>alert(1)</script>\uE201'), /<script/)
})

test('literal citation markers stay intact in inline/fenced code and math raw sources', () => {
  for (const text of [`\`${citationMarker}\``, `\`\`\`text\n${citationMarker}\n\`\`\``, `    ${citationMarker}`, `<code>${citationMarker}</code>`]) {
    const html = citationHtml(text)
    assert.match(html, /\uE200cite/)
    assert.doesNotMatch(html, /data-web-search-ref/)
    assert.doesNotMatch(html, /FOXWARMCITATION/)
  }
  const math = `\\[\n${citationMarker}\n\\]`
  assert.equal(renderAssistantMarkdownSegmentsWithSanitizer(math, identitySanitizer)[0].raw, math)
  const mermaid = `\`\`\`mermaid\n${citationMarker}\n\`\`\``
  assert.equal(renderAssistantMarkdownSegmentsWithSanitizer(mermaid, identitySanitizer)[0].source, citationMarker)
})

test('streaming incomplete markers do not expose private-use glyphs or remount earlier token identities', () => {
  for (let end = 1; end < citationMarker.length; end++) {
    const html = citationHtml(`Claim ${citationMarker.slice(0, end)}`, [], true)
    assert.doesNotMatch(html, /[\uE000\uE001\uE200\uE201\uE202]/)
    assert.doesNotMatch(html, /turn0search|FOXWARMCITATION/)
    assert.match(html, /Claim/)
  }
  assert.match(citationHtml(`Claim ${citationMarker}`, [], true), /\[source\?\]/)
  assert.match(citationHtml('Claim \uE200cite\uE202turn0sea'), /\[source\?\]/)
  const prefix = `<foxwarm-artifact id="art_${'a'.repeat(32)}" revision="1" />\n\n`
  const initial = renderAssistantMarkdownSegmentsWithSanitizer(prefix + `Claim ${citationMarker.slice(0, 8)}`, identitySanitizer, { enabled: true, streaming: true })
  const later = renderAssistantMarkdownSegmentsWithSanitizer(prefix + `Claim ${citationMarker}\n\n\\[\nx=1\n\\]`, identitySanitizer, { enabled: true, streaming: true })
  assert.equal(initial[0].kind, 'artifact')
  assert.deepEqual(initial[0], later[0])
})

test('invalid/out-of-range and ambiguous Unicode span endpoints cannot resolve a final marker', () => {
  for (const [start, end] of [[0, 100000], [0, citationMarker.length + 1], [0, undefined], [undefined, citationMarker.length], [-1, citationMarker.length], [0.1, citationMarker.length], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.doesNotMatch(citationHtml(citationMarker, [{ type: 'url_citation', start_index: start, end_index: end, url: 'https://example.com/invalid' }]), /data-web-search-ref="resolved"/, `invalid endpoints: ${start},${end}`)
  }
  const prefix = '😀'.repeat(citationMarker.length + 1)
  const text = `${prefix}${citationMarker} ${citationMarker}`
  assert.doesNotMatch(citationHtml(text, [{ type: 'url_citation', start_index: prefix.length, end_index: prefix.length + citationMarker.length, url: 'https://example.com/ambiguous' }]), /data-web-search-ref="resolved"/)
})

test('oversized markers have bounded tooltip/raw DOM metadata while literal code retains full original text', () => {
  const raw = `\uE200cite\uE202${'turn0search3\uE202'.repeat(10000)}\uE201`
  const html = citationHtml(raw)
  assert.ok(html.length < 4000)
  assert.match(html, /\[source\?\]/)
  assert.match(html, /…/)
  assert.ok(citationHtml(`\`${raw}\``).includes(raw))
  const hostile = '\uE200cite\uE202<a href="https://example.com">&</a>\uE201'
  const codeHtml = citationHtml(`\`${hostile}\``)
  assert.doesNotMatch(codeHtml, /<a\b/)
  assert.match(codeHtml, /&lt;a/)
})

test('incomplete citations inside code are literal even while streaming', () => {
  const partial = '\uE200cite\uE202turn0sea'
  for (const source of [`\`${partial}\``, `\`\`\`text\n${partial}`]) {
    assert.match(citationHtml(source, [], true), /\uE200cite\uE202turn0sea/)
    assert.doesNotMatch(citationHtml(source, [], true), /data-web-search-ref|FOXWARMCITATION/)
  }
})
