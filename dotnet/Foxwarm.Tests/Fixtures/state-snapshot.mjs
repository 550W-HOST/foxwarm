// Restores a recorded data-directory snapshot into a caller-owned root. Snapshots hold state
// written by the retired TypeScript backend (final TypeScript revision
// 80f740477c25d3b42165bb0d201e74ebc5fd4479), so browser and app scenarios can start managed
// Main on genuine TypeScript-era data without that backend. SQLite files are stored logically:
// schema statements, connection pragmas and typed rows. The literal `${ROOT}` in recorded text
// stands for the data root the state was recorded in.
// Snapshots are gzip-compressed JSON (`zcat` shows them).
// Usage: node state-snapshot.mjs SNAPSHOT ROOT  (prints the recorded seed result as JSON)
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

const ROOT = '${ROOT}'
const withRoot = (value, root) => typeof value === 'string' ? value.split(ROOT).join(root) : value

function decode(cell, root) {
  if (cell === null) return cell
  // node:sqlite binds every JavaScript number as REAL; recorded integers stay INTEGER.
  if (typeof cell === 'number') return BigInt(cell)
  if (typeof cell === 'string') return withRoot(cell, root)
  if ('int' in cell) return BigInt(cell.int)
  if ('real' in cell) return cell.real
  if ('blob' in cell) return Buffer.from(cell.blob, 'base64')
  throw new Error('Unsupported snapshot cell ' + JSON.stringify(cell))
}

function restoreDatabase(file, database, root) {
  const db = new DatabaseSync(file)
  try {
    if (database.journalMode) db.exec(`PRAGMA journal_mode=${database.journalMode}`)
    db.exec('BEGIN')
    const deferred = []
    for (const entry of database.schema) {
      if (!entry.sql || entry.name === 'sqlite_sequence') continue
      // Rows are inserted before triggers so count triggers do not count them twice.
      if (entry.type === 'trigger') deferred.push(entry.sql)
      else db.exec(entry.sql)
    }
    for (const [table, { columns, rows }] of Object.entries(database.tables)) {
      // AUTOINCREMENT counters are restored as recorded, not as the inserts left them.
      if (table === 'sqlite_sequence') db.exec('DELETE FROM sqlite_sequence')
      if (!rows.length) continue
      const names = columns.map(column => JSON.stringify(column)).join(',')
      for (const row of rows) {
        const values = row.map(cell => cell !== null && typeof cell === 'object' && 'real' in cell ? 'CAST(? AS REAL)' : '?').join(',')
        db.prepare(`INSERT INTO ${JSON.stringify(table)}(${names}) VALUES(${values})`).run(...row.map(cell => decode(cell, root)))
      }
    }
    for (const sql of deferred) db.exec(sql)
    db.exec(`PRAGMA user_version=${database.userVersion}`)
    db.exec('COMMIT')
  } finally { db.close() }
}

export async function restoreStateSnapshot(snapshotPath, root) {
  const bytes = await fs.readFile(snapshotPath)
  const snapshot = JSON.parse((snapshotPath.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))
  for (const directory of snapshot.directories) await fs.mkdir(path.join(root, directory), { recursive: true })
  for (const file of snapshot.files) {
    const target = path.join(root, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if ('text' in file) await fs.writeFile(target, withRoot(file.text, root))
    else if ('base64' in file) await fs.writeFile(target, Buffer.from(file.base64, 'base64'))
    else restoreDatabase(target, file.sqlite, root)
  }
  return JSON.parse(withRoot(JSON.stringify(snapshot.result ?? null), root))
}

if (process.argv[1] === import.meta.filename) {
  const [snapshot, root] = process.argv.slice(2)
  if (!snapshot || !root) throw new Error('usage: state-snapshot.mjs SNAPSHOT ROOT')
  console.log(JSON.stringify(await restoreStateSnapshot(snapshot, root)))
}
