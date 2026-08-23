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
  const childReplayRequests = []
  page.on('request', request => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/api/session-list/children')) return
    try {
      childReplayRequests.push(JSON.parse(request.postData() || '{}').parents?.map(parent => parent.parentSessionId) || [])
    } catch {}
  })
  await page.evaluateOnNewDocument(() => {
    const nativeFetch = window.fetch.bind(window)
    window.__foxwarmE2eChildTotals = {}
    window.fetch = async (input, init) => {
      const response = await nativeFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (!['/api/session-list/sidebar', '/api/session-list/children', '/api/session-list/by-id', '/api/session-list/search']
        .some(suffix => url.pathname.endsWith(suffix))) return response
      const body = await response.clone().json().catch(() => null)
      if (!body) return response
      const addCounts = value => {
        if (Array.isArray(value)) return value.map(addCounts)
        if (!value || typeof value !== 'object') return value
        if (typeof value.id === 'string' && value.runtimeState && value.tokenUsage) {
          return { ...value, childTotal: window.__foxwarmE2eChildTotals[value.id] || 0 }
        }
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, addCounts(entry)]))
      }
      return new Response(JSON.stringify(addCounts(body)), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    }
  })

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
  const disclosureText = sessionId => page.evaluate(id => {
    const row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
    return row?.querySelector('button[aria-expanded]')?.textContent?.trim() || null
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
    await page.evaluate(({ root, child, grandchild, unrelatedRoot, unrelatedChild }) => {
      window.__foxwarmE2eChildTotals = {
        [root]: 1, [child]: 1, [grandchild]: 0, [unrelatedRoot]: 1, [unrelatedChild]: 0,
      }
    }, { root, child, grandchild, unrelatedRoot, unrelatedChild })
    await moveSession(child, root)
    await moveSession(grandchild, child)
    await moveSession(unrelatedChild, unrelatedRoot)
    await waitForRow(root)
    await waitForRow(unrelatedRoot)

    let replay = waitForBranchReplay([unrelatedRoot])
    await clickDisclosure(unrelatedRoot)
    await replay
    await waitForRow(unrelatedChild)
    assert.equal(await disclosureText(unrelatedChild), null, 'a true leaf has no disclosure before any child query')

    replay = waitForBranchReplay([root, unrelatedRoot])
    await clickDisclosure(root)
    await replay
    await waitForRow(child)
    assert.match(await disclosureText(child), /1 child/, 'the child has an exact numbered disclosure before nested expansion')
    assert.equal(await rowExists(grandchild), false)

    replay = waitForBranchReplay([root, child, unrelatedRoot])
    await clickDisclosure(child)
    await replay
    await waitForRow(grandchild)
    assert.equal(await disclosureText(grandchild), null)

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

    await page.evaluate(id => {
      const row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
      if (!(row instanceof HTMLElement)) throw new Error(`Missing session row for ${id}`)
      row.click()
    }, grandchild)
    await page.waitForFunction(id => (
      document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)?.className.includes('bg-blue')
    ), { timeout: 5_000 }, grandchild)
    assert.equal(await disclosureExpanded(root), 'true')

    await clickDisclosure(root)
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.equal(await disclosureExpanded(root), 'false', 'a refresh for the same active descendant must not reopen a manually collapsed ancestor')
    assert.equal(await rowExists(child), false)
    assert.equal(await rowExists(grandchild), false)

    const replayRequestOffset = childReplayRequests.length
    replay = waitForBranchReplay([root], [child])
    await clickDisclosure(root)
    await replay
    await waitForRow(child)
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.equal(await disclosureExpanded(child), 'false', 're-expanding the collapsed active-path root keeps its pruned child disclosure collapsed')
    assert.equal(await rowExists(grandchild), false, 'the hidden grandchild remains hidden after re-expanding only its root')
    assert.equal(
      childReplayRequests.slice(replayRequestOffset).some(parentIds => parentIds.includes(child)),
      false,
      're-expanding the root does not silently replay the hidden child branch',
    )
  } finally {
    for (const sessionId of createdIds.reverse()) {
      await page.evaluate(async id => { await fetch(`./api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }) }, sessionId).catch(() => {})
    }
    await browser.close()
  }
})

test('Sidebar auto-expansion acquires child pages and exposes branch loading, failure, and retry', async () => {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const createdIds = []
  await page.evaluateOnNewDocument(() => {
    const nativeFetch = window.fetch.bind(window)
    window.__foxwarmIssue45 = { delayParent: '', release: false, failParent: '', requests: [] }
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const method = (init?.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase()
      if (method === 'GET' && url.pathname.endsWith('/api/session-list/sidebar') && window.__foxwarmIssue45.delayParent) {
        const response = await nativeFetch(input, init)
        const payload = await response.clone().json()
        payload.children = (payload.children || []).filter(group => group.parentSessionId !== window.__foxwarmIssue45.delayParent)
        return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      if (method === 'POST' && url.pathname.endsWith('/api/session-list/children')) {
        const body = JSON.parse(init?.body || '{}')
        const parentIds = (body.parents || []).map(parent => parent.parentSessionId)
        window.__foxwarmIssue45.requests.push(parentIds)
        if (window.__foxwarmIssue45.failParent && parentIds.includes(window.__foxwarmIssue45.failParent)) {
          window.__foxwarmIssue45.failParent = ''
          return new Response(JSON.stringify({ error: 'Injected child-page failure' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const response = await nativeFetch(input, init)
        if (window.__foxwarmIssue45.delayParent && parentIds.includes(window.__foxwarmIssue45.delayParent)) {
          const bodyText = await response.clone().text()
          while (!window.__foxwarmIssue45.release) await new Promise(resolve => setTimeout(resolve, 20))
          return new Response(bodyText, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
        return response
      }
      return nativeFetch(input, init)
    }
  })

  const createSession = async () => {
    const sessionId = await page.evaluate(async () => {
      const response = await fetch('./api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
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
  const rowExists = sessionId => page.evaluate(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), sessionId)
  const clickDisclosure = sessionId => page.evaluate(id => {
    const row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
    const button = row?.querySelector('button[aria-label="Expand child sessions"],button[aria-label="Collapse child sessions"]')
    if (!(button instanceof HTMLElement)) throw new Error(`Missing disclosure for ${id}`)
    button.click()
  }, sessionId)

  try {
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })

    const root = await createSession()
    const coordinator = await createSession()
    const worker = await createSession()
    const children = [await createSession(), await createSession(), await createSession()]
    await moveSession(coordinator, root)
    await moveSession(worker, coordinator)
    for (const child of children) await moveSession(child, worker)
    await page.waitForFunction(async ({ root, coordinator, worker }) => {
      const response = await fetch('./api/session-list/by-id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [root, coordinator, worker], includePaths: false }),
      })
      if (!response.ok) return false
      const payload = await response.json()
      const rows = new Map((payload.results || []).flatMap(item => item.session ? [[item.session.id, item.session]] : []))
      return rows.get(coordinator)?.parentSessionId === root && rows.get(worker)?.parentSessionId === coordinator
    }, { timeout: 10_000, polling: 100 }, { root, coordinator, worker })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })
    await page.waitForFunction(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, root)
    await clickDisclosure(root)
    await page.waitForFunction(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, coordinator)
    await clickDisclosure(coordinator)
    await page.waitForFunction(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, worker)

    await page.evaluate(workerId => {
      window.__foxwarmIssue45.delayParent = workerId
      window.__foxwarmIssue45.release = false
      window.foxwarmTest.switchToSession(workerId)
    }, worker)
    await new Promise(resolve => setTimeout(resolve, 500))
    await page.waitForSelector(`[data-session-branch-loading="${worker}"]`, { timeout: 10_000 })
    assert.equal(await rowExists(children[0]), false, 'the delayed initial child page has not rendered rows yet')
    assert.equal(await page.evaluate(workerId => {
      const row = document.querySelector(`[data-session-id="${CSS.escape(workerId)}"]`)
      return [...(row?.parentElement?.querySelectorAll('button') || [])].some(button => /Show \d+ more/.test(button.textContent || ''))
    }, worker), false, 'Show more never substitutes for a missing initial child page')
    const replayRequests = await page.evaluate(() => window.__foxwarmIssue45.requests)
    assert.equal(replayRequests.some(ids => ids.includes(worker)), true,
      `auto-expansion acquires the selected branch; observed ${JSON.stringify(replayRequests)}`)
    assert.equal(replayRequests.some(ids => ids.includes(worker) && ids.length > 1), true,
      'the selected branch is unioned with previously desired branches instead of replacing them')

    await page.evaluate(() => { window.__foxwarmIssue45.release = true; window.__foxwarmIssue45.delayParent = '' })
    for (const child of children) await page.waitForFunction(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, child)
    assert.equal(await page.$(`[data-session-branch-loading="${worker}"]`), null)
    assert.equal(await page.$(`[data-session-branch-retry="${worker}"]`), null)
    assert.equal(await page.evaluate(workerId => {
      const row = document.querySelector(`[data-session-id="${CSS.escape(workerId)}"]`)
      return [...(row?.parentElement?.querySelectorAll('button') || [])].some(button => /Show \d+ more/.test(button.textContent || ''))
    }, worker), false, 'a complete initial page does not create a continuation action')

    await clickDisclosure(worker)
    await page.waitForFunction(id => !document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, children[0])
    await page.evaluate(workerId => { window.__foxwarmIssue45.failParent = workerId }, worker)
    await clickDisclosure(worker)
    await page.waitForSelector(`[data-session-branch-retry="${worker}"]`, { timeout: 10_000 })
    assert.equal(await page.$(`[data-session-branch-loading="${worker}"]`), null)

    await page.click(`[data-session-branch-retry="${worker}"]`)
    for (const child of children) await page.waitForFunction(id => !!document.querySelector(`[data-session-id="${CSS.escape(id)}"]`), { timeout: 10_000 }, child)
    assert.equal(await page.$(`[data-session-branch-retry="${worker}"]`), null)
  } finally {
    for (const sessionId of createdIds.reverse()) {
      await page.evaluate(async id => { await fetch(`./api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }) }, sessionId).catch(() => {})
    }
    await browser.close()
  }
})
