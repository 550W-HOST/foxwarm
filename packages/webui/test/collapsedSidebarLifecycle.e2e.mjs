import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const packageDir = fileURLToPath(new URL('..', import.meta.url))

async function buildFixture() {
  const source = `
    import React, { useEffect, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import CollapsedSidebarContainer from './src/components/CollapsedSidebarContainer'
    import { useBoundedSessionList } from './src/boundedSessionList'
    import { webUiRealtime } from './src/realtime'

    function AsyncLaneOwner({ currentSession }) {
      const controller = useBoundedSessionList({ focusIds: [currentSession], includeGlobalSummary: true, connectStream: false })
      window.foxwarmAsyncLaneController = controller
      return React.createElement('div', { 'data-async-lane-owner': '', 'data-session-count': controller.sessions.length })
    }

    function Harness() {
      const [surface, setSurface] = useState('expanded-desktop')
      const [currentSession, setCurrentSession] = useState('agent/main')
      useEffect(() => webUiRealtime.subscribeSession('fixture/main-controller', { onMessage() {} }), [])
      window.foxwarmCollapsedLifecycle = { setSurface, setCurrentSession }
      if (surface === 'collapsed-desktop') return React.createElement(CollapsedSidebarContainer, {
            currentSession,
            onSelectSession() {},
            onCreateSession() {},
            onToggleCollapsed() {},
            unreadSessionIds: new Set(),
          })
      if (surface === 'async-lanes') return React.createElement(React.StrictMode, null, React.createElement(AsyncLaneOwner, { currentSession }))
      if (surface === 'refresh-overlap') return React.createElement(AsyncLaneOwner, { currentSession })
      return React.createElement('div', { 'data-surface': surface })
    }

    createRoot(document.getElementById('root')).render(React.createElement(Harness))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: 'collapsed-sidebar-lifecycle-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

test('collapsed Session-list controller follows the desktop rail mount and physical socket lifecycle', async () => {
  const browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  const script = await buildFixture()
  try {
    await page.setRequestInterception(true)
    page.on('request', request => {
      if (request.isNavigationRequest() && request.url() === 'http://foxwarm.test/') {
        void request.respond({ status: 200, contentType: 'text/html', body: '<div id="root"></div>' })
        return
      }
      void request.continue()
    })
    await page.goto('http://foxwarm.test/')
    await page.evaluate(() => {
      window.__requests = []
      window.__sockets = []
      window.__listenerAdds = {}
      window.__listenerRemoves = {}
      window.__deferAsyncLanes = false
      window.__laneRequests = {}
      window.__settleLane = (lane, index, outcome) => {
        const request = window.__laneRequests[lane]?.[index]
        if (!request || request.settled) throw new Error(`Missing unsettled ${lane}[${index}]`)
        request.settled = true
        if (outcome === 'reject') { request.reject(new Error(`rejected ${lane}[${index}]`)); return }
        const payload = lane === 'root'
          ? { version: 1, revision: 'r1', sessions: [{ id: 'agent/main', aliases: [], archived: false, parentSessionId: null, childTotal: 0, busy: false }], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} }
          : lane === 'exact'
            ? { results: [] }
            : lane === 'summary'
              ? { summary: { total: 1, busy: 0 } }
              : lane === 'badge'
                ? { results: [] }
                : { sessions: [] }
        request.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      const nativeAdd = window.addEventListener.bind(window)
      const nativeRemove = window.removeEventListener.bind(window)
      window.addEventListener = (type, listener, options) => {
        window.__listenerAdds[type] = (window.__listenerAdds[type] || 0) + 1
        return nativeAdd(type, listener, options)
      }
      window.removeEventListener = (type, listener, options) => {
        window.__listenerRemoves[type] = (window.__listenerRemoves[type] || 0) + 1
        return nativeRemove(type, listener, options)
      }
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href)
        window.__requests.push({ path: url.pathname, search: url.search, method: (init?.method || 'GET').toUpperCase() })
        const deferLane = lane => new Promise((resolve, reject) => {
          ;(window.__laneRequests[lane] ||= []).push({ resolve, reject, settled: false })
        })
        if (window.__deferAsyncLanes) {
          if (url.pathname.endsWith('/session-list/sidebar')) return deferLane('root')
          if (url.pathname.endsWith('/session-list/by-id')) return deferLane('exact')
          if (url.pathname.endsWith('/session-list/search')) return deferLane('search')
          if (url.pathname.endsWith('/session-list/architecture')) return deferLane('summary')
          if (url.pathname.endsWith('/session-list/descendant-activity')) return deferLane('badge')
        }
        let payload = {}
        if (url.pathname.endsWith('/session-list/sidebar')) payload = { version: 1, revision: 'r1', sessions: [], nextCursor: null, children: [], focus: [], pathContext: [], forcedChildren: {} }
        else if (url.pathname.endsWith('/session-list/by-id')) payload = { results: (JSON.parse(init?.body || '{}').ids || []).map(requestedId => ({ requestedId, session: null })) }
        else if (url.pathname.endsWith('/session-list/descendant-activity')) payload = { results: [] }
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      class FakeWebSocket {
        readyState = 0
        sent = []
        closes = []
        onopen = null
        onmessage = null
        onclose = null
        onerror = null
        constructor() {
          window.__sockets.push(this)
          setTimeout(() => {
            this.readyState = 1
            this.onopen?.({})
          }, 0)
        }
        send(value) {
          const message = JSON.parse(value)
          this.sent.push(message)
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'subscriptions-accepted', revision: message.revision }) }), 0)
        }
        close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }) }
        drop() { this.readyState = 3; this.onclose?.({}) }
      }
      window.WebSocket = FakeWebSocket
    })
    await page.addScriptTag({ content: script })
    await page.waitForFunction(() => !!window.foxwarmCollapsedLifecycle)

    await page.waitForFunction(() => window.__sockets.length === 1)
    assert.deepEqual(await page.evaluate(() => ({ requests: window.__requests.length, sockets: window.__sockets.length })), { requests: 0, sockets: 1 })
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('mobile'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(await page.evaluate(() => ({ requests: window.__requests.length, sockets: window.__sockets.length })), { requests: 0, sockets: 1 })

    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('collapsed-desktop'))
    await page.waitForFunction(() => window.__requests.length >= 2 && window.__sockets.length === 1)
    await page.waitForFunction(() => window.__sockets[0].sent.at(-1)?.sessionListActive === true)
    await new Promise(resolve => setTimeout(resolve, 50))
    const afterCollapsedBootstrap = await page.evaluate(() => window.__requests.length)
    assert.equal(afterCollapsedBootstrap, 2, 'collapsed bootstrap issues one immediate request pair')
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setCurrentSession('agent/other'))
    await page.waitForFunction(expected => window.__requests.length >= expected + 2, {}, afterCollapsedBootstrap)
    const afterFocusChange = await page.evaluate(() => window.__requests.length)
    await new Promise(resolve => setTimeout(resolve, 1150))
    const afterFocusDelay = await page.evaluate(() => ({ count: window.__requests.length, requests: window.__requests }))
    assert.equal(afterFocusDelay.count, afterFocusChange + 2, `the pending initial stream-open resync survives focus churn without duplicating: ${JSON.stringify(afterFocusDelay.requests)}`)
    const lastSidebarRequest = afterFocusDelay.requests.filter(request => request.path.endsWith('/session-list/sidebar')).at(-1)
    assert.match(lastSidebarRequest.search, /focusSessionId=agent%2Fother/, 'surviving delayed resync uses the latest focus')

    await page.evaluate(() => window.__sockets[0].drop())
    await page.waitForFunction(() => window.__sockets.length === 2, { timeout: 2_000 })
    await new Promise(resolve => setTimeout(resolve, 1150))
    assert.equal(await page.evaluate(() => window.__requests.length), afterFocusDelay.count + 2, 'physical reconnect performs one delayed safety resync')

    await page.evaluate(() => window.__sockets[1].drop())
    await page.waitForFunction(() => window.__sockets.length === 3, { timeout: 2_000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    const beforeUnmount = await page.evaluate(() => window.__requests.length)
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('expanded-desktop'))
    await new Promise(resolve => setTimeout(resolve, 1150))
    const cleanup = await page.evaluate(() => ({
      requests: window.__requests.length,
      lastSubscription: window.__sockets[2].sent.at(-1),
      adds: window.__listenerAdds,
      removes: window.__listenerRemoves,
    }))
    assert.equal(cleanup.requests, beforeUnmount, 'unmount cancels the pending open-resync timer')
    assert.equal(cleanup.lastSubscription?.sessionListActive, false, 'unmount removes the collapsed logical list subscription while the main controller keeps the socket alive')
    for (const event of ['foxwarm-idle-watch-changed', 'foxwarm-idle-unread-changed', 'storage']) {
      assert.equal(cleanup.removes[event], cleanup.adds[event], `${event} listener is removed on unmount`)
    }

    await page.evaluate(() => {
      window.__deferAsyncLanes = true
      window.__laneRequests = {}
      window.foxwarmCollapsedLifecycle.setSurface('async-lanes')
    })
    await page.waitForFunction(() => window.__laneRequests.root?.length >= 2 && window.__laneRequests.exact?.length >= 2)
    consoleErrors.length = 0
    pageErrors.length = 0

    await page.evaluate(() => {
      window.__settleLane('exact', 0, 'reject')
      window.__settleLane('root', 0, 'resolve')
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(consoleErrors, [], 'StrictMode first-pass exact failure stays silent after the second setup owns the hook')
    assert.deepEqual(await page.evaluate(() => ({ summary: window.__laneRequests.summary?.length || 0, badge: window.__laneRequests.badge?.length || 0 })), { summary: 0, badge: 0 }, 'stale first-pass root completion cannot launch summary or badge work')

    await page.evaluate(() => window.__settleLane('root', 1, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.summary?.length === 1 && window.__laneRequests.badge?.length === 1)
    await page.evaluate(() => {
      window.__settleLane('exact', 1, 'reject')
      window.__settleLane('summary', 0, 'reject')
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(consoleErrors.filter(message => message.includes('Failed bounded Session exact context')).length, 1, 'current exact failure reports once')
    assert.equal(consoleErrors.filter(message => message.includes('Failed bounded Session bootstrap')).length, 1, 'current bootstrap-summary failure reports once')

    await page.evaluate(() => window.foxwarmAsyncLaneController.setQuery('one'))
    await page.waitForFunction(() => window.__laneRequests.search?.length === 1)
    await page.evaluate(() => window.foxwarmAsyncLaneController.setQuery('two'))
    await page.waitForFunction(() => window.__laneRequests.search?.length === 2)
    const errorsBeforeSearch = consoleErrors.length
    await page.evaluate(() => window.__settleLane('search', 0, 'reject'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(consoleErrors.length, errorsBeforeSearch, 'older query failure stays silent after a newer search generation starts')
    await page.evaluate(() => window.__settleLane('search', 1, 'reject'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(consoleErrors.filter(message => message.includes('Failed bounded Session search')).length, 1, 'current search failure reports once')

    await page.evaluate(() => { void window.foxwarmAsyncLaneController.refresh() })
    await page.waitForFunction(() => window.__laneRequests.root?.length === 3)
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('expanded-desktop'))
    await page.waitForFunction(() => !document.querySelector('[data-async-lane-owner]'))
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('async-lanes'))
    await page.waitForFunction(() => window.__laneRequests.root?.length >= 5 && window.__laneRequests.exact?.length >= 4)
    const beforeStaleRefreshSettlement = await page.evaluate(() => ({
      exact: window.__laneRequests.exact.length,
      summary: window.__laneRequests.summary.length,
      search: window.__laneRequests.search.length,
    }))
    await page.evaluate(() => window.__settleLane('root', 2, 'resolve'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(await page.evaluate(() => ({
      exact: window.__laneRequests.exact.length,
      summary: window.__laneRequests.summary.length,
      search: window.__laneRequests.search.length,
    })), beforeStaleRefreshSettlement, 'a stale refresh root cannot continue into exact, summary, or search after the owner epoch changes')

    consoleErrors.length = 0
    pageErrors.length = 0
    const beforeAsyncUnmount = await page.evaluate(() => window.__requests.length)
    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setSurface('expanded-desktop'))
    await page.waitForFunction(() => !document.querySelector('[data-async-lane-owner]'))
    await page.evaluate(() => {
      for (const requests of Object.values(window.__laneRequests)) for (const request of requests) if (!request.settled) { request.settled = true; request.reject(new Error('late rejected request')) }
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await page.evaluate(() => window.__requests.length), beforeAsyncUnmount, 'late async rejection does not trigger trailing requests')
    assert.deepEqual(consoleErrors, [], 'late exact/search/summary/badge failures do not publish console errors after unmount')
    assert.deepEqual(pageErrors, [], 'late exact/search/summary/badge failures do not become unhandled rejections after unmount')

    await page.evaluate(() => {
      window.__laneRequests = {}
      window.foxwarmCollapsedLifecycle.setCurrentSession('agent/main')
      window.foxwarmCollapsedLifecycle.setSurface('refresh-overlap')
    })
    await page.waitForFunction(() => window.__laneRequests.root?.length === 1 && window.__laneRequests.exact?.length === 1)
    await page.evaluate(() => {
      window.__settleLane('root', 0, 'resolve')
      window.__settleLane('exact', 0, 'resolve')
    })
    await page.waitForFunction(() => window.__laneRequests.summary?.length === 1 && window.__laneRequests.badge?.length === 1)
    await page.evaluate(() => {
      window.__settleLane('summary', 0, 'resolve')
      window.__settleLane('badge', 0, 'resolve')
      void window.foxwarmAsyncLaneController.refresh()
    })
    await page.waitForFunction(() => window.__laneRequests.root?.length === 2)
    await page.evaluate(() => window.__settleLane('root', 1, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.exact?.length === 2)

    await page.evaluate(() => window.foxwarmCollapsedLifecycle.setCurrentSession('agent/other'))
    await page.waitForFunction(() => window.__laneRequests.root?.length === 3 && window.__laneRequests.exact?.length === 3)
    const beforeOldExact = await page.evaluate(() => ({
      summary: window.__laneRequests.summary.length,
      search: window.__laneRequests.search?.length || 0,
    }))
    await page.evaluate(() => window.__settleLane('exact', 1, 'resolve'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(await page.evaluate(() => ({
      summary: window.__laneRequests.summary.length,
      search: window.__laneRequests.search?.length || 0,
    })), beforeOldExact, 'a refresh superseded by a newer exact generation cannot continue into summary or search')

    await page.evaluate(() => {
      window.__settleLane('root', 2, 'resolve')
      window.__settleLane('exact', 2, 'resolve')
    })
    await page.waitForFunction(() => window.__laneRequests.summary?.length === 2 && window.__laneRequests.badge?.length === 3)
    await page.evaluate(() => {
      window.__settleLane('summary', 1, 'resolve')
      window.__settleLane('badge', 1, 'resolve')
      window.__settleLane('badge', 2, 'resolve')
      window.foxwarmAsyncLaneController.setQuery('refresh-query')
    })
    await page.waitForFunction(() => window.__laneRequests.search?.length === 1)
    await page.evaluate(() => window.__settleLane('search', 0, 'resolve'))

    await page.evaluate(() => { void window.foxwarmAsyncLaneController.refresh() })
    await page.waitForFunction(() => window.__laneRequests.root?.length === 4)
    await page.evaluate(() => window.__settleLane('root', 3, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.exact?.length === 4)
    await page.evaluate(() => window.__settleLane('exact', 3, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.summary?.length === 3)

    await page.evaluate(() => { void window.foxwarmAsyncLaneController.refresh() })
    await page.waitForFunction(() => window.__laneRequests.root?.length === 5)
    await page.evaluate(() => window.__settleLane('root', 4, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.exact?.length === 5)
    await page.evaluate(() => window.__settleLane('exact', 4, 'resolve'))
    await page.waitForFunction(() => window.__laneRequests.summary?.length === 4)
    const searchesBeforeOldSummary = await page.evaluate(() => window.__laneRequests.search.length)
    await page.evaluate(() => window.__settleLane('summary', 2, 'resolve'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await page.evaluate(() => window.__laneRequests.search.length), searchesBeforeOldSummary, 'a superseded summary cannot continue its refresh into search')
    await page.evaluate(() => window.__settleLane('summary', 3, 'resolve'))
    await page.waitForFunction(expected => window.__laneRequests.search.length === expected + 1, {}, searchesBeforeOldSummary)
    await page.evaluate(index => window.__settleLane('search', index, 'resolve'), searchesBeforeOldSummary)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(consoleErrors, [], 'current unsuperseded refresh completes root, exact, summary, and search without diagnostics')
    assert.deepEqual(pageErrors, [], 'refresh generation overlap produces no unhandled rejection')
  } finally {
    await browser.close()
  }
})
