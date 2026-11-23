import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const sourceRoot = new URL('../src/', import.meta.url).pathname
// The shared Select renders the only native select: the system picker on coarse pointers.
const allowed = new Set(['components/Select.tsx'])

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(tsx|ts)$/.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

test('WebUI choice controls use the shared Select instead of a native select', async () => {
  const offenders = []
  for (const file of await sourceFiles(sourceRoot)) {
    const path = relative(sourceRoot, file).replaceAll('\\', '/')
    if (allowed.has(path)) continue
    const source = await readFile(file, 'utf8')
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      if (/<select[\s>]|createElement\(\s*['"]select['"]/.test(line)) offenders.push(`${path}:${index + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'Use components/Select.tsx for choice controls')
})
