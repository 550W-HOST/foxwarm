import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [mode, root, resultPath, inputPath, requestedSessionId] = process.argv.slice(2)
if (!mode || !root || !resultPath) {
  throw new Error('usage: session-persistence-fixture-ts.mjs MODE ROOT RESULT [INPUT]')
}
const foxwarmRoot = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../..')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const importFromFoxwarm = relative => import(pathToFileURL(path.join(foxwarmRoot, 'lib', relative)).href)
const sessionId = requestedSessionId || 'c1/fixture'

async function readResult() {
  const { readSessionHistorySnapshot } = await importFromFoxwarm('session/metadataStore.js')
  const { readLocalArchiveMessages } = await importFromFoxwarm('session/archive.js')
  const authority = await readSessionHistorySnapshot(sessionId)
  const records = await readLocalArchiveMessages(sessionId)
  const database = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true })
  const rawRows = database.prepare(`
    SELECT agent,seq,timestamp,role,message_json
    FROM archive_messages WHERE session_id=? ORDER BY seq
  `).all(sessionId)
  database.close()
  return { authority, records, rawRows }
}

if (mode === 'write-ts') {
  const { appendMessagesToArchive } = await importFromFoxwarm('session/archive.js')
  const { writeAuthoritativeSessionState } = await importFromFoxwarm('session/stateFile.js')
  const numericOpaque = { '10': 'ten', '2': 'two', a: 'aye' }
  const messages = [
    {
      role: 'user',
      parts: [{ text: 'héllo separator  quote:" slash:\\ literal:\\u2028 control:\u0001', opaque: numericOpaque }],
      __meta: { timestamp: 1000, fractionalTiming: 12.5, futureMeta: { enabled: true } },
      futureMessage: { preserve: 'yes' },
    },
    {
      role: 'model',
      parts: [{
        functionCall: {
          id: 'call-1', name: 'write_fixture',
          args: { fileName: 'fixture.txt', content: 'héllo', opaque: numericOpaque, fraction: 12.5 },
          rawArgsText: '{"fileName":"fixture.txt","content":"héllo"}',
        },
        providerMeta: { future: numericOpaque },
      }],
      __meta: { timestamp: 2000, llmRequestTiming: { startedAt: 1987.5, completedAt: 2000, durationMs: 12.5 } },
    },
    {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'write_fixture', response: { output: 'created', opaque: numericOpaque } } }],
      __meta: { timestamp: 3000 },
    },
    {
      role: 'model',
      parts: [{ text: 'final café  ' }],
      providerMeta: { providerSpecificFields: { '10': 'ten', '2': 'two', signature: 'sig\\"' }, sourceModelId: 'openai/test' },
      __meta: { timestamp: 4000, modelId: 'openai/test', usage: { inputTokens: 1.5, outputTokens: 2 } },
    },
  ]
  const session = {
    id: sessionId,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: 'fixture snapshot',
    promptCacheKey: 'fixture-cache-key',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: 4000 },
    currentNode: 'master',
    historyVersion: 0,
    nextMessageSeq: 1,
    nextBlockId: 1,
    lastAppliedMailboxId: 0,
    futureTopLevel: { '10': 'ten', '2': 'two', retained: true },
  }
  await appendMessagesToArchive(session, messages)
  session.history.push(...messages)
  await writeAuthoritativeSessionState(session)
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify(await readResult()), 'utf8')
} else if (mode === 'read') {
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify(await readResult()), 'utf8')
} else if (mode === 'stringify') {
  if (!inputPath) throw new Error('stringify mode requires INPUT')
  const values = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify(values.map(value => JSON.stringify(value))), 'utf8')
} else if (mode === 'number-stringify') {
  if (!inputPath) throw new Error('number-stringify mode requires INPUT')
  const bitPatterns = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  const results = bitPatterns.map(hex => {
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeBigUInt64LE(BigInt(`0x${hex}`))
    const value = bytes.readDoubleLE()
    if (!Number.isFinite(value)) return null
    return JSON.stringify(value)
  })
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify(results), 'utf8')
} else if (mode === 'replay-ts') {
  const { readSessionHistorySnapshot } = await importFromFoxwarm('session/metadataStore.js')
  const { writeArchiveMessages } = await importFromFoxwarm('session/archiveStore.js')
  const authority = await readSessionHistorySnapshot(sessionId)
  if (!authority) throw new Error('authority missing for replay')
  const records = authority.history.map(message => ({
    v: 1,
    kind: 'message',
    sessionId,
    agent: authority.agent || 'main',
    seq: message.__meta.seq,
    timestamp: message.__meta.timestamp,
    role: message.role,
    message,
  }))
  const inserted = await writeArchiveMessages(records)
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, JSON.stringify({ insertedCount: inserted.length }), 'utf8')
} else {
  throw new Error(`unknown mode: ${mode}`)
}
