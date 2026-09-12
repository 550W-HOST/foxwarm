import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadTypeScriptModule(relativePath) {
  const result = await build({ entryPoints: [new URL(relativePath, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const {
  appendTextToComposerDraft,
  canConvertPasteToBlock,
  clearComposerDraft,
  getPlainComposerDraftText,
  loadComposerDraft,
  makeComposerDraft,
  makePlainComposerDraft,
  persistComposerDraft,
  serializeComposerDraft,
} = await loadTypeScriptModule('../src/composerDraft.ts')

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('composer drafts serialize exact ordered text and pasted-text segments', () => {
  const draft = makeComposerDraft([
    { type: 'text', text: 'before\n' },
    { type: 'text', text: '' },
    { type: 'pasted-text', id: 'p1', text: 'first\n\n  second 😀' },
    { type: 'attachment', ref: 'attachment1', name: 'same.txt', mimeType: 'text/plain', size: 12 },
    { type: 'text', text: '\nafter' },
  ])
  assert.equal(serializeComposerDraft(draft), 'before\n<pasted-text>first\n\n  second 😀</pasted-text><attachment-ref ref="attachment1" />\nafter')
  assert.equal(getPlainComposerDraftText(draft), null)
  assert.equal(getPlainComposerDraftText(makePlainComposerDraft('typed <pasted-text>x</pasted-text>')), 'typed <pasted-text>x</pasted-text>')
})

test('large plain-text paste threshold uses Unicode code points or twenty lines and rejects closing delimiter collisions', () => {
  assert.equal(canConvertPasteToBlock('😀'.repeat(1999)), false)
  assert.equal(canConvertPasteToBlock('😀'.repeat(2000)), true)
  assert.equal(canConvertPasteToBlock(Array.from({ length: 19 }, () => 'line').join('\n')), false)
  assert.equal(canConvertPasteToBlock(Array.from({ length: 20 }, () => 'line').join('\n')), true)
  assert.equal(canConvertPasteToBlock(`${'x'.repeat(2000)}</pasted-text>`), false)
})

test('structured storage reads old plain strings and writes only the versioned segment shape', () => {
  const previousStorage = globalThis.localStorage
  const storage = storageFixture({ 'draft_agent/main': 'old literal <pasted-text>x</pasted-text>' })
  globalThis.localStorage = storage
  try {
    const legacy = loadComposerDraft('agent/main')
    assert.equal(getPlainComposerDraftText(legacy), 'old literal <pasted-text>x</pasted-text>')
    persistComposerDraft('agent/main', makeComposerDraft([
      { type: 'text', text: 'before' },
      { type: 'pasted-text', id: 'p1', text: 'block' },
      { type: 'attachment', ref: 'attachment1', name: 'report.txt', mimeType: 'text/plain', size: 8 },
    ]))
    assert.equal(storage.values.has('draft_agent/main'), false)
    assert.deepEqual(JSON.parse(storage.values.get('composer_draft_v1_agent/main')), {
      version: 1,
      segments: [
        { type: 'text', text: 'before' },
        { type: 'pasted-text', id: 'p1', text: 'block' },
        { type: 'attachment', ref: 'attachment1', name: 'report.txt', mimeType: 'text/plain', size: 8 },
      ],
    })
    clearComposerDraft('agent/main')
    assert.equal(storage.values.size, 0)
  } finally {
    globalThis.localStorage = previousStorage
  }
})

test('transcripts append after the current ordered draft without rewriting pasted content', () => {
  const draft = makeComposerDraft([
    { type: 'text', text: 'context' },
    { type: 'pasted-text', id: 'p1', text: '  exact pasted bytes  ' },
  ])
  assert.equal(
    serializeComposerDraft(appendTextToComposerDraft(draft, '  transcript  ')),
    'context<pasted-text>  exact pasted bytes  </pasted-text>\n\ntranscript',
  )
})
