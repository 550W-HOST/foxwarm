import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [root, rowFile] = process.argv.slice(2)
if (!root || !rowFile) throw new Error('usage: session-catalog-seed-ts.mjs ROOT ROWS')
process.env.FOXWARM_DATA_DIR = root; process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
const archive = await import(pathToFileURL(path.join(repository, 'lib/session/archiveStore.js')).href)
archive.initArchiveStoreSync()
for (const row of JSON.parse(await fs.readFile(rowFile, 'utf8'))) await archive.ensureSessionBranch(row.id, { createdAt: 100 })
// Retained audit identity is intentionally not catalog membership.
await archive.ensureSessionBranch('retained-not-live', { createdAt: 100 })
