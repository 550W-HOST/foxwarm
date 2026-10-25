import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

if (process.versions.unicode !== '17.0') {
  throw new Error(`Unicode 17.0 is required for Source lowercase generation/comparison; use Node 24.21.0 (running Node ${process.versions.node}, Unicode ${process.versions.unicode}).`);
}
const [root, inputPath, outputPath] = process.argv.slice(2)
if (!root || !inputPath || !outputPath) throw new Error('usage: session-catalog-fixture-ts.mjs ROOT INPUT OUTPUT')
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../../..')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const { SessionCatalogStore } = await import(pathToFileURL(path.join(repository, 'lib/session/catalogStore.js')).href)
const rows = JSON.parse(await fs.readFile(inputPath, 'utf8'))
await fs.mkdir(root, { recursive: true })
const sourcePath = path.join(root, 'source-v2.sqlite')
const source = new SessionCatalogStore(sourcePath); source.initializeEmpty(); source.replaceAll(rows)
const ids = rows.map(row => row.id); const parents = ['root', 'alpha/a', 'cycle-a', 'none']
const normalizeChildren = groups => groups.map(group => ({ parent: group.parentSessionId, rows: group.rows, total: group.total, hasMore: Boolean(group.nextKey) }))
function snapshot(store) {
  const pages = [], children = []
  for (const mode of ['default', 'time', 'flat-time']) {
    for (const roots of [true, false]) {
      const first = store.listPresentationPage({ mode, roots: roots && mode !== 'flat-time', limit: 3 })
      const second = store.listPresentationPage({ mode, roots: roots && mode !== 'flat-time', limit: 3, ...(first.nextKey ? { after: first.nextKey } : {}) })
      pages.push({ mode, roots, first: { rows: first.rows, hasMore: first.hasMore }, second: { rows: second.rows, hasMore: second.hasMore } })
    }
  }
  for (const mode of ['default', 'time']) {
    const first = store.listChildrenContinuations(parents.map(parentSessionId => ({ parentSessionId })), mode, 2)
    const second = store.listChildrenContinuations(first.map(group => ({ parentSessionId: group.parentSessionId, ...(group.nextKey ? { after: group.nextKey } : {}) })), mode, 2)
    children.push({ mode, first: normalizeChildren(first), second: normalizeChildren(second) })
  }
  const forest = store.listAgentForestPage({ agent: 'beta', limit: 3 })
  return { records: store.getMany(ids), resolutions: store.resolveMany([...ids, 'shared', 'root-alias', 'not-found']), scopes: store.getPresentationScopes(ids), paths: store.getPresentationPaths(ids),
    summary: store.getArchitectureSummary(), agents: store.getAgentCounts(), counts: store.getPresentationChildCounts(parents), agentCounts: store.getPresentationChildCounts(parents, 'beta'),
    busy: Object.fromEntries(store.getBusyDescendantCounts(parents, rows.filter(row => row.busy).map(row => row.id))), descendants: store.getDescendantSummary('root', 5), pages, children,
    forest: { rows: forest.rows, hasMore: forest.hasMore } }
}
function schema(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row, sql: row.sql.replace(/\s+/g, '').toLowerCase() })) }
  finally { db.close() }
}
const expected = snapshot(source); const v2schema = schema(sourcePath); source.close()
// Construct a genuine historical v1 layout using its source DDL and real source-projected rows.
const old = new DatabaseSync(path.join(root, 'source-v1.sqlite')); old.exec(await fs.readFile(path.join(import.meta.dirname, 'catalog-v1-fixture.sql'), 'utf8'))
const original = new DatabaseSync(sourcePath, { readOnly: true })
const columns = old.prepare('PRAGMA table_xinfo(session_catalog)').all().filter(column => column.hidden === 0).map(column => column.name)
const insert = old.prepare(`INSERT INTO session_catalog(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
for (const row of original.prepare(`SELECT ${columns.join(',')} FROM session_catalog`).all()) insert.run(...columns.map(column => row[column]))
const alias = old.prepare('INSERT INTO session_alias(alias,session_id,ordinal) VALUES(?,?,?)')
for (const row of original.prepare('SELECT alias,session_id,ordinal FROM session_alias').all()) alias.run(row.alias, row.session_id, row.ordinal)
original.close(); old.close()
await fs.copyFile(path.join(root, 'source-v1.sqlite'), path.join(root, 'dotnet-v1.sqlite'))
const upgrade = new SessionCatalogStore(path.join(root, 'source-v1.sqlite')); upgrade.open()
const upgraded = snapshot(upgrade); upgrade.close()
// Exercise full, locale-independent source lowercasing, including contextual sigma.
let text = 'İ ΟΣ ΟΣΑ ΟΣ\u0307Α ΟΣ\u2019 ΑΣ꟎ ꟎Σ ΑΣ\u{16EA0} \u{16EA0}Σ ΑΣ\u1ACFΑ Α\u1ACFΣ '; for (let code = 0; code <= 0x10ffff; code++) if (code < 0xd800 || code > 0xdfff) text += String.fromCodePoint(code)
await fs.writeFile(path.join(root, 'lower-input.txt'), text); await fs.writeFile(path.join(root, 'lower-expected.txt'), text.toLowerCase())
await fs.writeFile(outputPath, JSON.stringify({ expected, upgraded, schema: v2schema, upgradedSchema: schema(path.join(root, 'source-v1.sqlite')) }))
