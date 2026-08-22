import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

globalThis.window = {
  location: { pathname: '/', origin: 'http://localhost' },
  setTimeout,
  clearTimeout,
  addEventListener() {},
}

async function loadTransport() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/realtime.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

class FakeSocket {
  readyState = 0
  sent = []
  closes = []
  onopen = null
  onmessage = null
  onclose = null
  onerror = null

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  receive(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close(code, reason) {
    this.readyState = 3
    this.closes.push({ code, reason })
  }

  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
}

function fakeClock() {
  let nextId = 1
  const timers = new Map()
  return {
    setTimer(callback, delayMs) {
      const id = nextId++
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    runNext() {
      const next = [...timers.entries()][0]
      if (!next) return
      timers.delete(next[0])
      next[1].callback()
    },
    pendingCount() { return timers.size },
  }
}

test('one realtime transport multiplexes every page subscription onto one socket', async () => {
  const { WebUiRealtimeTransport } = await loadTransport()
  const sockets = []
  const clock = fakeClock()
  const transport = new WebUiRealtimeTransport({
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  })
  const listA = []
  const listB = []
  const sessionMessages = []
  const opens = []
  const statuses = []
  const unsubscribeListA = transport.subscribeSessionList(['main-list-alias'], { onMessage: message => listA.push(message), onOpen: () => opens.push('list-a') })
  const unsubscribeListB = transport.subscribeSessionList(['child/one'], { onMessage: message => listB.push(message), onOpen: () => opens.push('list-b') })
  const unsubscribeSession = transport.subscribeSession('main-alias', {
    onMessage: message => sessionMessages.push(message),
    onOpen: () => opens.push('session'),
    onStatus: status => statuses.push(status),
  })

  assert.equal(sockets.length, 1)
  assert.equal(transport.getUnderlyingConnectionCount(), 1)
  sockets[0].open()
  assert.deepEqual(sockets[0].sent, [{
    type: 'set-subscriptions',
    revision: 3,
    sessionListActive: true,
    sessionListIds: ['main-list-alias', 'child/one'],
    sessionIds: ['main-alias'],
  }])

  sockets[0].receive({ type: 'subscriptions-accepted', revision: 3, sessionListResolutions: { 'main-list-alias': 'agent/main', 'child/one': 'child/one' }, sessionResolutions: { 'main-alias': 'agent/main' } })
  sockets[0].receive({ type: 'session-state', sessionId: 'agent/main', session: { id: 'agent/main' } })
  sockets[0].receive({ type: 'session-list-delta', sessions: [{ id: 'agent/main' }], deletedIds: [] })
  sockets[0].receive({ type: 'subscriptions-applied', revision: 3 })
  assert.equal(sessionMessages.length, 1)
  assert.equal(listA.length, 1)
  assert.equal(listB.length, 0)
  sockets[0].receive({ type: 'session-list-delta', sessions: [{ id: 'child/one' }], deletedIds: [] })
  assert.equal(listA.length, 1)
  assert.equal(listB.length, 1)
  assert.deepEqual(opens, ['list-a', 'list-b', 'session'])
  assert.equal(statuses.at(-1), 'connected')

  unsubscribeListA()
  assert.equal(sockets.length, 1)
  assert.deepEqual(sockets[0].sent.at(-1), {
    type: 'set-subscriptions',
    revision: 4,
    sessionListActive: true,
    sessionListIds: ['child/one'],
    sessionIds: ['main-alias'],
  })
  sockets[0].receive({ type: 'message', sessionId: 'agent/main', message: { text: 'arrived before revision four was accepted' } })
  assert.equal(sessionMessages.length, 2, 'unrelated subscription churn preserves the last accepted alias mapping')

  const laterOpens = []
  const unsubscribeLaterSession = transport.subscribeSession('child/two', { onMessage() {}, onOpen: () => laterOpens.push('child/two') })
  assert.deepEqual(sockets[0].sent.at(-1), {
    type: 'set-subscriptions',
    revision: 5,
    sessionListActive: true,
    sessionListIds: ['child/one'],
    sessionIds: ['main-alias', 'child/two'],
  })
  sockets[0].receive({ type: 'subscriptions-accepted', revision: 5, sessionListResolutions: { 'child/one': 'child/one' }, sessionResolutions: { 'main-alias': 'agent/main', 'child/two': 'child/two' } })
  assert.deepEqual(laterOpens, ['child/two'])
  assert.deepEqual(opens, ['list-a', 'list-b', 'session'], 'existing consumers do not bootstrap again for an unrelated subscription')
  unsubscribeLaterSession()

  sockets[0].drop()
  assert.equal(clock.pendingCount(), 1)
  assert.equal(statuses.at(-1), 'reconnecting')
  clock.runNext()
  assert.equal(sockets.length, 2)
  sockets[1].open()
  assert.deepEqual(sockets[1].sent.at(-1), {
    type: 'set-subscriptions',
    revision: 6,
    sessionListActive: true,
    sessionListIds: ['child/one'],
    sessionIds: ['main-alias'],
  })

  unsubscribeListB()
  unsubscribeSession()
  assert.equal(transport.getUnderlyingConnectionCount(), 0)
  assert.equal(clock.pendingCount(), 0)
  assert.equal(sockets[1].closes.at(-1).reason, 'No realtime subscribers')
})

test('disposed transport fences stale socket callbacks and reconnect timers', async () => {
  const { WebUiRealtimeTransport } = await loadTransport()
  const sockets = []
  const clock = fakeClock()
  const transport = new WebUiRealtimeTransport({
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  })
  transport.subscribeSession('agent/main', { onMessage() {} })
  sockets[0].open()
  sockets[0].drop()
  assert.equal(clock.pendingCount(), 1)
  transport.dispose()
  assert.equal(clock.pendingCount(), 0)
  sockets[0].onclose?.({})
  assert.equal(clock.pendingCount(), 0)
  assert.equal(sockets.length, 1)
})

test('all current list and Chat surfaces use the shared transport instead of EventSource', async () => {
  const sources = await Promise.all([
    '../src/boundedSessionList.ts',
    '../src/components/ArchitectureView.tsx',
    '../src/components/Chat.tsx',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  assert.equal(sources.some(source => /new\s+EventSource|EventSource\s*\(/.test(source)), false)
  assert.match(sources[0], /webUiRealtime\.subscribeSessionList/)
  assert.match(sources[1], /webUiRealtime\.subscribeSessionList/)
  assert.match(sources[2], /webUiRealtime\.subscribeSession/)
})
