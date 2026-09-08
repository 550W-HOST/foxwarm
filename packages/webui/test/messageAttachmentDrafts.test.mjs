import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/messageAttachmentDrafts.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const drafts = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const makeFile = (name, body = name) => new File([body], name, { type: 'text/plain' })

test('stable references preserve duplicate filenames, order, and exact File identity per Session', () => {
  const first = makeFile('duplicate.txt', 'first')
  const second = makeFile('duplicate.txt', 'second')
  const entries = drafts.createMessageAttachmentDrafts('agent/a', [first, second])
  assert.deepEqual(entries.map(item => item.ref), ['attachment1', 'attachment2'])
  assert.equal(drafts.getMessageAttachmentFile('agent/a', entries[0].ref), first)
  assert.equal(drafts.getMessageAttachmentFile('agent/a', entries[1].ref), second)
  assert.deepEqual(drafts.getMessageAttachmentDraft('agent/a').map(item => item.ref), entries.map(item => item.ref))
  assert.deepEqual(drafts.getMessageAttachmentDraft('agent/b'), [])
})

test('numeric allocation does not reuse a removed identity and honors reload-reserved refs', () => {
  const [first] = drafts.createMessageAttachmentDrafts('numeric/a', [makeFile('first.txt')])
  drafts.removeMessageAttachmentDraft('numeric/a', first.ref)
  assert.equal(drafts.createMessageAttachmentDrafts('numeric/a', [makeFile('second.txt')], ['attachment1'])[0].ref, 'attachment2')
})

test('reattach replaces only the exact reference and clear removes one Session owner', () => {
  const [entry] = drafts.createMessageAttachmentDrafts('agent/a', [makeFile('old.txt')])
  drafts.createMessageAttachmentDrafts('agent/b', [makeFile('other.txt')])
  const replacement = makeFile('new.txt')
  drafts.setMessageAttachmentFile('agent/a', entry.ref, replacement)
  assert.equal(drafts.getMessageAttachmentFile('agent/a', entry.ref), replacement)
  drafts.removeMessageAttachmentDraft('agent/a', entry.ref)
  assert.equal(drafts.getMessageAttachmentFile('agent/a', entry.ref), undefined)
  assert.equal(drafts.getMessageAttachmentDraft('agent/b').length, 1)
  drafts.clearMessageAttachmentDraft('agent/b')
  assert.deepEqual(drafts.getMessageAttachmentDraft('agent/b'), [])
})
