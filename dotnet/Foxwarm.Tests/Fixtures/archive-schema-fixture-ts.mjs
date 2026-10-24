import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [mode, root, layout] = process.argv.slice(2)
if (!root || !['seed', 'verify'].includes(mode) || !['current', 'retained'].includes(layout)) {
  throw new Error('usage: archive-schema-fixture-ts.mjs seed|verify ROOT current|retained')
}
// Bind owned paths before importing application modules, including in direct runs.
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../../../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(root))
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../../..')
const archive = await import(pathToFileURL(path.join(repository, 'lib/session/archiveStore.js')).href)
const databasePath = path.join(root, 'state/archive-store.sqlite')
const raw = (sessionId, seq) => ({ v: 1, kind: 'message', sessionId, agent: 'main', seq,
  timestamp: seq * 1000, role: 'user', message: { role: 'user', parts: [{ text: sessionId + ' ' + seq }],
    __meta: { seq, timestamp: seq * 1000 } } })
if (mode === 'seed') {
  await archive.initArchiveStore()
  if (layout === 'retained') {
    // The historical producer added this nullable column to an existing six-column table.
    const db = new DatabaseSync(databasePath)
    db.exec('ALTER TABLE archive_branches ADD COLUMN fork_block_raw_end_seq INTEGER')
    db.close()
  }
  await archive.ensureSessionBranch('parent', { createdAt: 1000 })
  await archive.writeArchiveMessages([1, 2, 3].map(seq => raw('parent', seq)))
  await archive.writeArchiveBlocks([1, 2].map(id => ({ v: 1, kind: 'block', sessionId: 'parent',
    agent: 'main', id, level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: id,
    rawStartSeq: 1, rawEndSeq: id, summary: 'parent block ' + id, createdAt: id * 1000 })))
  await archive.ensureSessionBranch('child', {
    parentSessionId: 'parent', forkMessageSeq: 2, forkBlockId: 2, createdAt: 2000,
  })
  await archive.writeArchiveMessages([raw('child', 3)])
  if (layout === 'retained') {
    const db = new DatabaseSync(databasePath)
    db.exec("UPDATE archive_branches SET fork_block_raw_end_seq=1 WHERE session_id='child'")
    db.close()
  }
} else {
  // Current Source must be able to reopen and fork data written by the managed owner.
  await archive.initArchiveStore()
  await archive.ensureSessionBranch('source-reopen', {
    parentSessionId: 'nested', forkMessageSeq: 4, forkBlockId: 2, createdAt: 5000,
  })
  await archive.writeArchiveMessages([raw('source-reopen', 5)])
}
const id = mode === 'seed' ? 'child' : 'source-reopen'
const messages = await archive.readEffectiveArchiveMessages(id)
const blocks = await archive.readEffectiveArchiveBlocks(id)
assert.deepEqual(messages.map(row => [row.sessionId, row.seq]), mode === 'seed'
  ? [['parent', 1], ['parent', 2], ['child', 3]]
  : [['parent', 1], ['parent', 2], ['child', 3], ['nested', 4], ['source-reopen', 5]])
// Current Source ignores the retained raw cap and inherits by block ID.
assert.deepEqual(blocks.map(row => row.id), [1, 2])
assert.deepEqual((await archive.readEffectiveArchiveMessagePage(id, { limit: 100 })).records.map(row => row.seq),
  mode === 'seed' ? [1, 2, 3] : [1, 2, 3, 4, 5])
console.log('ARCHIVE_SCHEMA_FIXTURE:' + JSON.stringify({ messages: messages.map(row => row.message),
  blocks: blocks.map(row => row.id) }))
process.exit(0)
