import test from 'node:test'
import assert from 'node:assert/strict'
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

test('changing launcher nodes resets the draft path to the neutral root', async () => {
  const { selectLauncherDraftNode } = await loadTypeScriptModule('../src/launcherDraft.ts')
  const original = { nodeId: 'master', path: '/home/project' }

  const remote = selectLauncherDraftNode(original, 'remote-a')
  assert.deepEqual(remote, { nodeId: 'remote-a', path: '/' })

  const editedRemote = { ...remote, path: '/srv/project' }
  assert.deepEqual(selectLauncherDraftNode(editedRemote, 'master'), { nodeId: 'master', path: '/' })
})

test('selecting the current node leaves the complete launcher draft unchanged', async () => {
  const { selectLauncherDraftNode } = await loadTypeScriptModule('../src/launcherDraft.ts')
  const draft = { nodeId: 'remote-a', path: '/srv/project', pathError: 'existing error' }

  assert.equal(selectLauncherDraftNode(draft, 'remote-a'), draft)
})
