import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// One bundle so the model and the test share a single @codemirror/state instance.
const entry = `
  export * from ${JSON.stringify(new URL('../src/composerEditorModel.ts', import.meta.url).pathname)}
  export { makeComposerDraft, serializeComposerDraft } from ${JSON.stringify(new URL('../src/composerDraft.ts', import.meta.url).pathname)}
  export { EditorSelection, EditorState } from '@codemirror/state'
  export { history, undo, redo } from '@codemirror/commands'
`
const result = await build({
  stdin: { contents: entry, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const {
  composerChipExtensions, createComposerState, documentToDraft, draftToDocument, getComposerChips, insertChipsSpec, snapOutsideChips,
  makeComposerDraft, serializeComposerDraft, EditorSelection, history, undo, redo,
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const pasted = { type: 'pasted-text', id: 'p1', text: 'line one\r\nline two' }
const attachment = { type: 'attachment', ref: 'attachment1', name: 'a.txt', mimeType: 'text/plain', size: 1 }
const draft = makeComposerDraft([{ type: 'text', text: 'before ' }, pasted, attachment, { type: 'text', text: ' after\n' }])

function editorState(value = draft) {
  return createComposerState(value, [composerChipExtensions, history()])
}

function run(state, command) {
  let next = state
  assert.equal(command({ state, dispatch: tr => { next = tr.state } }), true)
  return next
}

test('the document is the exact serialized draft and round-trips segments', () => {
  const state = editorState()
  assert.equal(state.doc.toString(), serializeComposerDraft(draft))
  assert.deepEqual(documentToDraft(state), draft)
  assert.deepEqual(getComposerChips(state).map(chip => chip.segment.type), ['pasted-text', 'attachment'])
  const { text, chips } = draftToDocument(draft)
  assert.equal(text, state.doc.toString())
  assert.deepEqual(chips.map(chip => text.slice(chip.from, chip.to)), [
    serializeComposerDraft(makeComposerDraft([pasted])),
    '<attachment-ref ref="attachment1" />',
  ])
  assert.equal(state.selection.main.head, state.doc.length)
})

test('typed wrapper syntax stays ordinary text', () => {
  const literal = '<pasted-text>typed</pasted-text>'
  const state = editorState(makeComposerDraft([]))
  const next = state.update({ changes: { from: 0, insert: literal } }).state
  assert.deepEqual(getComposerChips(next), [])
  assert.deepEqual(documentToDraft(next), makeComposerDraft([{ type: 'text', text: literal }]))
})

test('edits reaching inside a chip remove the whole chip', () => {
  const state = editorState()
  const [chip] = getComposerChips(state)
  const inside = state.update({ changes: { from: chip.from + 3, to: chip.from + 5, insert: 'X' } }).state
  assert.deepEqual(documentToDraft(inside), makeComposerDraft([{ type: 'text', text: 'before X' }, attachment, { type: 'text', text: ' after\n' }]))
  const insert = state.update({ changes: { from: chip.from + 1, insert: 'Y' } }).state
  assert.deepEqual(documentToDraft(insert).segments.map(segment => segment.type), ['text', 'attachment', 'text'])
  assert.equal(insert.doc.toString().includes('<pasted-text>'), false)
})

test('undo restores removed chips with their metadata, redo removes them again', () => {
  const state = editorState()
  const [chip, file] = getComposerChips(state)
  const removed = state.update({ changes: { from: chip.from, to: file.to }, userEvent: 'delete' }).state
  assert.deepEqual(documentToDraft(removed), makeComposerDraft([{ type: 'text', text: 'before  after\n' }]))
  const restored = run(removed, undo)
  assert.deepEqual(documentToDraft(restored), draft)
  assert.deepEqual(run(restored, redo).doc.toString(), removed.doc.toString())
  assert.deepEqual(getComposerChips(run(restored, redo)), [])
})

test('chip insertion snaps out of chips and places the caret after the inserted chips', () => {
  const state = editorState()
  const [chip] = getComposerChips(state)
  assert.equal(snapOutsideChips(state, chip.from + 2), chip.from)
  assert.equal(snapOutsideChips(state, chip.to - 2), chip.to)
  const second = { ...attachment, ref: 'attachment2' }
  const next = state.update(insertChipsSpec(state, [second], chip.to - 2, chip.to - 2)).state
  assert.deepEqual(documentToDraft(next).segments.map(segment => segment.ref || segment.type), ['text', 'pasted-text', 'attachment2', 'attachment1', 'text'])
  assert.equal(next.selection.main.head, chip.to + '<attachment-ref ref="attachment2" />'.length)
  assert.deepEqual(next.selection, EditorSelection.single(next.selection.main.head))
})
