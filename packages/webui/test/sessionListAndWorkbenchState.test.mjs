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

test('workbench normalization ignores and removes legacy tab pinned state', async () => {
  const { normalizePersistedWorkbenchState } = await loadTypeScriptModule('../src/workbench/utils.ts')
  const normalized = normalizePersistedWorkbenchState({
    version: 4,
    tabsById: {
      'chat:one': {
        id: 'chat:one',
        type: 'chat',
        sessionId: 'one',
        title: 'One',
        pinned: true,
      },
      'terminal:two': {
        id: 'terminal:two',
        type: 'terminal',
        title: 'Two',
        cwd: '/tmp',
        pinned: false,
      },
      'vscode-web': {
        id: 'vscode-web',
        type: 'vscode',
        title: 'VS Code',
      },
    },
    root: {
      id: 'pane-one',
      kind: 'pane',
      tabIds: ['chat:one', 'terminal:two', 'vscode-web'],
      activeTabId: 'terminal:two',
    },
    focusedPaneId: 'pane-one',
  })

  assert.deepEqual(normalized.root.tabIds, ['chat:one', 'terminal:two', 'vscode-web'])
  assert.equal(normalized.root.activeTabId, 'terminal:two')
  assert.equal(normalized.focusedPaneId, 'pane-one')
  assert.equal(Object.hasOwn(normalized.tabsById['chat:one'], 'pinned'), false)
  assert.equal(Object.hasOwn(normalized.tabsById['terminal:two'], 'pinned'), false)
  assert.equal(normalized.tabsById['vscode-web'].type, 'vscode')
})

test('VS Code Web URLs preserve root and reverse-proxy base paths', async () => {
  const { getVscodeWebPath, makeVscodeWebUrl } = await loadTypeScriptModule('../src/vscodeWeb.ts')
  assert.equal(getVscodeWebPath('/api'), '/vscode-web/')
  assert.equal(getVscodeWebPath('/proxy-prefix/api'), '/proxy-prefix/vscode-web/')
  assert.equal(makeVscodeWebUrl('/proxy-prefix/api', 'https://example.test').toString(), 'https://example.test/proxy-prefix/vscode-web/')
})

test('session list comparator keeps pinned sessions first in every mode', async () => {
  const { compareSessionListSessions, shouldElevateSessionToRoot } = await loadTypeScriptModule('../src/sessionListPresentation.ts')
  const pinnedOlder = { id: 'pinned-older', pinned: true, sidebarOrder: 9000, lastMessageTime: 10 }
  const regularNewer = { id: 'regular-newer', sidebarOrder: 1, lastMessageTime: 100 }

  for (const mode of ['default', 'time', 'flat-time']) {
    assert.ok(compareSessionListSessions(pinnedOlder, regularNewer, mode) < 0, mode)
  }

  const orderedOlder = { id: 'ordered-older', pinned: true, sidebarOrder: 1, lastMessageTime: 10 }
  const orderedNewer = { id: 'ordered-newer', pinned: true, sidebarOrder: 2, lastMessageTime: 100 }
  assert.ok(compareSessionListSessions(orderedOlder, orderedNewer, 'default') < 0)
  assert.ok(compareSessionListSessions(orderedOlder, orderedNewer, 'time') > 0)
  assert.ok(compareSessionListSessions(orderedOlder, orderedNewer, 'flat-time') > 0)
  assert.equal(shouldElevateSessionToRoot({ pinned: true }, 'default'), true)
  assert.equal(shouldElevateSessionToRoot({ pinned: true }, 'time'), true)
  assert.equal(shouldElevateSessionToRoot({ pinned: false }, 'default'), false)
  assert.equal(shouldElevateSessionToRoot({ pinned: false }, 'flat-time'), true)
})
