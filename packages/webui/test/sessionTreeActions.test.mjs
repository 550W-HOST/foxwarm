import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

async function loadTypeScriptModule(relativePath) {
  const result = await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('canonical lifecycle descendants ignore presentation and follow aliases through archived intermediates', async () => {
  const { getCanonicalSessionDescendantIds } = await loadTypeScriptModule('../src/sessionTreeActions.ts')
  const sessions = [
    { id: 'root', aliases: ['old-root'] },
    { id: 'archived-child', parentSessionId: 'old-root', archived: true, pinned: true },
    { id: 'grandchild', parentSessionId: 'archived-child' },
    { id: 'sibling', parentSessionId: 'root' },
    { id: 'unrelated' },
  ]

  assert.deepEqual(
    getCanonicalSessionDescendantIds(sessions, 'root'),
    ['archived-child', 'grandchild', 'sibling'],
  )
})

test('canonical lifecycle descendants reject relation cycles', async () => {
  const { getCanonicalSessionDescendantIds } = await loadTypeScriptModule('../src/sessionTreeActions.ts')
  assert.throws(
    () => getCanonicalSessionDescendantIds([
      { id: 'root', parentSessionId: 'child' },
      { id: 'child', parentSessionId: 'root' },
    ], 'root'),
    /relation cycle/i,
  )
})

test('session lifecycle dialogs expose default-off descendant controls and retain inline errors', async () => {
  const source = await readFile(new URL('../src/components/SessionListCore.tsx', import.meta.url), 'utf8')
  assert.match(source, /Also delete \{deleteDescendantCount\} descendant session/)
  assert.match(source, /Also archive \{archiveDescendantCount\} descendant session/)
  assert.match(source, /useState\(false\).*deleteIncludeDescendants|deleteIncludeDescendants, setDeleteIncludeDescendants/s)
  assert.match(source, /setDeleteError\(error\.error[\s\S]*?role="alert"/)
  assert.match(source, /body: JSON\.stringify\(\{ includeDescendants \}\)/)
})