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
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const notifications = await loadTypeScriptModule('../src/sessionIdleNotifications.ts')
const attention = await loadTypeScriptModule('../src/sessionIdleAttention.ts')

function session(id, { busy = false, state, queueLength = 0 } = {}) {
  return {
    id,
    displayName: `Session ${id}`,
    busy,
    queueLength,
    ...(state ? { runtimeState: { state, queueLength, busy: state === 'requesting-model' || state === 'running-tool' } } : {}),
  }
}

test('idle notification tracker waits for an observed busy cycle before returning to idle', () => {
  const tracker = new notifications.SessionIdleNotificationTracker()
  const modes = { task: 'always' }

  tracker.arm(session('task', { state: 'idle' }))
  assert.deepEqual(tracker.observe([session('task', { state: 'idle' })], modes), [])
  assert.deepEqual(tracker.observe([session('task', { state: 'requesting-model' })], modes), [])
  assert.deepEqual(tracker.observe([session('task', { state: 'waiting' })], modes), [])
  assert.deepEqual(tracker.observe([session('task', { state: 'idle' })], modes).map(item => item.id), ['task'])
  assert.deepEqual(tracker.observe([session('task', { state: 'idle' })], modes), [])
})

test('idle notification tracker arms an already-busy session and uses legacy busy only without runtime state', () => {
  const tracker = new notifications.SessionIdleNotificationTracker()
  const modes = { active: 'once', legacy: 'always', waiting: 'always' }

  tracker.arm(session('active', { state: 'running-tool' }))
  assert.deepEqual(tracker.observe([session('active', { state: 'waiting' })], modes), [])
  assert.deepEqual(tracker.observe([session('active', { state: 'idle' })], modes).map(item => item.id), ['active'])

  tracker.arm(session('legacy', { busy: true }))
  assert.deepEqual(tracker.observe([session('legacy')], modes).map(item => item.id), ['legacy'])

  tracker.arm(session('waiting', { busy: true, state: 'waiting' }))
  assert.deepEqual(tracker.observe([session('waiting', { state: 'idle' })], modes), [])
})

test('queue-only canonical idle state never arms or fires an idle notification', () => {
  const tracker = new notifications.SessionIdleNotificationTracker()
  const modes = { queued: 'always' }

  tracker.arm(session('queued', { state: 'idle', queueLength: 2 }))
  assert.deepEqual(tracker.observe([session('queued', { state: 'idle', queueLength: 2 })], modes), [])
  assert.deepEqual(tracker.observe([session('queued', { state: 'idle' })], modes), [])
})

test('idle notification tracker seeds a first accepted snapshot without a notification', () => {
  const tracker = new notifications.SessionIdleNotificationTracker()
  const modes = { task: 'always' }

  assert.deepEqual(tracker.observe([session('task', { state: 'running-tool' })], modes), [])
  assert.deepEqual(tracker.observe([session('task', { state: 'idle' })], modes).map(item => item.id), ['task'])
})

test('session idle notification preferences accept only known modes and remove empty storage', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }

  values.set(notifications.SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify({ one: 'once', always: 'always', no: 'never', empty: '' }))
  assert.deepEqual(notifications.readSessionIdleNotificationModes(storage), { one: 'once', always: 'always' })
  notifications.writeSessionIdleNotificationModes(storage, { one: 'once' })
  assert.deepEqual(JSON.parse(values.get(notifications.SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY)), { one: 'once' })
  notifications.writeSessionIdleNotificationModes(storage, {})
  assert.equal(values.has(notifications.SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY), false)
})

test('unread attention storage is versioned, fail-closed, newest-bounded, and merge-updated', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  values.set(attention.SESSION_IDLE_UNREAD_STORAGE_KEY, JSON.stringify({ version: 2, unread: { bad: 1 } }))
  assert.deepEqual(attention.readSessionIdleUnread(storage), {})
  values.set(attention.SESSION_IDLE_UNREAD_STORAGE_KEY, JSON.stringify({ version: 1, unread: { good: 4, negative: -1, text: '5', '': 8 } }))
  assert.deepEqual(attention.readSessionIdleUnread(storage), { good: 4 })
  values.set(attention.SESSION_IDLE_UNREAD_STORAGE_KEY, JSON.stringify({ version: 1, unread: { ' padded ': 5, canonical: 6 } }))
  assert.deepEqual(attention.readSessionIdleUnread(storage), { canonical: 6 })
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`session/${index}`, index]))
  attention.writeSessionIdleUnread(storage, many)
  const bounded = attention.readSessionIdleUnread(storage)
  assert.equal(Object.keys(bounded).length, 256)
  assert.equal(bounded['session/299'], 299)
  assert.equal(bounded['session/0'], undefined)
  attention.updateStoredSessionIdleUnread(storage, current => ({ ...current, newest: 1000 }))
  assert.equal(attention.readSessionIdleUnread(storage).newest, 1000)
})

test('normal workbench visibility includes every active split Chat but excludes the mobile list-covered surface', () => {
  assert.deepEqual(attention.selectVisibleSessionIds(['agent/a', null, 'agent/b', 'agent/a'], true), ['agent/a', 'agent/b'])
  assert.deepEqual(attention.selectVisibleSessionIds(['agent/a', 'agent/b'], false), [])
  assert.equal(attention.shouldMarkSessionIdleUnread('agent/a', new Set(['agent/a']), 'visible'), false)
  assert.equal(attention.shouldMarkSessionIdleUnread('agent/a', new Set(['agent/a']), 'hidden'), true)
  assert.equal(attention.shouldMarkSessionIdleUnread('agent/a', new Set(['agent/b']), 'visible'), true)
})

test('ordinary App navigation acknowledges eagerly while notification navigation waits for actual visibility', () => {
  assert.equal(attention.shouldAcknowledgeSessionNavigation('user'), true)
  assert.equal(attention.shouldAcknowledgeSessionNavigation('notification'), false)
})

test('unread storage failures fail closed without preventing the in-memory normalized result', () => {
  const storage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('full') },
    removeItem() { throw new Error('blocked') },
  }
  assert.deepEqual(attention.readSessionIdleUnread(storage), {})
  assert.deepEqual(attention.writeSessionIdleUnread(storage, { task: 12 }), { task: 12 })
})

test('bounded session list retains both idle watches and once-disabled unread exact ids', async () => {
  const source = await readFile(new URL('../src/boundedSessionList.ts', import.meta.url), 'utf8')
  assert.match(source, /getSessionIdleUnreadIds/)
  assert.match(source, /currentAttentionIds/)
  assert.match(source, /SESSION_IDLE_UNREAD_EVENT/)
  assert.match(source, /webUiRealtime\.subscribeSessionList\(subscriptionIds/)
  assert.match(source, /dispatchSessionIdleDeleted\(deletedIds\)/)
  assert.match(source, /dispatchSessionIdleDeleted\(missing\)/)
  assert.match(source, /\.\.\.unreadIds/)
  const hook = await readFile(new URL('../src/sessionIdleNotifications.ts', import.meta.url), 'utf8')
  assert.match(hook, /shouldMarkSessionIdleUnread/)
  assert.match(hook, /const notification = showSessionIdleNotification\(session\)/)
  assert.match(hook, /notificationRegistryRef\.current\?\.retain\(session\.id, notification/)
  assert.match(hook, /notification && modesRef\.current\[session\.id\] === 'once'/)
  assert.match(hook, /notificationRegistryRef\.current\?\.closeSession\(canonicalId\)/)
  assert.match(hook, /notificationRegistryRef\.current\?\.closeSessions\(deleted\)/)
  assert.match(hook, /notificationRegistryRef\.current\?\.closeMissingUnread/)
})

test('browser notification permission and delivery require granted permission', async () => {
  const previousNotification = globalThis.Notification
  const calls = []
  class MockNotification {
    static permission = 'default'
    static async requestPermission() {
      calls.push('request')
      MockNotification.permission = 'granted'
      return 'granted'
    }
    constructor(title, options) {
      calls.push({ title, options })
    }
  }

  try {
    globalThis.Notification = MockNotification
    assert.equal(await notifications.requestSessionIdleNotificationPermission(), true)
    assert.deepEqual(calls, ['request'])
    assert.ok(notifications.showSessionIdleNotification(session('task')) instanceof MockNotification)
    assert.deepEqual(calls.at(-1), {
      title: 'Session idle',
      options: { body: 'Session task' },
    })

    MockNotification.permission = 'denied'
    MockNotification.requestPermission = async () => 'denied'
    assert.equal(await notifications.requestSessionIdleNotificationPermission(), false)
    assert.equal(notifications.showSessionIdleNotification(session('task')), null)
  } finally {
    globalThis.Notification = previousNotification
  }
})

function notificationHandle({ closeThrows = false } = {}) {
  return {
    onclick: null,
    onclose: null,
    closeCalls: 0,
    close() {
      this.closeCalls += 1
      if (closeThrows) throw new Error('close failed')
    },
  }
}

test('page notification registry retains multiple handles and closes only the acknowledged session', () => {
  const registry = new notifications.SessionIdleNotificationRegistry(() => {})
  const first = notificationHandle()
  const second = notificationHandle({ closeThrows: true })
  const other = notificationHandle()
  registry.retain('agent/task', first, () => {})
  registry.retain('agent/task', second, () => {})
  registry.retain('agent/other', other, () => {})

  assert.equal(registry.count('agent/task'), 2)
  registry.closeSession('agent/task')
  assert.equal(first.closeCalls, 1)
  assert.equal(second.closeCalls, 1)
  assert.equal(registry.count('agent/task'), 0)
  assert.equal(registry.count('agent/other'), 1)
})

test('OS close removes only that page notification handle', () => {
  const registry = new notifications.SessionIdleNotificationRegistry(() => {})
  const first = notificationHandle()
  const second = notificationHandle()
  registry.retain('agent/task', first, () => {})
  registry.retain('agent/task', second, () => {})

  first.onclose(new Event('close'))
  assert.equal(registry.count('agent/task'), 1)
  registry.closeSession('agent/task')
  assert.equal(first.closeCalls, 0)
  assert.equal(second.closeCalls, 1)
})

test('notification click closes/removes, focuses, and opens the exact canonical session', async () => {
  const calls = []
  const registry = new notifications.SessionIdleNotificationRegistry(() => calls.push('focus'))
  const handle = notificationHandle()
  registry.retain('agent/task', handle, sessionId => calls.push(['open', sessionId]))

  handle.onclick(new Event('click'))
  await Promise.resolve()
  assert.equal(handle.closeCalls, 1)
  assert.equal(registry.count(), 0)
  assert.deepEqual(calls, ['focus', ['open', 'agent/task']])
})

test('notification callback failure leaves the registry consistent and storage removal closes live handles', async () => {
  const registry = new notifications.SessionIdleNotificationRegistry(() => { throw new Error('focus failed') })
  const clicked = notificationHandle()
  registry.retain('agent/task', clicked, async () => { throw new Error('open failed') })
  clicked.onclick(new Event('click'))
  await Promise.resolve()
  assert.equal(registry.count(), 0)

  const retained = notificationHandle()
  const unread = notificationHandle()
  registry.retain('agent/cleared', retained, () => {})
  registry.retain('agent/unread', unread, () => {})
  registry.closeMissingUnread(new Set(['agent/unread']))
  assert.equal(retained.closeCalls, 1)
  assert.equal(unread.closeCalls, 0)
  assert.equal(registry.count(), 1)
})

test('App and Code sidebar notification clicks use their existing canonical Chat open paths', async () => {
  const [app, embedded] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/EmbeddedWebUiApp.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(app, /onOpenSession: \(sessionId\) => notificationOpenSessionRef\.current\?\.\(sessionId\)/)
  assert.match(app, /notificationOpenSessionRef\.current = \(sessionId\) => openChatTab\(sessionId, 'notification'\)/)
  assert.match(app, /navigateToTab = \(tabId: string, origin: SessionNavigationOrigin = 'user'\)/)
  assert.match(app, /shouldAcknowledgeSessionNavigation\(origin\)/)
  assert.match(embedded, /onOpenSession: \(sessionId\) => notificationOpenSessionRef\.current\?\.\(sessionId\)/)
  assert.match(embedded, /notificationOpenSessionRef\.current = openSession/)
  assert.match(embedded, /postFoxwarmEmbedHostMessage\(target\.nonce, \{ type: 'open-session', sessionId/)
})

test('session context menu exposes an accessible once item with a trailing always checkbox', async () => {
  const [menu, list] = await Promise.all([
    readFile(new URL('../src/components/ContextMenu.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SessionListCore.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(menu, /role="menuitemcheckbox"/)
  assert.match(menu, /aria-checked=\{control\.checked\}/)
  assert.match(menu, /min-w-\[220px\]/)
  assert.match(menu, /trailingControl/)
  assert.match(menu, /event\.stopPropagation\(\)/)
  assert.match(menu, /data-context-menu-split-row="true"/)
  assert.match(menu, /foxwarm-context-menu-split-row/)
  assert.doesNotMatch(menu, /entry\.trailingControl \? itemClass/)
  assert.match(menu, /mr-3 inline-flex shrink-0 items-center gap-1 text-sm/)
  assert.match(menu, /h-3 w-3 items-center justify-center rounded-\[1px\] border-2/)
  assert.match(list, /label: 'Notify on idle'/)
  assert.match(list, /BellRing size=\{14\} className="text-fw-accent dark:text-fw-accent"/)
  assert.match(list, /Bell size=\{14\}/)
  assert.match(list, /checked: idleNotificationMode === 'once'/)
  assert.match(list, /trailingControl:/)
  assert.match(list, /Unread idle completion/)
  assert.match(list, /result\.deletedSessionIds/)
  const collapsed = await readFile(new URL('../src/components/CollapsedSidebar.tsx', import.meta.url), 'utf8')
  assert.match(collapsed, /-top-0\.5 -right-0\.5/)
  assert.match(collapsed, /-bottom-0\.5 -right-0\.5/)
  assert.match(collapsed, /Unread idle completion/)
})
