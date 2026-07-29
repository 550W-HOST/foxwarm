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
    clock,
    options,
    setVisibilityState: state => { visibilityState = state },
    hiddenDelayMs: SESSION_LIST_HIDDEN_REFRESH_DELAY_MS,
    visibleDelayMs: SESSION_LIST_VISIBLE_REFRESH_DELAY_MS,
  }
}

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
