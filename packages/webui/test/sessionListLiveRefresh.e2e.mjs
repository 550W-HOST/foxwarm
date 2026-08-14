import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

test('Sidebar keeps a newly forked child when an older bounded-window response arrives last', async () => {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => {
    const nativeFetch = window.fetch.bind(window)
    window.__foxwarmDelayNextSessionsResponse = false
    window.__foxwarmDelayedSessionsResponseCaptured = false
    window.__foxwarmDelayedSessionsIds = []
    window.__foxwarmLegacyGlobalGets = 0
    window.__foxwarmBoundedGets = 0
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const method = (init?.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase()
      if (method === 'GET' && url.pathname.endsWith('/api/sessions')) window.__foxwarmLegacyGlobalGets++
      if (method === 'GET' && url.pathname.endsWith('/api/session-list/sidebar')) window.__foxwarmBoundedGets++
      if (window.__foxwarmDelayNextSessionsResponse && method === 'GET' && url.pathname.endsWith('/api/session-list/sidebar')) {
        window.__foxwarmDelayNextSessionsResponse = false
        const body = await response.clone().text()
        try {
          const payload = JSON.parse(body)
          window.__foxwarmDelayedSessionsIds = [
            ...(payload.sessions || []).map(session => session.id),
            ...(payload.children || []).flatMap(group => (group.sessions || []).map(session => session.id)),
          ]
        } catch {}
        window.__foxwarmDelayedSessionsResponseCaptured = true
        await new Promise(resolve => setTimeout(resolve, 800))
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return response
    }
  })

  let parentSessionId
  let childSessionId
  try {
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })

    parentSessionId = await page.evaluate(async () => {
      const response = await fetch('./api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(payload))
      return payload.sessionId
    })
    await page.waitForFunction(sessionId => (
      !!document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    ), { timeout: 5_000 }, parentSessionId)
    await page.evaluate(sessionId => {
      document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)?.click()
    }, parentSessionId)

    await page.evaluate(() => {
      window.__foxwarmDelayNextSessionsResponse = true
      window.__foxwarmDelayedSessionsResponseCaptured = false
    })
    await page.evaluate(async sessionId => {
      const response = await fetch(`./api/sessions/${encodeURIComponent(sessionId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      })
      if (!response.ok) throw new Error(await response.text())
    }, parentSessionId)
    await page.waitForFunction(() => window.__foxwarmDelayedSessionsResponseCaptured, { timeout: 5_000 })

    childSessionId = await page.evaluate(async sessionId => {
      const response = await fetch(`./api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(payload))
      return payload.newSessionId
    }, parentSessionId)
    const delayedIds = await page.evaluate(() => window.__foxwarmDelayedSessionsIds)
    assert.equal(delayedIds.includes(childSessionId), false, 'the delayed response must be the pre-child snapshot')

    await page.waitForFunction(sessionId => (
      !!document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    ), { timeout: 5_000 }, childSessionId)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(await page.evaluate(sessionId => (
      !!document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    ), childSessionId), true)
    assert.equal(await page.evaluate(() => window.__foxwarmLegacyGlobalGets), 0, 'normal App never GETs the legacy global Session list')
    assert.ok(await page.evaluate(() => window.__foxwarmBoundedGets) >= 2, 'bootstrap and invalidation use bounded sidebar windows')
  } finally {
    if (childSessionId) {
      await page.evaluate(async sessionId => {
        await fetch(`./api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      }, childSessionId).catch(() => {})
    }
    if (parentSessionId) {
      await page.evaluate(async sessionId => {
        await fetch(`./api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      }, parentSessionId).catch(() => {})
    }
    await browser.close()
  }
})

test('Sidebar collapse prunes nested expansion state without clearing unrelated branches', async () => {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const createdIds = []

  const createSession = async () => {
    const sessionId = await page.evaluate(async () => {
      const response = await fetch('./api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(payload))
      return payload.sessionId
    })
    createdIds.push(sessionId)
    return sessionId
  }
  const moveSession = (sessionId, parentSessionId) => page.evaluate(async ({ sessionId, parentSessionId }) => {
    const response = await fetch(`./api/sessions/${encodeURIComponent(sessionId)}/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentSessionId }),
    })
    if (!response.ok) throw new Error(await response.text())
  }, { sessionId, parentSessionId })
  const waitForRow = sessionId => page.waitForFunction(id => (
    !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
  ), { timeout: 10_000 }, sessionId)
  const rowExists = sessionId => page.evaluate(id => (
    !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
  ), sessionId)
  const clickDisclosure = sessionId => page.evaluate(id => {
    const row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
    const button = row?.querySelector('button[aria-label="Expand child sessions"],button[aria-label="Collapse child sessions"]')
    if (!(button instanceof HTMLElement)) throw new Error(`Missing disclosure for ${id}`)
    button.click()
  }, sessionId)
  const disclosureExpanded = sessionId => page.evaluate(id => {
    const row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
    return row?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') || null
  }, sessionId)
  const waitForBranchReplay = (includedIds, excludedIds = []) => page.waitForResponse(response => {
    const request = response.request()
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/api/session-list/children')) return false
    try {
      const ids = JSON.parse(request.postData() || '{}').parents?.map(parent => parent.parentSessionId) || []
      return includedIds.every(id => ids.includes(id)) && excludedIds.every(id => !ids.includes(id))
    } catch { return false }
  }, { timeout: 10_000 })

  try {
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })

    const root = await createSession()
    const child = await createSession()
    const grandchild = await createSession()
    const unrelatedRoot = await createSession()
    const unrelatedChild = await createSession()
    await moveSession(child, root)
    await moveSession(grandchild, child)
    await moveSession(unrelatedChild, unrelatedRoot)
    await waitForRow(root)
    await waitForRow(unrelatedRoot)

    let replay = waitForBranchReplay([unrelatedRoot])
    await clickDisclosure(unrelatedRoot)
    await replay
    await waitForRow(unrelatedChild)

    replay = waitForBranchReplay([root, unrelatedRoot])
    await clickDisclosure(root)
    await replay
    await waitForRow(child)

    replay = waitForBranchReplay([root, child, unrelatedRoot])
    await clickDisclosure(child)
    await replay
    await waitForRow(grandchild)

    replay = waitForBranchReplay([unrelatedRoot], [root, child])
    await clickDisclosure(root)
    await replay
    assert.equal(await rowExists(child), false)
    assert.equal(await rowExists(grandchild), false)
    assert.equal(await rowExists(unrelatedChild), true)
    assert.equal(await disclosureExpanded(unrelatedRoot), 'true')

    replay = waitForBranchReplay([root, unrelatedRoot], [child])
    await clickDisclosure(root)
    await replay
    await waitForRow(child)
    assert.equal(await rowExists(grandchild), false, 're-expanding the root does not hidden-fetch the pruned grandchild branch')
    assert.equal(await disclosureExpanded(child), 'false', 'the reloaded child disclosure returns collapsed')
    assert.equal(await rowExists(unrelatedChild), true, 'the unrelated expanded branch stays rendered')

    replay = waitForBranchReplay([root, child, unrelatedRoot])
    await clickDisclosure(child)
    await replay
    await waitForRow(grandchild)
  } finally {
    for (const sessionId of createdIds.reverse()) {
      await page.evaluate(async id => { await fetch(`./api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }) }, sessionId).catch(() => {})
    }
    await browser.close()
  }
})
