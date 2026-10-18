// Actual retained Source writers/exporters and readers qualify the CLI boundary.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const [mode, root, artifacts] = process.argv.slice(2)
if (!['seed', 'verify', 'migrate', 'read-legacy'].includes(mode) || !root) throw Error('usage: cli-archive-fixture-ts.mjs seed|verify|migrate|read-legacy ROOT [EXPORT]')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_CONFIG_PATH = path.join(root, 'state/config.yaml')
process.env.FOXWARM_NO_CONSOLE_LOG = '1'
process.env.FOXWARM_SYNC_FILE_LOG = '1'
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
const load = name => import(pathToFileURL(path.join(repository, 'lib', name)).href)
await fs.mkdir(path.join(root, 'state'), { recursive: true })
await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\nbot:\n  enableWebUI: false\n  enableTrigger: false\n')
if (mode === 'seed') {
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: fixture\nproviders:\n  fixture:\n    providerType: openai\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n')
  const sm = await load('sessionManager.js')
  const archive = await load('session/archiveStore.js')
  const { sessionCatalogStore } = await load('session/catalogStore.js')
  const journal = await load('llmRequestJournal.js')
  await sm.loadSessions()
  const parent = (await sm.createEmptySession('legacy_parent')).session
  await sm.appendSessionMessage(parent, { role: 'user', parts: [{ text: 'Original 漢字 😀\u2028line separator', futurePart: { keep: true } }], __meta: { timestamp: 1001 }, futureMessage: 'retained' })
  await sm.appendSessionMessage(parent, { role: 'model', parts: [{ text: 'Source assistant' }], __meta: { timestamp: 1002 } })
  await archive.writeArchiveBlocks([{ v: 1, kind: 'block', sessionId: parent.id, agent: 'main', id: 1, level: 1,
    sourceKind: 'message', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2,
    rawStartTimestamp: 1001, rawEndTimestamp: 1002, summary: 'Source retained summary', memoryFacts: [{ kind: 'fact', text: 'Source fact', attributedTo: 'user' }], frictionScore: 32, createdAt: 1003 }])
  const childId = await sm.forkSession(parent.id, 'legacy_child')
  await sm.appendSessionMessage(childId, { role: 'user', parts: [{ text: 'Child local' }], __meta: { timestamp: 1004 } })
  const request = await journal.beginLlmRequestJournal({ purpose: 'cli', iteration: 0, systemPrompt: 'Source CLI system', toolDefinitions: [],
    messages: [{ role: 'user', parts: [{ text: 'Source CLI prompt' }] }], requestedModelKey: 'fixture/wire', promptCacheKey: 'source-fixture-lineage' })
  await journal.appendLlmAttemptStart({ requestId: request.requestId, attempt: 1, concreteModelId: 'fixture/wire', providerType: 'openai', semanticPayload: { model: 'wire' } })
  await journal.appendLlmAttemptResult({ requestId: request.requestId, attempt: 1, outcome: 'success', result: { text: 'Source answer', modelId: 'fixture/wire' } })
  const legacy = path.join(root, 'legacy')
  const logs = path.join(legacy, 'state/logs/sessions')
  const expected = await archive.exportSessionArchivesJsonl(logs)
  await journal.exportLlmRequestJournalJsonl(path.join(legacy, 'state/llm-request-journal.jsonl'))
  // The real historical fork layout copied the inherited prefix into child logs.
  for (const suffix of ['.jsonl', '.blocks.jsonl']) {
    const parentRows = await fs.readFile(path.join(logs, parent.id + suffix), 'utf8')
    const childPath = path.join(logs, childId + suffix)
    const own = await fs.readFile(childPath, 'utf8').catch(() => '')
    await fs.mkdir(path.dirname(childPath), { recursive: true })
    await fs.writeFile(childPath, parentRows + own)
  }
  const metadata = Object.fromEntries(sessionCatalogStore.list().map(row => [row.id, row]))
  await fs.writeFile(path.join(legacy, 'state/sessions.json'), JSON.stringify({ sessions: metadata }))
  await fs.cp(path.join(root, 'state/sessions'), path.join(legacy, 'state/sessions'), { recursive: true })
  await fs.copyFile(path.join(root, 'state/config.yaml'), path.join(legacy, 'state/config.yaml'))
  await fs.copyFile(path.join(root, 'state/models.yaml'), path.join(legacy, 'state/models.yaml'))
  await fs.writeFile(path.join(legacy, 'fixture.json'), JSON.stringify({ parentId: parent.id, childId, requestId: request.requestId }))
  console.log(JSON.stringify({ legacy, parentId: parent.id, childId, requestId: request.requestId, expected, messages: expected.records - 1 }))
} else if (mode === 'read-legacy') {
  const { runSqliteOnlyArchivesMigration } = await load('migrations/index.js')
  await runSqliteOnlyArchivesMigration()
  const archive = await load('session/archiveStore.js')
  console.log(JSON.stringify({ messages: await archive.readLocalArchiveMessages('legacy') }))
} else {
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'))
  if (mode === 'verify') {
    await fs.cp(path.join(artifacts, 'sessions'), path.join(root, 'state/logs/sessions'), { recursive: true })
    await fs.copyFile(path.join(artifacts, 'llm-request-journal.jsonl'), path.join(root, 'state/llm-request-journal.jsonl'))
  }
  const { runSqliteOnlyArchivesMigration } = await load('migrations/index.js')
  await runSqliteOnlyArchivesMigration()
  const archive = await load('session/archiveStore.js')
  const journal = await load('llmRequestJournal.js')
  const messages = await archive.readLocalArchiveMessages(fixture.parentId)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].message.futureMessage, 'retained')
  const blocks = await archive.readLocalArchiveBlocks(fixture.parentId)
  assert.equal(blocks[0].frictionScore, 32)
  const request = await journal.reconstructLlmRequest(fixture.requestId)
  assert.equal(request.completeness, 'complete')
  console.log(JSON.stringify({ messages: messages.length, blocks: blocks.length, journal: request.completeness,
    childBranch: await archive.getSessionBranch(fixture.childId) }))
}
process.exit(0)
