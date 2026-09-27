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

test('session rows only enable drag for fine mouse input', async () => {
  const { shouldActivateSessionListDrag, shouldEnableSessionListDrag } = await loadTypeScriptModule('../src/sessionListDrag.ts')

  assert.equal(shouldEnableSessionListDrag(true, false), true)
  assert.equal(shouldEnableSessionListDrag(true, true), false)
  assert.equal(shouldEnableSessionListDrag(false, false), false)
  assert.equal(shouldActivateSessionListDrag(true, 'mouse'), true)
  assert.equal(shouldActivateSessionListDrag(true, 'touch'), false)
  assert.equal(shouldActivateSessionListDrag(true, 'pen'), false)
  assert.equal(shouldActivateSessionListDrag(false, 'mouse'), false)
})

test('mobile session-list UI opts out of row drag while the desktop sidebar keeps it', async () => {
  const [mobileListSource, desktopSidebarSource, coreSource] = await Promise.all([
    readFile(new URL('../src/components/SessionList.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SessionListCore.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(mobileListSource, /<SessionListCore[\s\S]*?dragEnabled=\{false\}/)
  assert.doesNotMatch(desktopSidebarSource, /<SessionListCore[\s\S]*?dragEnabled=\{false\}/)
  assert.match(coreSource, /touch-pan-y/)
  assert.match(coreSource, /shouldActivateSessionListDrag\(dragEnabled, event\.pointerType\)/)
})