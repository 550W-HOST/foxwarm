import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const webuiRoot = path.resolve(new URL('..', import.meta.url).pathname)
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-pasted-text-test-'))
const output = path.join(tempDir, 'pasted-text.cjs')

await build({ entryPoints: [path.join(webuiRoot, 'src/pastedText.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
const { parsePastedTextSegments, getPastedTextPreview, countPastedTextCharacters } = await import(pathToFileURL(output).href)

after(async () => rm(tempDir, { recursive: true, force: true }))

test('complete non-nested pasted-text wrappers split without changing source content', () => {
  const source = 'before\n<pasted-text>  alpha\n\n😀 beta  </pasted-text>\nafter'
  const segments = parsePastedTextSegments(source)
  assert.deepEqual(segments, [
    { kind: 'text', text: 'before\n' },
    { kind: 'pasted-text', text: '  alpha\n\n😀 beta  ' },
    { kind: 'text', text: '\nafter' },
  ])
  assert.equal(segments.map(segment => segment.kind === 'pasted-text' ? `<pasted-text>${segment.text}</pasted-text>` : segment.text).join(''), source)
})

test('unclosed and nested wrappers remain one literal text segment', () => {
  for (const source of [
    'before <pasted-text>unclosed',
    '<pasted-text>outer <pasted-text>inner</pasted-text></pasted-text>',
  ]) {
    assert.deepEqual(parsePastedTextSegments(source), [{ kind: 'text', text: source }])
  }
})

test('preview uses the first nonempty line and count uses Unicode code points', () => {
  assert.equal(getPastedTextPreview('\n   \n  first 😀 line  \nsecond'), 'first 😀 line')
  assert.equal(countPastedTextCharacters('a😀b'), 3)
  assert.equal(getPastedTextPreview(''), 'Empty pasted text')
})
