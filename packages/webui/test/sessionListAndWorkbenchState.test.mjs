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

test('agent/session creation helpers keep an empty session ID random', async () => {
  const {
    RANDOM_SESSION_ID_PLACEHOLDER,
    buildSessionCreationBody,
    validateAgentId,
    validateSessionId,
  } = await loadTypeScriptModule('../src/agentCreation.ts')

  assert.equal(validateAgentId('new-agent_2'), null)
  assert.match(validateAgentId('../bad'), /letters, numbers/i)
  assert.equal(validateSessionId('custom-session'), null)
  assert.match(validateSessionId('other/session'), /cannot contain/i)
  assert.deepEqual(buildSessionCreationBody('main', ''), { agentId: 'main' })
  assert.deepEqual(buildSessionCreationBody('worker', ' custom '), { agentId: 'worker', sessionId: 'custom' })
  assert.equal(Object.hasOwn(buildSessionCreationBody('main', ''), 'sessionId'), false)
  assert.notEqual(buildSessionCreationBody('main', '').sessionId, RANDOM_SESSION_ID_PLACEHOLDER)
})

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
  assert.equal(normalized.tabsById['vscode-web'].title, 'Code')
})

test('Code workspace URLs preserve paths and reverse-proxy base paths', async () => {
  const { getVscodeWebPath, makeCodeWorkspaceUri, makeVscodeWebUrl, normalizeCodePath } = await loadTypeScriptModule('../src/vscodeWeb.ts')
  assert.equal(getVscodeWebPath('/api'), '/vscode-web/')
  assert.equal(getVscodeWebPath('/proxy-prefix/api'), '/proxy-prefix/vscode-web/')
  assert.equal(makeVscodeWebUrl('/proxy-prefix/api', 'https://example.test').toString(), 'https://example.test/proxy-prefix/vscode-web/')
  assert.equal(normalizeCodePath('/'), '/')
  assert.equal(normalizeCodePath('/work dir/你好'), '/work dir/你好')
  assert.equal(normalizeCodePath('relative/path'), null)
  assert.equal(makeCodeWorkspaceUri({ nodeId: 'master', path: '/work dir/你好' }), 'foxwarm://node+master/work%20dir/%E4%BD%A0%E5%A5%BD')

  const subpathUrl = makeVscodeWebUrl('/proxy-prefix/api', 'https://example.test', { nodeId: 'master', path: '/work dir/你好' })
  assert.equal(subpathUrl.pathname, '/proxy-prefix/vscode-web/')
  assert.equal(subpathUrl.searchParams.get('folderUri'), 'foxwarm://node+master/work%20dir/%E4%BD%A0%E5%A5%BD')
})

test('global Code launch preference defaults safely and controls sidebar launches', async () => {
  const { CODE_OPEN_NEW_WINDOW_STORAGE_KEY, CODE_WORKSPACE_PATH_STORAGE_KEY, parseCodeOpenInNewWindow, readCodeOpenInNewWindowPreference, readCodeWorkspacePathPreference, shouldOpenCodeInNewWindow, writeCodeOpenInNewWindowPreference, writeCodeWorkspacePathPreference } = await loadTypeScriptModule('../src/vscodeWeb.ts')
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.equal(parseCodeOpenInNewWindow(null), false)
  assert.equal(parseCodeOpenInNewWindow('false'), false)
  assert.equal(parseCodeOpenInNewWindow('garbage'), false)
  assert.equal(parseCodeOpenInNewWindow('true'), true)
  assert.equal(readCodeOpenInNewWindowPreference(storage), false)
  writeCodeOpenInNewWindowPreference(storage, true)
  assert.equal(values.get(CODE_OPEN_NEW_WINDOW_STORAGE_KEY), 'true')
  assert.equal(readCodeOpenInNewWindowPreference(storage), true)
  assert.equal(readCodeWorkspacePathPreference(storage), '/')
  assert.equal(writeCodeWorkspacePathPreference(storage, '/work dir/你好'), '/work dir/你好')
  assert.equal(values.get(CODE_WORKSPACE_PATH_STORAGE_KEY), '/work dir/你好')
  assert.equal(shouldOpenCodeInNewWindow(false), false)
  assert.equal(shouldOpenCodeInNewWindow(true), true)
})

test('session header Code target falls back safely and forced-new-tab overrides preference', async () => {
  const { resolveSessionCodeTarget, shouldOpenCodeInNewWindow } = await loadTypeScriptModule('../src/vscodeWeb.ts')
  assert.deepEqual(resolveSessionCodeTarget('master', '/app/project'), { nodeId: 'master', path: '/app/project' })
  assert.deepEqual(resolveSessionCodeTarget('worker', '/app/project'), { nodeId: 'master', path: '/' })
  assert.deepEqual(resolveSessionCodeTarget('master', 'relative'), { nodeId: 'master', path: '/' })
  assert.equal(shouldOpenCodeInNewWindow(false, true), true)
})

test('visible Code launch labels avoid the VS Code brand and terminal context hint is removed', async () => {
  const files = ['../src/App.tsx', '../src/components/Sidebar.tsx', '../src/components/SessionList.tsx', '../src/components/CodeLaunchButton.tsx', '../src/components/Chat.tsx', '../src/components/GlobalUiSettingsMenu.tsx', '../src/components/VscodeWebFrameHost.tsx']
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')))
  assert.equal(contents.some((content) => /VS Code/i.test(content)), false)
  const terminalButton = await readFile(new URL('../src/components/CreateTabButton.tsx', import.meta.url), 'utf8')
  assert.equal(terminalButton.includes('Default context:'), false)
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
