import { appE2eRuntime } from '../../../test/app-e2e/runtime.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const { baseUrl, tokenFile } = appE2eRuntime()
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
let browser
let token

async function api(method, route, body) {
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function openList(focusSessionId, storage = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  // List preferences persist in the shared browser profile; every page starts from defaults.
  const preferences = { foxwarm_session_list_view_mode_v1: 'default', foxwarm_session_list_compact_v1: 'true', ...storage }
  await page.evaluateOnNewDocument(values => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  }, preferences)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
  await waitForWebUiReady(page)
  await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })
  if (focusSessionId) {
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), focusSessionId)
  }
  return page
}

const rowSelector = id => `[data-session-id="${id}"]`

// Facts about a rendered Session row and its wrapper in the Sidebar tree.
const describeRow = (page, id) => page.$eval(rowSelector(id), row => {
  const wrapper = row.parentElement
  const connector = row.querySelector('[data-session-branch-connector]')
  return {
    grouped: wrapper.hasAttribute('data-session-grouped'),
    connector: !!connector && connector.getBoundingClientRect().width > 0,
    text: row.textContent,
  }
})

// The branch line of one parent: its rendered segments must join without vertical gaps and
// share one horizontal position, ending at the middle of the branch's last row.
const branchLine = (page, parentId, lastRowId) => page.evaluate((parent, last) => {
  const segments = [...document.querySelectorAll('[data-session-branch-line]')]
    .filter(node => node.getAttribute('data-session-branch-line') === parent)
    .map(node => node.getBoundingClientRect())
    .sort((a, b) => a.top - b.top)
  const gaps = segments.slice(1).map((rect, index) => rect.top - segments[index].bottom).filter(gap => gap > 0.5)
  const lastRow = document.querySelector(`[data-session-id="${last}"]`).getBoundingClientRect()
  return {
    count: segments.length,
    gaps,
    columns: new Set(segments.map(rect => Math.round(rect.left))).size,
    endsAtLastRowMiddle: Math.abs(segments.at(-1).bottom - (lastRow.top + lastRow.height / 2)) <= 1.5,
  }
}, parentId, lastRowId)

async function expand(page, id) {
  const toggle = await page.waitForSelector(`${rowSelector(id)} button[aria-label="Expand child sessions"]`, { timeout: 10_000 })
  await toggle.click()
}

before(async () => {
  token = (await readFile(tokenFile, 'utf8')).trim()
  await api('POST', 'agents', { agentId: 'grp' })
  await api('POST', 'sessions', { agentId: 'grp', sessionId: 'real', parentSessionId: 'grp/main' })
  await api('POST', 'sessions', { agentId: 'grp', sessionId: 'loose' })
  // Rows of an Agent without its main Session stay top-level and carry an Agent tag.
  await api('POST', 'agents', { agentId: 'tagged' })
  await api('DELETE', `sessions/${encodeURIComponent('tagged/main')}`)
  await api('POST', 'sessions', { agentId: 'tagged', sessionId: 'a' })
  await api('POST', 'sessions', { agentId: 'tagged', sessionId: 'b' })
  await api('POST', `sessions/${encodeURIComponent('tagged/a')}/name`, { name: 'Release notes for the quarterly planning review' })
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
})

test('Sidebar groups top-level Sessions under their Agent host and connects only real children to its line', async () => {
  const page = await openList()
  try {
    await page.waitForSelector(rowSelector('grp/main'), { timeout: 10_000 })
    assert.equal(await page.$(rowSelector('grp/loose')), null, 'grouped rows start inside their collapsed host')

    await expand(page, 'grp/main')
    await page.waitForSelector(rowSelector('grp/loose'))
    await page.waitForSelector(rowSelector('grp/real'))
    const real = await describeRow(page, 'grp/real')
    const loose = await describeRow(page, 'grp/loose')
    assert.equal(real.grouped, false)
    assert.equal(real.connector, true, 'a real child joins the branch line')
    assert.equal(loose.grouped, true)
    assert.equal(loose.connector, false, 'a grouped row sits beside the line without a connector')
    assert.match(loose.text, /\/loose/)
    // A transient branch reload adds a loading row that briefly ends the line instead.
    await page.waitForFunction(() => !document.querySelector('[data-session-branch-loading]'), { timeout: 10_000 })
    const lastRowId = await page.$$eval('[data-session-id]', (rows, ids) => rows.map(row => row.getAttribute('data-session-id')).filter(id => ids.includes(id)).at(-1), ['grp/real', 'grp/loose'])
    const line = await branchLine(page, 'grp/main', lastRowId)
    assert.ok(line.count >= 2, JSON.stringify(line))
    assert.deepEqual(line.gaps, [], 'the branch line is continuous across rows')
    assert.equal(line.columns, 1)
    assert.equal(line.endsAtLastRowMiddle, true, JSON.stringify(line))

  } finally {
    await page.close()
  }
})

// Where the Agent tag sits in a row: after the title and before the row menu.
const describeTag = (page, id) => page.$eval(rowSelector(id), row => {
  const tag = row.querySelector('[data-session-agent-tag]')
  if (!tag) return null
  const title = row.querySelector('[data-session-title]').getBoundingClientRect()
  const menu = row.querySelector('.session-menu-trigger').getBoundingClientRect()
  const rect = tag.getBoundingClientRect()
  return {
    agent: tag.getAttribute('data-session-agent-tag'),
    afterTitle: rect.left >= title.right - 0.5,
    beforeMenu: rect.right <= menu.left + 0.5,
    sameLine: Math.abs((rect.top + rect.bottom) / 2 - (title.top + title.bottom) / 2) <= 2,
    titleWider: title.width > rect.width,
    tagWhole: tag.scrollWidth <= tag.clientWidth,
  }
})

test('Rows of an Agent without a main Session stay top-level and show a muted Agent tag', async () => {
  for (const [density, compact] of [['Normal', 'true'], ['Detailed', 'false']]) {
    const page = await openList(undefined, { foxwarm_session_list_compact_v1: compact })
    try {
      await page.waitForSelector(rowSelector('tagged/a'), { timeout: 10_000 })
      await page.waitForSelector(rowSelector('tagged/b'))
      assert.equal(await page.$('[data-session-group]'), null, 'there are no virtual group rows')
      assert.equal((await describeRow(page, 'tagged/a')).grouped, false)
      const tag = await describeTag(page, 'tagged/a')
      assert.deepEqual(tag, { agent: 'tagged', afterTitle: true, beforeMenu: true, sameLine: true, titleWider: true, tagWhole: true }, density)
      assert.equal(await describeTag(page, 'tagged/b'), null, `${density}: a title that already names the Agent has no tag`)
      assert.equal(await describeTag(page, 'grp/main'), null, `${density}: a main Session has no tag`)
      await expand(page, 'grp/main')
      await page.waitForSelector(rowSelector('grp/loose'))
      assert.equal(await describeTag(page, 'grp/loose'), null, `${density}: hosted rows have no tag`)
    } finally {
      await page.close()
    }
  }
})

test('Flat mode and search results show no Agent tag', async () => {
  const flat = await openList(undefined, { foxwarm_session_list_view_mode_v1: 'flat-time' })
  try {
    await flat.waitForSelector(rowSelector('tagged/a'), { timeout: 10_000 })
    assert.equal(await flat.$('[data-session-agent-tag]'), null)
  } finally {
    await flat.close()
  }
  const search = await openList()
  try {
    await search.waitForSelector(`${rowSelector('tagged/a')} [data-session-agent-tag]`, { timeout: 10_000 })
    await search.type('input[aria-label="Search sessions"]', 'quarterly')
    await search.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1 && !!document.querySelector('[data-session-id="tagged/a"]'), { timeout: 10_000 })
    assert.equal(await search.$('[data-session-agent-tag]'), null)
  } finally {
    await search.close()
  }
})

test('Create child session opens the New session dialog for the row and creates a fresh child', async () => {
  const page = await openList()
  try {
    await expand(page, 'grp/main')
    const row = await page.waitForSelector(rowSelector('grp/real'))
    await row.click({ button: 'right' })
    const item = await page.waitForSelector('xpath/.//*[@role="menuitem"][contains(., "Create child session")]', { timeout: 5_000 })
    await item.click()
    await page.waitForSelector('[data-creation-parent="grp/real"]', { timeout: 5_000 })
    assert.equal(await page.$eval('#creation-dialog-title', element => element.textContent), 'New child session')
    assert.equal(await page.$eval('[aria-label="Choose an agent"] button[aria-pressed="true"]', element => element.textContent), 'grp')
    await page.type('form[role="dialog"] input', 'made')
    await page.click('form[role="dialog"] button[type="submit"]')
    await page.waitForSelector('[data-creation-parent]', { hidden: true, timeout: 10_000 })

    const exact = await api('POST', 'session-list/by-id', { ids: ['grp/made'] })
    assert.equal(exact.results[0].session.parentSessionId, 'grp/real')
    const history = JSON.stringify(await api('GET', `sessions/${encodeURIComponent('grp/made')}/history`))
    assert.match(history, /event=\\"user-child-created\\" parentSessionId=\\"grp\/real\\"/)
    await page.waitForSelector(rowSelector('grp/made'), { timeout: 10_000 })
    assert.equal((await describeRow(page, 'grp/made')).connector, true)
  } finally {
    await page.close()
  }
})
