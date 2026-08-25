import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webuiRoot = fileURLToPath(new URL('..', import.meta.url))
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-message-attachment-drafts-test-'))
const bundledPath = path.join(tempDir, 'messageAttachmentDrafts.mjs')

await build({
  entryPoints: [path.join(webuiRoot, 'src/messageAttachmentDrafts.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundledPath,
  logLevel: 'silent',
})

const {
  clearMessageAttachmentDraft,
  getMessageAttachmentDraft,
  setMessageAttachmentDraft,
  updateMessageAttachmentDraft,
} = await import(`${pathToFileURL(bundledPath).href}?${Date.now()}`)

const file = (name) => new File([name], name, { type: 'text/plain' })

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('preserves File identity and order while defending stored arrays', () => {
  const first = file('first.txt')
  const second = file('second.txt')
  const source = [first, second]

  const returned = setMessageAttachmentDraft('agent/a', source)
  source.reverse()
  returned.pop()

  const restored = getMessageAttachmentDraft('agent/a')
  assert.deepEqual(restored, [first, second])
  assert.equal(restored[0], first)
  assert.equal(restored[1], second)

  restored.shift()
  assert.deepEqual(getMessageAttachmentDraft('agent/a'), [first, second])
})

test('isolates sessions and updates only the targeted draft', () => {
  const a = file('a.txt')
  const b = file('b.txt')
  setMessageAttachmentDraft('agent/a', [a])
  setMessageAttachmentDraft('agent/b', [b])

  const appended = file('a-2.txt')
  updateMessageAttachmentDraft('agent/a', files => [...files, appended])

  assert.deepEqual(getMessageAttachmentDraft('agent/a'), [a, appended])
  assert.deepEqual(getMessageAttachmentDraft('agent/b'), [b])
})

test('clear and empty writes remove only the selected session draft', () => {
  const a = file('clear-a.txt')
  const b = file('keep-b.txt')
  setMessageAttachmentDraft('clear/a', [a])
  setMessageAttachmentDraft('clear/b', [b])

  clearMessageAttachmentDraft('clear/a')
  assert.deepEqual(getMessageAttachmentDraft('clear/a'), [])
  assert.deepEqual(getMessageAttachmentDraft('clear/b'), [b])

  setMessageAttachmentDraft('clear/b', [])
  assert.deepEqual(getMessageAttachmentDraft('clear/b'), [])
})
