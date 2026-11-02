import { appE2eRuntime } from '../../../test/app-e2e/runtime.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const { baseUrl, tokenFile } = appE2eRuntime()
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const screenshotDir = process.env.FOXWARM_E2E_SCREENSHOT_DIR
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

const dark = JSON.stringify({ version: 3, themeId: 'foxwarm.550a', lightThemeId: 'foxwarm.550a', darkThemeId: 'foxwarm.550a', colorMode: 'dark' })

async function openList(storage = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  // List preferences persist in the shared browser profile; every page starts from defaults.
  const preferences = {
    foxwarm_session_list_view_mode_v1: 'default',
    foxwarm_session_list_compact_v1: 'true',
    foxwarm_session_list_grouping_v1: 'none',
    foxwarm_session_list_collapsed_groups_v1: '{}',
    ...storage,
  }
  await page.evaluateOnNewDocument(values => {
    if (sessionStorage.getItem('grouping-fixture-ready')) return
    sessionStorage.setItem('grouping-fixture-ready', '1')
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  }, preferences)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
  await waitForWebUiReady(page)
  await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })
  return page
}

const rowSelector = id => `[data-session-id="${id}"]`
const groupSelector = key => `[data-session-group="${key}"]`

// Group headers in display order, with the rows rendered inside each group.
const describeGroups = page => page.$$eval('[data-session-group]', sections => sections.map(section => ({
  key: section.getAttribute('data-session-group'),
  label: section.querySelector('[data-session-group-label]').textContent,
  count: Number(section.querySelector('[data-session-group-count]').textContent),
  online: section.querySelector('[data-session-group-online]')?.getAttribute('data-session-group-online') ?? null,
  rows: [...section.querySelectorAll('[data-session-id]')].map(row => row.getAttribute('data-session-id')),
})))

const sectionOf = (page, id) => page.$eval(rowSelector(id), row => row.closest('[data-session-group]')?.getAttribute('data-session-group') ?? row.closest('[data-session-section]')?.getAttribute('data-session-section') ?? null)
const tagOf = (page, id) => page.$eval(rowSelector(id), row => row.querySelector('[data-session-agent-tag]')?.getAttribute('data-session-agent-tag') ?? null)

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

// Connector widths of the given rows; 0 when a row has none.
const connectors = (page, ids) => page.$$eval('[data-session-id]', (rows, wanted) => wanted.map(id => {
  const connector = rows.find(row => row.getAttribute('data-session-id') === id)?.querySelector('[data-session-branch-connector]')
  return connector ? Math.round(connector.getBoundingClientRect().width) : 0
}), ids)

async function expand(page, id) {
  const toggle = await page.waitForSelector(`${rowSelector(id)} button[aria-label="Expand child sessions"]`, { timeout: 10_000 })
  await toggle.click()
}

async function shoot(page, name) {
  if (!screenshotDir) return
  await page.waitForFunction(() => !document.querySelector('[data-session-branch-loading]'), { timeout: 10_000 })
  await page.$eval('[data-session-list-scroll-container]', element => { element.scrollTop = 0 })
  await new Promise(resolve => setTimeout(resolve, 300))
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), clip: { x: 0, y: 0, width: 360, height: 900 }, captureBeyondViewport: false })
}

before(async () => {
  token = (await readFile(tokenFile, 'utf8')).trim()
  await api('POST', 'agents', { agentId: 'grp' })
  await api('POST', 'sessions', { agentId: 'grp', sessionId: 'real', parentSessionId: 'grp/main' })
  await api('POST', 'sessions', { agentId: 'grp', sessionId: 'second', parentSessionId: 'grp/main' })
  await api('POST', 'sessions', { agentId: 'grp', sessionId: 'loose' })
  await api('POST', `sessions/${encodeURIComponent('grp/loose')}/name`, { name: 'Release notes for the quarterly planning review' })
  // A main-Agent child of a grp row stays under its real parent in the grp group.
  await api('POST', 'sessions', { agentId: 'main', sessionId: 'visitor', parentSessionId: 'grp/loose' })
  await api('POST', 'agents', { agentId: 'beta' })
  await api('POST', 'sessions', { agentId: 'beta', sessionId: 'b' })
  await api('POST', 'sessions', { agentId: 'main', sessionId: 'starred' })
  await api('POST', 'sessions/starred/pin', { pinned: true })
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
})

test('Without grouping, top-level Sessions stay top-level and real children join the branch line', async () => {
  const page = await openList()
  try {
    await page.waitForSelector(rowSelector('grp/loose'), { timeout: 10_000 })
    assert.equal(await page.$('[data-session-group]'), null)
    assert.equal(await sectionOf(page, 'grp/loose'), 'sessions')
    assert.equal(await sectionOf(page, 'starred'), 'pinned')
    // Agent tags name non-default Agents unless the title already does.
    assert.equal(await tagOf(page, 'grp/loose'), 'grp')
    assert.equal(await tagOf(page, 'beta/b'), null)
    assert.equal(await tagOf(page, 'grp/main'), null)
    assert.equal(await tagOf(page, 'app-e2e-list-01'), null, 'the default Agent has no tag')

    await expand(page, 'grp/main')
    await page.waitForSelector(rowSelector('grp/real'))
    await page.waitForFunction(() => !document.querySelector('[data-session-branch-loading]'), { timeout: 10_000 })
    assert.deepEqual(await connectors(page, ['grp/real', 'grp/second']), [6, 6], 'every child joins with the same connector')
    const lastRowId = await page.$$eval('[data-session-id]', (rows, ids) => rows.map(row => row.getAttribute('data-session-id')).filter(id => ids.includes(id)).at(-1), ['grp/real', 'grp/second'])
    const line = await branchLine(page, 'grp/main', lastRowId)
    assert.ok(line.count >= 2, JSON.stringify(line))
    assert.deepEqual(line.gaps, [], 'the branch line is continuous across rows')
    assert.equal(line.columns, 1)
    assert.equal(line.endsAtLastRowMiddle, true, JSON.stringify(line))
  } finally {
    await page.close()
  }
})

test('Agent groups list the main Agent first, start with the Agent main and keep real subtrees', async () => {
  for (const [density, compact] of [['normal', 'true'], ['detailed', 'false']]) {
    // The long main group starts collapsed so every group fits in the screenshot.
    const page = await openList({ foxwarm_session_list_grouping_v1: 'agent', foxwarm_session_list_collapsed_groups_v1: JSON.stringify({ agent: ['main'] }), foxwarm_session_list_compact_v1: compact, foxwarm_theme_selection_v3: dark })
    try {
      await page.waitForSelector(`${groupSelector('grp')} ${rowSelector('grp/main')}`, { timeout: 10_000 })
      const groups = await describeGroups(page)
      assert.deepEqual(groups.map(group => group.key), ['main', 'beta', 'grp'])
      const grp = groups.find(group => group.key === 'grp')
      assert.equal(grp.rows[0], 'grp/main')
      assert.deepEqual([...grp.rows].sort(), ['grp/loose', 'grp/main'])
      assert.equal(grp.count, 2)
      assert.deepEqual([groups[0].rows, groups[0].count], [[], 42], 'a collapsed group keeps its count')
      // Pinned rows keep their own section, outside the groups.
      assert.equal(await sectionOf(page, 'starred'), 'pinned')
      assert.equal(await page.$('[data-session-agent-tag]'), null, 'Agent groups show no Agent tags')

      await expand(page, 'grp/loose')
      await page.waitForSelector(`${groupSelector('grp')} ${rowSelector('visitor')}`, { timeout: 10_000 })
      await expand(page, 'grp/main')
      await page.waitForSelector(`${groupSelector('grp')} ${rowSelector('grp/real')}`, { timeout: 10_000 })
      await shoot(page, `agent-groups-default-${density}-dark`)
    } finally {
      await page.close()
    }
  }
})

test('Agent group headers create Sessions, open Agent settings and keep their collapsed state', async () => {
  const page = await openList({ foxwarm_session_list_grouping_v1: 'agent' })
  try {
    const header = await page.waitForSelector(`${groupSelector('beta')} [data-session-group-toggle]`, { timeout: 10_000 })
    await page.hover(`${groupSelector('beta')} [data-session-group-toggle]`)
    await page.click('[data-session-group-create="beta"]')
    await page.waitForSelector('#creation-dialog-title', { timeout: 5_000 })
    assert.equal(await page.$eval('#creation-dialog-title', element => element.textContent), 'New session')
    assert.equal(await page.$('[data-creation-parent]'), null)
    assert.equal(await page.$eval('[aria-label="Choose an agent"] button[aria-pressed="true"]', element => element.textContent), 'beta')
    await page.type('form[role="dialog"] input', 'made')
    await page.click('form[role="dialog"] button[type="submit"]')
    await page.waitForSelector('#creation-dialog-title', { hidden: true, timeout: 10_000 })
    await page.waitForSelector(`${groupSelector('beta')} ${rowSelector('beta/made')}`, { timeout: 10_000 })
    assert.equal((await api('POST', 'session-list/by-id', { ids: ['beta/made'] })).results[0].session.parentSessionId, null)

    await header.click({ button: 'right' })
    const settings = await page.waitForSelector('xpath/.//*[@role="menuitem"][contains(., "Agent settings")]', { timeout: 5_000 })
    await settings.click()
    await page.waitForSelector('[data-architecture-agent-inspector-id="beta"]', { timeout: 10_000 })

    await page.click(`${groupSelector('beta')} [data-session-group-toggle]`)
    await page.waitForFunction(() => !document.querySelector('[data-session-group="beta"] [data-session-id]'), { timeout: 10_000 })
    assert.equal(await page.$eval(`${groupSelector('beta')} [data-session-group-toggle]`, button => button.getAttribute('aria-expanded')), 'false')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)
    await page.waitForSelector(`${groupSelector('grp')} ${rowSelector('grp/main')}`, { timeout: 10_000 })
    assert.equal(await page.$(`${groupSelector('beta')} [data-session-id]`), null, 'a collapsed group stays collapsed')
    assert.equal(await page.$eval(`${groupSelector('beta')} [data-session-group-count]`, element => element.textContent), '3')
  } finally {
    await page.close()
  }
})

test('Node groups show the Node state, and Flat groups every Session by its own group', async () => {
  for (const [density, compact] of [['normal', 'true'], ['detailed', 'false']]) {
    const page = await openList({ foxwarm_session_list_grouping_v1: 'node', foxwarm_session_list_compact_v1: compact, foxwarm_theme_selection_v3: dark })
    try {
      await page.waitForSelector(`${groupSelector('master')} ${rowSelector('grp/loose')}`, { timeout: 10_000 })
      const [master, ...others] = await describeGroups(page)
      assert.deepEqual([master.key, master.label, master.online], ['master', 'master', 'true'])
      assert.deepEqual(others, [])
      assert.equal(master.rows.includes('grp/real'), false, 'children stay under their parent')
      assert.equal(await tagOf(page, 'grp/loose'), 'grp', 'Node groups keep Agent tags')
      await expand(page, 'grp/main')
      await page.waitForSelector(`${groupSelector('master')} ${rowSelector('grp/real')}`, { timeout: 10_000 })
      await shoot(page, `node-groups-default-${density}-dark`)
    } finally {
      await page.close()
    }
  }

  const flat = await openList({ foxwarm_session_list_grouping_v1: 'agent', foxwarm_session_list_view_mode_v1: 'flat-time', foxwarm_session_list_collapsed_groups_v1: JSON.stringify({ agent: ['main'] }), foxwarm_theme_selection_v3: dark })
  try {
    await flat.waitForSelector(`${groupSelector('grp')} ${rowSelector('grp/real')}`, { timeout: 10_000 })
    const grp = (await describeGroups(flat)).find(group => group.key === 'grp')
    assert.equal(grp.rows[0], 'grp/main')
    assert.deepEqual([...grp.rows].sort(), ['grp/loose', 'grp/main', 'grp/real', 'grp/second'])
    assert.equal(await flat.$(rowSelector('visitor')), null, 'a Flat row is grouped by its own Agent')
    await flat.click(`${groupSelector('main')} [data-session-group-toggle]`)
    await flat.waitForSelector(`${groupSelector('main')} ${rowSelector('visitor')}`, { timeout: 10_000 })
    assert.equal((await describeGroups(flat))[0].rows[0], 'main', 'the Agent main leads its group')
    assert.equal(await flat.$(`${groupSelector('main')} ${rowSelector('starred')}`), null, 'pinned rows stay outside the groups')
    await flat.click(`${groupSelector('main')} [data-session-group-toggle]`)
    await flat.waitForFunction(() => !document.querySelector('[data-session-group="main"] [data-session-id]'), { timeout: 10_000 })
    assert.equal(await flat.$('[data-session-agent-tag]'), null)
    await shoot(flat, 'agent-groups-flat-normal-dark')
  } finally {
    await flat.close()
  }
})

test('Search results stay ungrouped', async () => {
  const page = await openList({ foxwarm_session_list_grouping_v1: 'agent' })
  try {
    await page.waitForSelector('[data-session-group]', { timeout: 10_000 })
    await page.type('input[aria-label="Search sessions"]', 'quarterly')
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length === 1 && !!document.querySelector('[data-session-id="grp/loose"]'), { timeout: 10_000 })
    assert.equal(await page.$('[data-session-group]'), null)
    assert.equal(await page.$('[data-session-agent-tag]'), null)
  } finally {
    await page.close()
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
    assert.ok(await page.$(`${rowSelector('grp/made')} [data-session-branch-connector]`))
  } finally {
    await page.close()
  }
})
