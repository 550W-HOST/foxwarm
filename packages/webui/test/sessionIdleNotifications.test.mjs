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
    assert.equal(notifications.showSessionIdleNotification(session('task')), true)
    assert.deepEqual(calls.at(-1), {
      title: 'Session idle',
      options: { body: 'Session task' },
    })

    MockNotification.permission = 'denied'
    MockNotification.requestPermission = async () => 'denied'
    assert.equal(await notifications.requestSessionIdleNotificationPermission(), false)
    assert.equal(notifications.showSessionIdleNotification(session('task')), false)
  } finally {
    globalThis.Notification = previousNotification
  }
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
  assert.match(list, /BellRing size=\{14\} className="text-blue-600 dark:text-blue-300"/)
  assert.match(list, /Bell size=\{14\}/)
  assert.match(list, /checked: idleNotificationMode === 'once'/)
  assert.match(list, /trailingControl:/)
})
