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

test('bounded tree rows use exact item counts before loading arbitrary-depth branches', async () => {
  const { collapseSessionListExpandedBranch, getSessionListAutoExpandedPath, getSessionListChildDisclosure } = await loadTypeScriptModule('../src/sessionListPresentation.ts')

  assert.deepEqual(getSessionListChildDisclosure({ bounded: true, loadedCount: 0, itemTotal: 1, allowTree: true }), {
    total: 1,
    canExpand: true,
  }, 'a newly loaded child exposes its exact count before its own child window is requested')
  assert.deepEqual(getSessionListChildDisclosure({ bounded: true, loadedCount: 1, boundedTotal: 1, itemTotal: 9, allowTree: true }), {
    total: 1,
    canExpand: true,
  }, 'an exact loaded child page takes precedence over the item projection')
  assert.deepEqual(getSessionListChildDisclosure({ bounded: true, loadedCount: 0, itemTotal: 0, allowTree: true }), {
    total: 0,
    canExpand: false,
  }, 'a true leaf never shows a disclosure')
  assert.deepEqual(getSessionListChildDisclosure({ bounded: true, loadedCount: 0, itemTotal: 2, allowTree: false }), {
    total: 2,
    canExpand: false,
  }, 'flat and search presentations carry counts without probing hidden tree branches')

  const collapsed = collapseSessionListExpandedBranch(
    new Set(['root', 'child', 'grandchild', 'unrelated', 'unrelated-child']),
    new Map([
      ['root', [{ id: 'child' }]],
      ['child', [{ id: 'grandchild' }]],
      ['unrelated', [{ id: 'unrelated-child' }]],
    ]),
    'root',
  )
  assert.deepEqual(collapsed, new Set(['unrelated', 'unrelated-child']),
    'collapsing an ancestor clears only its loaded descendant expansion state')
  collapsed.add('root')
  assert.equal(collapsed.has('child'), false, 're-expanding the ancestor leaves its child disclosure collapsed')
  collapsed.add('child')
  assert.equal(collapsed.has('child'), true, 'one explicit child expansion can reload the grandchild window')

  const activePath = ['root', 'child', 'grandchild']
  assert.deepEqual(
    getSessionListAutoExpandedPath(activePath, new Set(['child']), false),
    ['root'],
    'same-active refreshes stop before the first manually collapsed path member and never restore its hidden descendants',
  )
  assert.deepEqual(
    getSessionListAutoExpandedPath(activePath, new Set(['unrelated']), false),
    activePath,
    'manual collapses outside the active path do not affect its automatic disclosure',
  )
  assert.deepEqual(
    getSessionListAutoExpandedPath(activePath, new Set(['root', 'child']), true),
    activePath,
    'changing the current session reveals its complete new active path',
  )
})

test('Architecture focus disclosure reveals strict ancestors once without forcing open the current row', async () => {
  const { getArchitectureFocusReveal } = await loadTypeScriptModule('../src/architecturePresentation.ts')

  const rootFocus = getArchitectureFocusReveal(['root'], 'root')
  assert.deepEqual(rootFocus.ancestors, [], 'an already visible root does not open its own children')

  const nestedFocus = getArchitectureFocusReveal(['root', 'parent', 'current'], 'current')
  assert.deepEqual(nestedFocus.ancestors, ['root', 'parent'], 'only strict ancestors reveal a nested current row')
  assert.equal(
    getArchitectureFocusReveal(['root', 'parent', 'current'], 'current', nestedFocus.identity),
    null,
    'replaying the same focus path cannot override a later manual collapse',
  )
  assert.equal(
    getArchitectureFocusReveal(['root', 'parent', 'current'], 'other'),
    null,
    'a stale focus response cannot disclose a different current session',
  )
  assert.notEqual(
    nestedFocus.identity,
    getArchitectureFocusReveal(['new-root', 'current'], 'current').identity,
    'a canonical reparenting changes the one-shot reveal identity',
  )
})

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

test('workbench normalization persists Agents and Setup tabs', async () => {
  const { normalizePersistedWorkbenchState } = await loadTypeScriptModule('../src/workbench/utils.ts')
  const normalized = normalizePersistedWorkbenchState({
    version: 4,
    tabsById: {
      'system:agents': { id: 'system:agents', type: 'agents', title: 'Agents' },
      'system:setup': { id: 'system:setup', type: 'setup', title: 'Setup' },
    },
    root: {
      id: 'pane-system',
      kind: 'pane',
      tabIds: ['system:agents', 'system:setup'],
      activeTabId: 'system:setup',
    },
    focusedPaneId: 'pane-system',
  })

  assert.deepEqual(normalized.root.tabIds, ['system:agents', 'system:setup'])
  assert.equal(normalized.root.activeTabId, 'system:setup')
  assert.equal(normalized.tabsById['system:agents'].type, 'agents')
  assert.equal(normalized.tabsById['system:setup'].type, 'setup')
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
  const { CODE_OPEN_NEW_WINDOW_STORAGE_KEY, CODE_WORKSPACE_NODE_STORAGE_KEY, CODE_WORKSPACE_PATH_STORAGE_KEY, parseCodeOpenInNewWindow, readCodeOpenInNewWindowPreference, readCodeWorkspaceNodePreference, readCodeWorkspacePathPreference, shouldOpenCodeInNewWindow, writeCodeOpenInNewWindowPreference, writeCodeWorkspaceNodePreference, writeCodeWorkspacePathPreference } = await loadTypeScriptModule('../src/vscodeWeb.ts')
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
  assert.equal(readCodeWorkspaceNodePreference(storage), 'master')
  assert.equal(writeCodeWorkspaceNodePreference(storage, 'worker-a'), 'worker-a')
  assert.equal(values.get(CODE_WORKSPACE_NODE_STORAGE_KEY), 'worker-a')
  assert.equal(readCodeWorkspaceNodePreference(storage), 'worker-a')
  assert.equal(writeCodeWorkspacePathPreference(storage, '/work dir/你好'), '/work dir/你好')
  assert.equal(values.get(CODE_WORKSPACE_PATH_STORAGE_KEY), '/work dir/你好')
  assert.equal(shouldOpenCodeInNewWindow(false), false)
  assert.equal(shouldOpenCodeInNewWindow(true), true)
})

test('node launch targets preserve stale selection and apply service-specific availability', async () => {
  const { formatNodeTargetLabel, getNodeTargetAvailability, parseWebUiNodeTargets, preserveSelectedNodeTarget } = await loadTypeScriptModule('../src/nodeTargets.ts')
  const nodes = parseWebUiNodeTargets({ nodes: [
    { id: 'master', type: 'master', online: true, services: {} },
    { id: 'full', type: 'cli-node', online: true, services: { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1 } },
    { id: 'fs-only', type: 'cli-node', online: true, services: { 'vscode-fs': 1 } },
    { id: 'offline', type: 'cli-node', online: false, services: { 'vscode-fs': 1, 'vscode-pty': 1 } },
  ] })
  assert.equal(getNodeTargetAvailability(nodes.find(node => node.id === 'master'), 'vscode-pty').available, true)
  assert.equal(getNodeTargetAvailability(nodes.find(node => node.id === 'full'), 'vscode-pty').available, true)
  assert.equal(getNodeTargetAvailability(nodes.find(node => node.id === 'fs-only'), 'vscode-fs').available, true, 'Git is optional for Code')
  assert.deepEqual(getNodeTargetAvailability(nodes.find(node => node.id === 'fs-only'), 'vscode-pty'), { available: false, reason: 'terminal unavailable' })
  assert.deepEqual(getNodeTargetAvailability(nodes.find(node => node.id === 'offline'), 'vscode-fs'), { available: false, reason: 'offline' })
  assert.match(formatNodeTargetLabel(nodes.find(node => node.id === 'full'), 'vscode-pty'), /online/)
  assert.match(formatNodeTargetLabel(nodes.find(node => node.id === 'offline'), 'vscode-fs'), /offline/)
  assert.match(formatNodeTargetLabel(nodes.find(node => node.id === 'fs-only'), 'vscode-fs'), /online · no Git/)

  const withStale = preserveSelectedNodeTarget(nodes, 'removed-node')
  const stale = withStale.find(node => node.id === 'removed-node')
  assert.ok(stale)
  assert.equal(stale.unavailable, true)
  assert.deepEqual(getNodeTargetAvailability(stale, 'vscode-fs'), { available: false, reason: 'unavailable' })
  assert.equal(withStale.some(node => node.id === 'master'), true)
})

test('terminal targets normalize cwd and never reuse a different node at the same path', async () => {
  const { buildTerminalCreateRequest, findTerminalForTarget, normalizeTerminalTarget, terminalTargetsMatch } = await loadTypeScriptModule('../src/terminalTarget.ts')
  assert.deepEqual(normalizeTerminalTarget({ nodeId: 'worker-a', cwd: '/srv/project/' }), { nodeId: 'worker-a', cwd: '/srv/project' })
  assert.equal(terminalTargetsMatch({ nodeId: 'master', cwd: '/srv/project' }, { nodeId: 'worker-a', cwd: '/srv/project/' }), false)
  const terminals = [
    { id: 'local', nodeId: 'master', cwd: '/srv/project' },
    { id: 'remote', nodeId: 'worker-a', cwd: '/srv/project' },
  ]
  assert.equal(findTerminalForTarget(terminals, { nodeId: 'worker-a', cwd: '/srv/project/' })?.id, 'remote')
  assert.equal(findTerminalForTarget(terminals, { nodeId: 'worker-b', cwd: '/srv/project' }), undefined)
  assert.deepEqual(buildTerminalCreateRequest({ nodeId: 'worker-a', cwd: '/srv/project/' }, 120, 40), {
    nodeId: 'worker-a', cwd: '/srv/project', cols: 120, rows: 40,
  })
})

test('session-header terminal orchestration keeps the session node and replaces a mismatched lower-pane target', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /onOpenTerminal=\{\(\) => openTerminalTab\(\{ nodeId: sessionRecord\?\.currentNode \|\| 'master', path: sessionRecord\?\.cwd \|\| '\/', sourcePaneId \}\)\}/)
  const openTerminalStart = app.indexOf('const openTerminalTab')
  const openTerminalEnd = app.indexOf('const closeWorkbenchTab', openTerminalStart)
  const block = app.slice(openTerminalStart, openTerminalEnd)
  assert.match(block, /getTerminalTabInPane\(paneBelow\.id, \{ nodeId, path \}\)/)
  assert.match(block, /upsertTab\(draftTab, \{ paneId: paneBelow\.id, activate: true \}\)/)
})

test('session header Code target preserves valid remote nodes, falls back safely, and honors forced-new-tab', async () => {
  const { resolveSessionCodeTarget, shouldOpenCodeInNewWindow } = await loadTypeScriptModule('../src/vscodeWeb.ts')
  assert.deepEqual(resolveSessionCodeTarget('master', '/app/project'), { nodeId: 'master', path: '/app/project' })
  assert.deepEqual(resolveSessionCodeTarget('worker', '/app/project'), { nodeId: 'worker', path: '/app/project' })
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

test('session list labels omit parent and agent-main prefixes for child rows', async () => {
  const { getSessionListDisplayId } = await loadTypeScriptModule('../src/sessionListPresentation.ts')

  assert.equal(getSessionListDisplayId('agent/main/task', 'agent/main'), '/task')
  assert.equal(getSessionListDisplayId('agent/task', 'agent/main'), '/task')
  assert.equal(getSessionListDisplayId('agent/task', 'agent/main', false), 'agent/task')
  assert.equal(getSessionListDisplayId('other/task', 'agent/main'), 'other/task')
  assert.equal(getSessionListDisplayId('agent/task', 'agent/parent'), 'agent/task')
  assert.equal(getSessionListDisplayId('standalone', null), 'standalone')
})

test('overlapping global session refreshes cannot let an older response hide a new child', async () => {
  const {
    applyLatestSessionListRequest,
    createLatestSessionListRequestGate,
  } = await loadTypeScriptModule('../src/sessionListRefresh.ts')

  const gate = createLatestSessionListRequestGate()
  const applied = []
  let resolveOlder
  let resolveNewer
  const olderResponse = new Promise(resolve => { resolveOlder = resolve })
  const newerResponse = new Promise(resolve => { resolveNewer = resolve })

  const olderRefresh = applyLatestSessionListRequest(gate, () => olderResponse, sessions => applied.push(sessions))
  const newerRefresh = applyLatestSessionListRequest(gate, () => newerResponse, sessions => applied.push(sessions))

  resolveNewer([{ id: 'parent' }, { id: 'parent_child', parentSessionId: 'parent' }])
  await newerRefresh
  resolveOlder([{ id: 'parent' }])
  await olderRefresh

  assert.deepEqual(applied, [[{ id: 'parent' }, { id: 'parent_child', parentSessionId: 'parent' }]])
})

function createFakeRefreshClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()

  return {
    setTimer(callback, delayMs) {
      const id = nextId++
      timers.set(id, { callback, deadline: now + delayMs })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    advanceBy(durationMs) {
      const target = now + durationMs
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.deadline <= target)
          .sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.deadline
        timer.callback()
      }
      now = target
    },
    pendingCount() {
      return timers.size
    },
    nextDeadline() {
      return [...timers.values()].map(timer => timer.deadline).sort((a, b) => a - b)[0]
    },
    now() {
      return now
    },
  }
}

async function flushRefreshPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function loadRefreshScheduler() {
  const {
    createSessionListRefreshScheduler,
    getSessionListRefreshDelayMs,
    requestSessionListStreamOpenResync,
    SESSION_LIST_HIDDEN_REFRESH_DELAY_MS,
    SESSION_LIST_VISIBLE_REFRESH_DELAY_MS,
  } = await loadTypeScriptModule('../src/sessionListRefresh.ts')
  const clock = createFakeRefreshClock()
  let visibilityState = 'visible'
  const options = {
    getDelayMs: () => getSessionListRefreshDelayMs(visibilityState),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }
  return {
    createSessionListRefreshScheduler,
    requestSessionListStreamOpenResync,
    clock,
    options,
    setVisibilityState: state => { visibilityState = state },
    hiddenDelayMs: SESSION_LIST_HIDDEN_REFRESH_DELAY_MS,
    visibleDelayMs: SESSION_LIST_VISIBLE_REFRESH_DELAY_MS,
  }
}

test('Session-list sibling stream opens coalesce into one bounded post-open resync', async () => {
  const { createSessionListRefreshScheduler, requestSessionListStreamOpenResync, clock, options, visibleDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0; const scheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)
  requestSessionListStreamOpenResync(scheduler); requestSessionListStreamOpenResync(scheduler); requestSessionListStreamOpenResync(scheduler)
  assert.equal(clock.pendingCount(), 1)
  clock.advanceBy(visibleDelayMs); await flushRefreshPromises(); assert.equal(refreshCount, 1)
  assert.equal(clock.pendingCount(), 0, 'stable watched IDs do not create a refresh loop after the resync')
})

test('Session-list stream reconnect schedules a later bounded resync', async () => {
  const { createSessionListRefreshScheduler, requestSessionListStreamOpenResync, clock, options, visibleDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0; const scheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)
  requestSessionListStreamOpenResync(scheduler); clock.advanceBy(visibleDelayMs); await flushRefreshPromises(); assert.equal(refreshCount, 1)
  requestSessionListStreamOpenResync(scheduler); assert.equal(clock.pendingCount(), 1)
  clock.advanceBy(visibleDelayMs); await flushRefreshPromises(); assert.equal(refreshCount, 2)
})

test('global refresh scheduler uses a fixed 1s visible deadline across later intents and visibility changes', async () => {
  const { createSessionListRefreshScheduler, clock, options, setVisibilityState, visibleDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0
  const scheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)

  scheduler.requestRefresh()
  assert.equal(visibleDelayMs, 1_000)
  assert.equal(clock.nextDeadline(), visibleDelayMs)
  clock.advanceBy(500)
  setVisibilityState('hidden')
  scheduler.requestRefresh()
  assert.equal(clock.nextDeadline(), visibleDelayMs)
  clock.advanceBy(499)
  assert.equal(refreshCount, 0)
  clock.advanceBy(1)
  await flushRefreshPromises()
  assert.equal(refreshCount, 1)
})

test('global refresh scheduler uses a fixed 10s hidden deadline', async () => {
  const { createSessionListRefreshScheduler, clock, options, setVisibilityState, hiddenDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0
  const scheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)

  setVisibilityState('hidden')
  scheduler.requestRefresh()
  assert.equal(hiddenDelayMs, 10_000)
  assert.equal(clock.nextDeadline(), hiddenDelayMs)
  clock.advanceBy(hiddenDelayMs - 1)
  assert.equal(refreshCount, 0)
  clock.advanceBy(1)
  await flushRefreshPromises()
  assert.equal(refreshCount, 1)
})

test('global refresh scheduler coalesces all pre-start intents', async () => {
  const { createSessionListRefreshScheduler, clock, options, visibleDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0
  const scheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)

  scheduler.requestRefresh()
  scheduler.requestRefresh()
  scheduler.requestRefresh()
  assert.equal(clock.pendingCount(), 1)
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  assert.equal(refreshCount, 1)
})

test('global refresh scheduler re-evaluates visibility when it arms one trailing refresh', async () => {
  const { createSessionListRefreshScheduler, clock, options, setVisibilityState, hiddenDelayMs, visibleDelayMs } = await loadRefreshScheduler()
  let resolveFirst
  const firstRefresh = new Promise(resolve => { resolveFirst = resolve })
  let refreshCount = 0
  const scheduler = createSessionListRefreshScheduler(async () => {
    refreshCount++
    if (refreshCount === 1) await firstRefresh
  }, options)

  scheduler.requestRefresh()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  assert.equal(refreshCount, 1)
  scheduler.requestRefresh()
  scheduler.requestRefresh()
  assert.equal(clock.pendingCount(), 0)

  setVisibilityState('hidden')
  resolveFirst()
  await flushRefreshPromises()
  assert.equal(clock.nextDeadline(), clock.now() + hiddenDelayMs)
  clock.advanceBy(hiddenDelayMs - 1)
  setVisibilityState('visible')
  scheduler.requestRefresh()
  assert.equal(clock.nextDeadline(), clock.now() + 1)
  clock.advanceBy(1)
  await flushRefreshPromises()
  assert.equal(refreshCount, 2)
})

test('global refresh scheduler never overlaps refreshes', async () => {
  const { createSessionListRefreshScheduler, clock, options, visibleDelayMs } = await loadRefreshScheduler()
  const pending = []
  let active = 0
  let maximumActive = 0
  let refreshCount = 0
  const scheduler = createSessionListRefreshScheduler(async () => {
    refreshCount++
    active++
    maximumActive = Math.max(maximumActive, active)
    let resolve
    const promise = new Promise(done => { resolve = done })
    pending.push(() => {
      active--
      resolve()
    })
    await promise
  }, options)

  scheduler.requestRefresh()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  scheduler.requestRefresh()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  assert.equal(refreshCount, 1)

  pending.shift()()
  await flushRefreshPromises()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  assert.equal(refreshCount, 2)
  assert.equal(maximumActive, 1)
  pending.shift()()
  await flushRefreshPromises()
})

test('global refresh scheduler dispose cancels pending and trailing work', async () => {
  const { createSessionListRefreshScheduler, clock, options, visibleDelayMs } = await loadRefreshScheduler()
  let refreshCount = 0
  const pendingScheduler = createSessionListRefreshScheduler(async () => { refreshCount++ }, options)
  pendingScheduler.requestRefresh()
  pendingScheduler.dispose()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  assert.equal(refreshCount, 0)

  let resolveRefresh
  const inFlightRefresh = new Promise(resolve => { resolveRefresh = resolve })
  const inFlightScheduler = createSessionListRefreshScheduler(async () => {
    refreshCount++
    await inFlightRefresh
  }, options)
  inFlightScheduler.requestRefresh()
  clock.advanceBy(visibleDelayMs)
  await flushRefreshPromises()
  inFlightScheduler.requestRefresh()
  inFlightScheduler.dispose()
  resolveRefresh()
  await flushRefreshPromises()
  clock.advanceBy(visibleDelayMs)
  inFlightScheduler.requestRefresh()
  assert.equal(refreshCount, 1)
  assert.equal(clock.pendingCount(), 0)
})
