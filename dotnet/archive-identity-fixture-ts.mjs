import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// Actual source lifecycle/Archive APIs operate only in the caller's owned synthetic root.
const [mode, root] = process.argv.slice(2)
if (!root || !['seed', 'verify'].includes(mode)) throw new Error('usage: archive-identity-fixture-ts.mjs seed|verify ROOT')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
if (mode === 'seed') {
  await fs.mkdir(path.join(root, 'state'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: archive-fixture-not-a-key\n    models: [wire]\n')
  await fs.writeFile(path.join(root, 'state/app.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\n')
}
const sm = await import(pathToFileURL(path.join(repository, 'lib/sessionManager.js')).href)
const archive = await import(pathToFileURL(path.join(repository, 'lib/session/archiveStore.js')).href)
await sm.loadSessions()
let ids
if (mode === 'seed') {
  const initial = (await sm.createEmptySession('archive_old')).session
  await sm.appendSessionMessage(initial, { role: 'user', parts: [{ text: 'Before move: 漢字, quotes " and old ID archive_old.' }], __meta: { timestamp: 1001 } })
  await sm.appendSessionMessage(initial, { role: 'model', parts: [{ text: 'Original assistant.' }], __meta: { timestamp: 1002 } })
  await archive.writeArchiveBlocks([{ v: 1, kind: 'block', sessionId: initial.id, agent: initial.agent, id: 1, level: 1,
    sourceKind: 'message', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2,
    rawStartTimestamp: 1001, rawEndTimestamp: 1002, summary: 'Original retained summary.', createdAt: 1003 }])
  const before = await sm.forkSession(initial.id, 'before')
  const beforeRollback = await archive.readLocalArchiveMessages(initial.id)
  sm.setSessionPersistenceFaultInjectorForTests((phase, id) => { if (phase === 'history' && id === 'archive_failed_move') throw new Error('Synthetic move target write failure') })
  try { await assert.rejects(sm.moveSessionToTarget({ sourceSessionId: initial.id, newSessionId: 'archive_failed_move' }), /Synthetic move target write failure/) }
  finally { sm.setSessionPersistenceFaultInjectorForTests(null) }
  assert.equal(await sm.getSession(initial.id), initial)
  assert.equal(await archive.hasArchivedSessionId('archive_failed_move'), false)
  assert.deepEqual(await archive.readLocalArchiveMessages(initial.id), beforeRollback)
  const middle = (await sm.moveSessionToTarget({ sourceSessionId: initial.id, newSessionId: 'archive_middle' })).targetSessionId
  const current = (await sm.moveSessionToTarget({ sourceSessionId: middle, newSessionId: 'current', createAgent: true, newAgentName: 'archive-target' })).targetSessionId
  await sm.appendSessionMessage(current, { role: 'user', parts: [{ text: 'New Agent audit row.' }], __meta: { timestamp: 2001 } })
  const after = await sm.forkSession(current, 'after')
  const nested = await sm.forkSession(before, 'nested')
  await sm.appendSessionMessage(current, { role: 'user', parts: [{ text: 'Past the earlier fork cap.' }], __meta: { timestamp: 3001 } })
  const empty = (await sm.createEmptySession('archive_zero')).session
  const zero = await sm.forkSession(empty.id, 'zero')
  await sm.appendSessionMessage(empty, { role: 'user', parts: [{ text: 'Excluded by genuine zero cap.' }], __meta: { timestamp: 4001 } })
  ids = ['archive_old', middle, current, before, after, nested, zero]
  for (const id of [current, before, after, nested, zero, empty.id]) await sm.deleteSession(id)
  await fs.writeFile(path.join(root, 'archive-fixture-ids.json'), JSON.stringify(ids))
} else ids = JSON.parse(await fs.readFile(path.join(root, 'archive-fixture-ids.json'), 'utf8'))

for (const id of ids) {
  try { await sm.createEmptySession(id); throw new Error('Historical identity was reused: ' + id) }
  catch (error) { if (error.code !== sm.ARCHIVED_SESSION_ID_ERROR_CODE) throw error }
}
const db = new DatabaseSync(path.join(root, 'state/archive-store.sqlite'), { readOnly: true })
const records = values => values.map(row => ({ sessionId: row.sessionId, agent: row.agent, seq: row.seq, timestamp: row.timestamp, role: row.role,
  messageJson: db.prepare('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?').get(row.sessionId, row.seq).message_json }))
const expected = {}
for (const id of [...ids, 'unknown-archive']) {
  const local = await archive.readLocalArchiveMessages(id)
  const effective = await archive.readEffectiveArchiveMessages(id)
  const blocks = await archive.readLocalArchiveBlocks(id)
  const effectiveBlocks = await archive.readEffectiveArchiveBlocks(id)
  expected[id] = { local: records(local), effective: records(effective), blocks, effectiveBlocks,
    branch: await archive.getSessionBranch(id), localStats: await archive.getLocalArchiveMessageStats(id),
    effectiveStats: await archive.getEffectiveArchiveMessageStats(id) }
}
const rows = db.prepare('SELECT session_id,agent,seq,timestamp,role,message_json FROM archive_messages ORDER BY session_id,seq').all()
const blockRows = db.prepare('SELECT * FROM archive_blocks ORDER BY session_id,id').all()
db.close()
console.log('ARCHIVE_FIXTURE:' + JSON.stringify({ ids, expected, rows, blockRows }))
process.exit(0)
