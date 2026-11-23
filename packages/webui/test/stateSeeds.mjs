// Persisted-state seeds for managed-Main browser scenarios. Catalog rows go through managed Main's
// own catalog writer (Foxwarm.DevTools catalog-fixture). Archive branches and recorded snapshots
// keep the TypeScript-era formats; see dotnet/Foxwarm.Tests/Fixtures/archive-store-seed.mjs and
// state-snapshot.mjs.
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openArchive, ensureBranch } from '../../../dotnet/Foxwarm.Tests/Fixtures/archive-store-seed.mjs'
export { restoreStateSnapshot } from '../../../dotnet/Foxwarm.Tests/Fixtures/state-snapshot.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
let seedFiles = 0

export const stateSnapshot = name => join(repository, 'dotnet/Foxwarm.Tests/Fixtures/snapshots', name + '.json.gz')

/** Writes catalog rows into DATA/state/catalog.sqlite; `replace` also removes rows not listed. */
export async function seedCatalog(data, rows, mode = 'replace') {
  const file = join(dirname(data), `catalog-seed-${++seedFiles}.json`)
  await writeFile(file, JSON.stringify(rows))
  execFileSync(join(process.env.DOTNET_ROOT, 'dotnet'), [
    join(repository, 'dotnet/Foxwarm.DevTools/bin/Debug/net10.0/Foxwarm.DevTools.dll'),
    'catalog-fixture', mode, data, file,
  ], { stdio: 'pipe' })
}

/** Registers an Archive branch, created at 100, for every row ID plus the audit-only `retained-not-live`. */
export function seedArchiveBranches(data, rows) {
  const db = openArchive(data)
  try {
    for (const row of rows) ensureBranch(db, row.id, 100)
    ensureBranch(db, 'retained-not-live', 100)
  } finally { db.close() }
}
