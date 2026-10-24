import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root, inputPath, outputPath] = process.argv.slice(2)
if (!mode || !root || !inputPath || !outputPath) throw new Error('Expected fixture mode, owned root, input and output')
const source = process.env.FOXWARM_TS_ROOT
if (!source) throw new Error('Set FOXWARM_TS_ROOT to the frozen built Source checkout')
process.env.FOXWARM_DATA_DIR = root
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
const load = relative => import(pathToFileURL(path.join(source, 'lib', relative)).href)
await fs.mkdir(path.join(root, 'state'), { recursive: true })
await fs.writeFile(path.join(root, 'state', 'config.yaml'), JSON.stringify(input.config || { vector: false, dbWorkers: false }))
const vector = await load('vectorRuntime.js')
const lexical = await load('archiveSearchIndex.js')
const formatter = await load('utils/messageFormat.js')
const config = await load('config.js')
let output
if (mode === 'recipes') {
  const archive = await load('session/archiveStore.js')
  await archive.initArchiveStore()
  if (input.records?.length) await archive.writeArchiveMessages(input.records)
  const segments = vector.buildArchiveSegments(input.records)
  const blocks = []
  for (const block of input.blocks || []) blocks.push(await vector.createRowFromBlockRecord(block))
  const recall = await load('toolsSessionAgent/archiveRecall.js')
  const transient = await load('toolsSessionAgent/archiveLexicalRecall.js')
  output = {
    sanitized: (input.utf16Samples || []).map(units => vector.sanitizeEmbeddingInput(String.fromCharCode(...units))),
    segments,
    rows: segments.flatMap(vector.createRowsFromSegment), blocks,
    facts: (input.blocks || []).flatMap(block => vector.createRowsFromMemoryFacts({
      sessionId: block.sessionId, agent: block.agent, facts: block.memoryFacts,
      sourceStartSeq: block.rawStartSeq, sourceEndSeq: block.rawEndSeq,
      blockId: block.id, blockLevel: block.level, createdAt: block.createdAt,
    })),
    formatted: input.records.map(row => row.message.modelVisible === false ? '' : formatter.formatMessageText(row.message, { includeRolePrefix: true, skipEphemeralSystem: true, skipRagMemorySnippets: true, skipThinking: true })),
    fts: input.queries.map(query => ({ text: lexical.buildArchiveSearchIndexText(query), compiled: ((result) => ({...result, identifierMatch: result.identifierMatch ?? null, proseMatch: result.proseMatch ?? null}))(lexical.compileArchiveSearchQuery(query)), locators: transient.extractStrongArchiveLocators(query) })),
    configs: input.configs.map(entry => ({ vector: config.normalizeVectorConfig(entry.vector, entry.legacy), workers: config.normalizeDbWorkersEnabled(entry.dbWorkers), maintenance: config.normalizeVectorMaintenanceConfig(entry.maintenance) })),
    windows: input.windows.map(window => {
      const selected = recall.selectVectorRawMessageWindow(window.records, window.query, window.chunk, window.filters)
      return { sequences: selected.records.map(row => row.seq), first: selected.selectedStartSeq, last: selected.selectedEndSeq, omitted: selected.omittedMessageCount, notices: selected.filterNotices }
    }),
  }
} else if (mode === 'quality') {
  const transient = await load('toolsSessionAgent/archiveLexicalRecall.js')
  output = input.cases.map(entry => {
    const selected = vector.selectSearchSourceGroupsDetailed(entry.rows, entry.limit, { preferBlocks: entry.preferBlocks })
    return { ...selected, fused: transient.fuseDenseAndLexicalHits(selected.selected, entry.lexical, entry.limit) }
  })
} else if (mode === 'transient') {
  const archive = await load('session/archiveStore.js')
  await archive.initArchiveStore()
  for (const branch of input.branches || []) await archive.ensureSessionBranch(branch.sessionId, branch)
  await archive.writeArchiveMessages(input.records)
  if (input.blocks?.length) await archive.writeArchiveBlocks(input.blocks)
  const transient = await load('toolsSessionAgent/archiveLexicalRecall.js')
  output = await transient.searchArchiveLexicalSideChannel(input.sessionId, input.query, 10)
} else if (mode === 'move-scope') {
  for (const agent of ['origin', 'destination']) {
    await fs.mkdir(path.join(root, 'agents', agent), { recursive: true })
    await fs.writeFile(path.join(root, 'agents', agent, 'config.yaml'), '{}')
  }
  const sessions = await load('sessionManager.js')
  const facade = await load('vector.js')
  await facade.init({ enabled: true, useWorker: false })
  await facade.waitForStartupArchiveVectorBackfill()
  const { sessionId: sourceId } = await sessions.createSessionInAgent({ agentName: 'origin', sessionName: 'source' })
  const { sessionId: callerId } = await sessions.createSessionInAgent({ agentName: 'origin', sessionName: 'caller' })
  const owned = await sessions.getExistingSession(sourceId)
  await sessions.appendSessionMessage(owned, { role: 'user', parts: [{ text: 'violet transferred authority marker' }] })
  await facade.indexSessionArchive(sourceId, owned.nextMessageSeq - 1, 0)
  const before = await facade.search('violet', 5, false, { agent: 'origin' })
  const moved = await sessions.moveSessionToTarget({ sourceSessionId: sourceId, newAgentName: 'destination', newSessionId: 'moved' })
  const caller = await sessions.getExistingSession(callerId)
  const recall = await load('toolsSessionAgent/archiveRecall.js')
  const context = { sessionId: callerId, session: caller, executionNode: 'master', agentName: 'origin', deferHistoryAppend: false }
  const implicit = await recall.tool_recall({ vector_query: 'violet', scope: 'current-agent' }, context)
  let explicit
  try { explicit = await recall.tool_recall({ vector_query: 'violet', sessionId: moved.targetSessionId }, context) }
  catch (error) { explicit = { error: error.message } }
  const after = await facade.search('violet', 5, false, { agent: 'origin' })
  const destination = await facade.search('violet', 5, false, { agent: 'destination' })
  await facade.shutdown()
  output = { sourceId, callerId, moved, before, after, destination, implicit, explicit }
} else if (mode === 'retained-alias') {
  const archive = await load('session/archiveStore.js')
  await archive.initArchiveStore()
  await archive.writeArchiveMessages(input.records)
  await archive.writeArchiveBlocks(input.blocks)
  await archive.commitSessionIdRename(input.oldSessionId, input.sessionId)
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'))
  // Persisted compatibility shape produced by f8ad3997's legacy importer:
  // pre-SQLite moves renamed log paths without rewriting payload IDs. Bootstrap
  // created the current branch but inserted the old payload identity verbatim.
  // Later migration imports canonical rows/reservations and retains those rows.
  database.prepare(`INSERT INTO archive_messages
    SELECT ?,agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=?`).run(input.oldSessionId, input.sessionId)
  database.prepare(`INSERT INTO archive_blocks
    (session_id,agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,
      raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,friction_score,created_at)
    SELECT ?,agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,
      raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,friction_score,created_at
    FROM archive_blocks WHERE session_id=?`).run(input.oldSessionId, input.sessionId)
  output = {
    maxima: await archive.listLocalArchiveSessionMaxima(),
    candidates: await archive.listSessionsNeedingVectorBackfill(),
    canonical: archive.resolveArchiveSessionIdReadOnly(input.oldSessionId),
    physicalMessages: database.prepare('SELECT session_id,seq FROM archive_messages ORDER BY session_id,seq').all(),
    physicalBlocks: database.prepare('SELECT session_id,id FROM archive_blocks ORDER BY session_id,id').all(),
  }
  database.close()
  if (input.runSource) {
    await vector.init()
    await vector.waitForStartupArchiveVectorBackfill()
    await archive.writeArchiveMessages([input.append])
    await vector.indexSessionArchive(input.sessionId, input.append.seq, input.blocks.at(-1).id)
    await vector.shutdown()
    const index = lexical.ArchiveSearchIndex.open(path.join(root, 'state', 'db', 'archive-search.sqlite'))
    output.oldCheckpoint = index.getCheckpoint(input.oldSessionId)
    output.currentCheckpoint = index.getCheckpoint(input.sessionId)
    index.close()
  }
} else if (mode === 'storage-create' || mode === 'storage-return') {
  const archive = await load('session/archiveStore.js')
  await archive.initArchiveStore()
  if (mode === 'storage-create') {
    for (const branch of input.branches || []) await archive.ensureSessionBranch(branch.sessionId, branch)
    await archive.writeArchiveMessages(input.records)
    if (input.blocks?.length) await archive.writeArchiveBlocks(input.blocks)
  } else {
    const checkpoint = archive.getVectorCheckpointSync(input.sessionId)
    if (input.append) await archive.writeArchiveMessages([input.append])
    output = { checkpoint }
  }
  await vector.init()
  await vector.waitForStartupArchiveVectorBackfill()
  if (input.facts) await vector.indexMemoryFactsFromCompaction(input.facts)
  const result = await vector.searchDetailed('violet', 20, false, input.options)
  await vector.shutdown()
  const { createRequire } = await import('node:module')
  const require = createRequire(path.join(source, 'package.json'))
  const lance = require('@lancedb/lancedb')
  const connection = await lance.connect(path.join(root, 'state', 'db'))
  const table = await connection.openTable('messages_v7')
  const rows = (await table.query().select(['id','session_id','agent','memory_kind','text','block_id']).toArray()).sort((a,b) => a.id.localeCompare(b.id))
  table.close(); connection.close()
  const unicode = await load('utils/unicode.js')
  output = { ...output, hits: result.hits, lexical: result.lexical, rows, fallbacks: rows.map(row => unicode.truncateUnicodeSafe(String(row.text || ''), 500)) }
} else {
  throw new Error('Unknown fixture mode')
}
await fs.writeFile(outputPath, JSON.stringify(output))
process.exit(0)
