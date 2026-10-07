import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const statuses = ['open', 'active', 'completed', 'cancelled']
const timestamp = 1_780_000_000_000
const task = (status, index) => ({ id: `task-${status}${index === undefined ? '' : `-${index}`}`, title: `${status} task${index === undefined ? '' : ` ${index}`}`, status, parentTaskId: null, ownerSessionId: status === 'open' ? null : 'worker/main', ownerAgent: status === 'open' ? null : 'worker', createdBySessionId: 'creator/main', createdByAgent: 'creator', updatedAt: timestamp + (index || 0) })
let browser, page, server, fixtureUrl
let mode = 'normal'
let heldLists = []
let heldDetails = []
let holdDetails = false
let onListsHeld
let onDetailsHeld
let heldComments = []
let holdComments = false
let onCommentsHeld
let heldSearches = []
let holdOtherSearch = false
const requests = []

function readBody(request) {
  return new Promise(resolve => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null) } catch { resolve(null) }
    })
  })
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
function details(id) {
  const match = id.match(/^task-(open|active|completed|cancelled)(?:-(\d+))?$/)
  const selected = match ? task(match[1], match[2] ? Number(match[2]) : undefined) : task('open')
  return {
    task: { ...selected, description: 'A small task\nwith a clear scope.', parentTaskId: 'task-parent', result: 'The result is ready.' },
    children: [{ id: 'task-open', title: 'Child task', status: 'open', ownerSessionId: null }], childrenOmitted: 2,
    notes: Array.from({ length: 10 }, (_, index) => ({ sessionId: 'worker/main', text: `Note ${index + 1}`, createdAt: timestamp + index })), notesOmitted: 3,
  }
}

before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'Build the WebUI before running its browser fixtures.')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import TasksView from './src/components/TasksView'; import { initializeThemeRuntime } from './src/theme'; initializeThemeRuntime(); createRoot(document.getElementById('root')).render(React.createElement(TasksView));`, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tasks-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const body = request.method === 'POST' ? await readBody(request) : null
    if (url.pathname === '/prefix/ui/api/session-list/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const sessions = [
        { id: 'worker/main', agent: 'worker', displayName: 'Worker' },
        { id: 'other/main', agent: 'other', displayName: 'Other' },
      ].filter(session => `${session.id} ${session.agent} ${session.displayName}`.toLowerCase().includes(q))
      const reply = () => json(response, { sessions })
      if (holdOtherSearch && q === 'other') heldSearches.push(reply)
      else return reply()
      return
    }
    if (url.pathname === '/prefix/ui/api/session-list/by-id') {
      const ids = Array.isArray(body?.ids) ? body.ids : []
      const sessions = new Map([
        ['worker/main', { id: 'worker/main', agent: 'worker', displayName: 'Worker' }],
        ['other/main', { id: 'other/main', agent: 'other', displayName: 'Other' }],
      ])
      return json(response, { results: ids.map(requestedId => ({ requestedId, session: sessions.get(requestedId) || null })) })
    }
    if (url.pathname === '/prefix/ui/api/tasks' && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'create', body })
      return json(response, { task: { ...task('open'), id: 'task-user', title: 'Created from WebUI', createdByKind: 'user', createdBySessionId: null, ownerSessionId: body?.ownerSessionId ? 'worker/canonical' : null }, warning: body?.notifySession ? 'Task assigned, but the new-owner notification could not be delivered.' : undefined }, 201)
    }
    if (url.pathname.endsWith('/comments') && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'comment', body })
      const reply = () => json(response, { task: task('active'), warning: body?.notifySession ? 'Comment saved, but the owner notification could not be delivered.' : undefined })
      if (holdComments) { heldComments.push(reply); onCommentsHeld?.() }
      else reply()
      return
    }
    if (url.pathname.endsWith('/assign') && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'assign', body })
      return json(response, { task: { ...task('active'), ownerSessionId: body?.ownerSessionId || null }, warning: body?.notifySession ? 'Task assigned, but the owner notification could not be delivered.' : undefined })
    }
    if (url.pathname === '/prefix/ui/api/tasks') {
      requests.push({ pathname: url.pathname, method: request.method, status: url.searchParams.get('status'), limit: url.searchParams.get('limit') })
      const status = url.searchParams.get('status')
      const list = mode === 'long-list' ? Array.from({ length: 25 }, (_, index) => task(status, index + 1)) : [task(status)]
      const reply = () => mode === 'error' ? json(response, { error: 'Tasks are temporarily unavailable.' }, 503) : json(response, { tasks: mode === 'empty' ? [] : list, omitted: mode === 'empty' ? 0 : 1 })
      if (mode === 'loading') { heldLists.push(reply); if (heldLists.length === 4) onListsHeld?.() }
      else reply()
      return
    }
    if (url.pathname.startsWith('/prefix/ui/api/tasks/')) {
      requests.push({ pathname: url.pathname, method: request.method })
      const reply = () => mode === 'detail-error' ? json(response, { error: 'This task is unavailable.' }, 404) : json(response, details(decodeURIComponent(url.pathname.split('/').at(-1))))
      if (holdDetails) { heldDetails.push(reply); onDetailsHeld?.() }
      else reply()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><head><style>${css} html, body, #root { height: 100%; margin: 0; }</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}/prefix/ui/`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
})
after(async () => {
  heldLists.splice(0).forEach(reply => reply())
  heldDetails.splice(0).forEach(reply => reply())
  heldComments.splice(0).forEach(reply => reply())
  heldSearches.splice(0).forEach(reply => reply())
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

async function click(label) {
  await page.evaluate(label => Array.from(document.querySelectorAll('button')).find(button => button.textContent === label).click(), label)
}
async function waitLoaded() {
  await page.waitForSelector('[data-tasks-view][aria-busy="false"]')
}

test('Tasks reads bounded status windows, switches Table/Board, and shows bounded details', async () => {
  await page.goto(fixtureUrl)
  await page.waitForSelector('[data-task-row]')
  assert.deepEqual(await page.$$eval('thead th', rows => rows.map(row => row.textContent)), ['Title', 'Status', 'Owner', 'Created by', 'Updated'])
  assert.match(await page.$eval('[data-task-new]', button => button.className), /bg-fw-accent/)
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 2)
  assert.match(await page.$eval('[data-task-row="task-open"]', row => row.textContent), /Unassigned.*creator\/main/)
  assert.equal(await page.$eval('[data-task-row="task-active"] [data-session-reference]', node => node.textContent), 'worker/main')
  assert.equal(await page.$eval('[data-task-row="task-active"] [data-session-reference]', node => node.getAttribute('title')), 'worker/main')
  assert.deepEqual(await page.$eval('[data-task-row="task-active"] [data-session-copy]', button => ({ label: button.getAttribute('aria-label'), title: button.getAttribute('title'), text: button.textContent })), { label: 'Copy Session ID worker/main', title: 'Copy Session ID worker/main', text: '' })
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__taskCopiedSessionId = text } } })
  })
  await page.focus('[data-task-row="task-active"] [data-session-copy]')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('[data-task-row="task-active"] [data-session-copy]')?.getAttribute('data-session-copy-state') === 'copied')
  assert.equal(await page.evaluate(() => window.__taskCopiedSessionId), 'worker/main')
  assert.equal(await page.$('[data-task-details]'), null, 'Copying a Session ID does not open task details')
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable') } })
  await page.click('[data-task-row="task-open"] [data-session-copy="creator/main"]')
  await page.waitForSelector('[data-session-copy-error]')
  assert.deepEqual(await page.$eval('[data-task-row="task-open"] [data-session-copy="creator/main"]', button => ({ label: button.getAttribute('aria-label'), title: button.getAttribute('title'), state: button.getAttribute('data-session-copy-state') })), { label: 'Copy failed for Session ID creator/main', title: 'Copy failed for Session ID creator/main', state: 'error' })
  assert.deepEqual(await page.$eval('[data-task-row="task-active"] td:nth-child(3)', cell => ({ whiteSpace: getComputedStyle(cell).whiteSpace, wideEnough: cell.getBoundingClientRect().width >= 256 })), { whiteSpace: 'nowrap', wideEnough: true })
  assert.match(await page.$eval('[data-task-summary]', element => element.textContent), /2 tasks loaded.*Work.*Open 1.*Active 1/)
  assert.match(await page.$eval('[data-task-secondary-summary]', element => element.textContent), /Additional tasks not loaded: 2/)
  assert.match(await page.$eval('[data-task-filters]', element => element.textContent), /Agent.*Relationship/)
  assert.deepEqual(await page.$$eval('[data-task-agent-filter] option', options => options.map(option => option.value)), ['', 'creator', 'worker'])
  await page.select('[data-task-agent-filter]', 'worker')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 1)
  await page.select('[data-task-agent-relation]', 'creator')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 0)
  await page.select('[data-task-agent-relation]', 'owner')
  assert.match(await page.$eval('[data-task-secondary-summary]', element => element.textContent), /Agent filter hides 1 loaded task.*Additional tasks not loaded: 2/)
  await page.select('[data-task-agent-filter]', '')
  assert.deepEqual(requests.filter(request => request.status).map(request => [request.status, request.limit]), statuses.map(status => [status, '50']))
  assert.ok(requests.every(request => request.method === 'GET' && request.pathname.startsWith('/prefix/ui/api/tasks')))
  await click('All')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 4)
  assert.match(await page.$eval('[data-task-summary]', element => element.textContent), /4 tasks loaded.*All.*Open 1.*Active 1.*Completed 1.*Cancelled 1/)
  await click('Board')
  assert.deepEqual(await page.$$eval('[data-task-column]', columns => columns.map(column => column.dataset.taskColumn)), statuses)
  for (const status of statuses) {
    assert.equal(await page.$$eval(`[data-task-column="${status}"] [data-task-card]`, cards => cards.length), 1)
    assert.match(await page.$eval(`[data-task-card="task-${status}"]`, card => card.textContent), new RegExp(`task-${status}`))
  }
  await page.click('[data-task-card="task-completed"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'completed task')
  assert.match(await page.$eval('[data-task-details]', detail => detail.textContent), /Task details.*completed task.*Description.*A small task.*Parent.*task-parent.*Owner.*worker\/main.*Result.*The result is ready\..*2 more child tasks.*3 more notes/s)
  assert.ok(await page.$('[data-task-details] [data-session-copy="worker/main"]'))
  assert.deepEqual(await page.$eval('[data-task-details]', detail => ({ role: detail.getAttribute('role'), ariaModal: detail.getAttribute('aria-modal') })), { role: null, ariaModal: null })
  assert.equal(await page.$$eval('[data-task-details] li', items => items.filter(item => item.textContent.includes('Note ')).length), 10)
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForFunction(() => window.innerWidth < 1024)
  await page.waitForFunction(() => document.querySelector('[data-task-details]')?.getAttribute('role') === 'dialog')
  assert.deepEqual(await page.$eval('[data-task-details]', detail => ({ role: detail.getAttribute('role'), ariaModal: detail.getAttribute('aria-modal') })), { role: 'dialog', ariaModal: 'true' })
  assert.equal(await page.$eval('[data-task-details]', detail => getComputedStyle(detail).position), 'fixed', 'Mobile task details stay directly visible as an overlay')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Board scroll stays inside Tasks on a narrow viewport')
  assert.ok(await page.$eval('[data-task-board]', board => board.getBoundingClientRect().height > 0), 'Board remains reachable above details')
  await page.setViewport({ width: 1400, height: 900 })
  await click('Table')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 4)
  await page.click('[data-task-row="task-active"] button')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'active task')
  await page.click('[aria-label="Close task details"]')
  assert.equal(await page.$('[data-task-details]'), null)
  await click('History')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 2)
  await click('Board')
  assert.deepEqual(await page.$$eval('[data-task-column]', columns => columns.map(column => column.dataset.taskColumn)), ['completed', 'cancelled'])
  await click('Work')
  await click('Table')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 2)
  await click('All')
})

test('loading, errors, empty views and Refresh use the same bounded reader', async () => {
  mode = 'loading'
  const listsHeld = new Promise(resolve => { onListsHeld = resolve })
  await click('Refresh')
  await page.waitForSelector('[data-tasks-view][aria-busy="true"]')
  assert.match(await page.$eval('[role="status"]', element => element.textContent), /Loading tasks/)
  assert.equal(await page.$$eval('[data-tasks-view] button', buttons => buttons.find(button => button.textContent === 'Refresh').disabled), true)
  await listsHeld
  mode = 'empty'
  heldLists.splice(0).forEach(reply => reply())
  await waitLoaded()
  assert.match(await page.$eval('[data-tasks-view]', element => element.textContent), /No tasks/)
  await click('Board')
  assert.equal(await page.$$eval('[data-task-column]', columns => columns.filter(column => column.textContent.includes('No tasks in this column')).length), 4)
  mode = 'error'
  await click('Refresh')
  await page.waitForSelector('[role="alert"]')
  assert.equal(await page.$eval('[role="alert"]', element => element.textContent), 'Tasks are temporarily unavailable.')
  mode = 'normal'
  await click('Refresh')
  await page.waitForSelector('[data-task-card]')
  assert.equal(await page.$('[role="alert"]'), null)
  mode = 'detail-error'
  await page.click('[data-task-card="task-active"]')
  await page.waitForSelector('[data-task-details] [role="alert"]')
  assert.match(await page.$eval('[data-task-details]', element => element.textContent), /This task is unavailable/)
  mode = 'normal'
  await click('Refresh')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'active task')
  await page.click('[aria-label="Close task details"]')
})

test('changing selected task while a detail read is pending never restores stale details', async () => {
  holdDetails = true
  const detailsHeld = new Promise(resolve => { onDetailsHeld = resolve })
  await page.click('[data-task-card="task-open"]')
  await page.waitForSelector('[data-task-details][aria-busy="true"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details]')?.textContent.includes('Loading task details'))
  await detailsHeld
  holdDetails = false
  await page.click('[data-task-card="task-active"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'active task')
  heldDetails.splice(0).forEach(reply => reply())
  await page.waitForFunction(() => document.querySelector('[data-task-details][aria-busy="false"] h4')?.textContent === 'active task')
  assert.equal(await page.$eval('[data-task-details] h4', heading => heading.textContent), 'active task')
  await page.click('[aria-label="Close task details"]')
})

test('narrow screens show and close details over a long Board without leaving the click position', async () => {
  mode = 'long-list'
  await page.setViewport({ width: 1400, height: 900 })
  await click('Refresh')
  await page.waitForSelector('[data-task-card="task-cancelled-25"]')
  await page.setViewport({ width: 390, height: 844 })
  await page.click('[data-task-card="task-cancelled-25"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'cancelled task 25')
  const detailsMetrics = await page.$eval('[data-task-details]', detail => {
    const rect = detail.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height, title: detail.querySelector('h4')?.textContent }
  })
  assert.equal(detailsMetrics.title, 'cancelled task 25')
  assert.ok(detailsMetrics.top >= 0 && detailsMetrics.bottom <= 844 && detailsMetrics.height >= 800, 'Mobile details are visible in the viewport')
  await page.click('[aria-label="Close task details"]')
  assert.equal(await page.$('[data-task-details]'), null)
  mode = 'normal'
})

test('comment drafts and delayed responses stay attached to their selected task', async () => {
  await page.setViewport({ width: 1400, height: 900 })
  await click('Table')
  await click('Refresh')
  await page.waitForSelector('[data-task-row="task-active"]')
  await page.click('[data-task-row="task-active"] button')
  await page.waitForSelector('[data-task-details] textarea')
  await page.locator('[data-task-details] textarea').fill('Comment for active')
  holdComments = true
  const commentsHeld = new Promise(resolve => { onCommentsHeld = resolve })
  await page.click('[data-task-details] button[type="submit"]')
  await commentsHeld
  await page.click('[data-task-row="task-open"] button')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'open task')
  await page.waitForSelector('[data-task-details] textarea')
  assert.equal(await page.$eval('[data-task-details] textarea', element => element.value), '')
  await page.locator('[data-task-details] textarea').fill('Comment for open')
  holdComments = false
  heldComments.splice(0).forEach(reply => reply())
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(await page.$eval('[data-task-details] textarea', element => element.value), 'Comment for open')
  onCommentsHeld = undefined
  await page.click('[aria-label="Close task details"]')
})

test('WebUI creates, comments, and changes task owners through user routes', async () => {
  await page.setViewport({ width: 1400, height: 900 })
  await click('Table')
  await click('Refresh')
  await page.waitForSelector('[data-task-row="task-open"]')
  await click('New task')
  await page.locator('[aria-labelledby="new-task-title"] input').fill('Created from WebUI')
  const selector = page.locator('[aria-labelledby="new-task-title"] [data-session-selector-input]')
  await selector.fill('worker')
  await page.waitForSelector('[data-session-option="worker/main"]')
  await page.click('[data-session-option="worker/main"]')
  await page.$eval('[aria-labelledby="new-task-title"]', form => form.requestSubmit())
  await page.waitForSelector('[aria-labelledby="new-task-title"]', { hidden: true })
  const userCreate = requests.find(request => request.action === 'create')
  assert.deepEqual(userCreate, {
    pathname: '/prefix/ui/api/tasks', method: 'POST', action: 'create',
    body: { title: 'Created from WebUI', ownerSessionId: 'worker/main', notifySession: true },
  })
  assert.equal(await page.$eval('[data-task-warning]', node => node.textContent), 'Task assigned, but the new-owner notification could not be delivered.')
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_tasks_last_owner_v1')), 'worker/canonical')
  await click('New task')
  const querySelector = page.locator('[aria-labelledby="new-task-title"] [data-session-selector-input]')
  await querySelector.fill('worker')
  await page.waitForSelector('[data-session-option="worker/main"]')
  holdOtherSearch = true
  await querySelector.fill('other')
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="new-task-title"] [data-session-selector-input]')?.value === 'other')
  await querySelector.click()
  await page.keyboard.press('Enter')
  assert.equal(await page.$('[data-session-option="worker/main"]'), null)
  assert.equal(await page.$eval('[aria-labelledby="new-task-title"] [data-session-selector-input]', input => input.value), 'other')
  holdOtherSearch = false
  heldSearches.splice(0).forEach(reply => reply())
  await click('Cancel')
  await click('New task')
  const staleOwnerInput = page.locator('[aria-labelledby="new-task-title"] [data-session-selector-input]')
  await staleOwnerInput.fill('missing')
  await page.waitForSelector('[aria-labelledby="new-task-title"] [data-session-selector-options]')
  const createCount = requests.filter(request => request.action === 'create').length
  await staleOwnerInput.click()
  await page.keyboard.press('Enter')
  assert.equal(requests.filter(request => request.action === 'create').length, createCount)
  await staleOwnerInput.fill('worker')
  await page.waitForSelector('[data-session-option="worker/main"]')
  await staleOwnerInput.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert.ok(await page.$('[aria-labelledby="new-task-title"]'))
  await page.click('[aria-labelledby="new-task-title"] [data-session-selector] button')
  await page.locator('[aria-labelledby="new-task-title"] input').fill('Created without stale owner')
  await page.$eval('[aria-labelledby="new-task-title"]', form => form.requestSubmit())
  await page.waitForSelector('[aria-labelledby="new-task-title"]', { hidden: true })
  const noStaleOwnerCreate = requests.filter(request => request.action === 'create').at(-1)
  assert.deepEqual(noStaleOwnerCreate.body, { title: 'Created without stale owner', notifySession: true })
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_tasks_last_owner_v1')), null)
  await page.click('[data-task-row="task-active"] button')
  await page.waitForSelector('[data-task-details] textarea')
  const comment = page.locator('[data-task-details] textarea')
  await comment.fill('User comment')
  await page.click('[data-task-details] button[type="submit"]')
  await page.waitForFunction(() => !document.querySelector('[data-task-details] textarea') || document.querySelector('[data-task-details] textarea')?.value === '')
  const userComment = requests.filter(request => request.action === 'comment').at(-1)
  assert.deepEqual(userComment, {
    pathname: '/prefix/ui/api/tasks/task-active/comments', method: 'POST', action: 'comment',
    body: { note: 'User comment', notifySession: true },
  })
  assert.equal(await page.$eval('[data-task-warning]', node => node.textContent), 'Comment saved, but the owner notification could not be delivered.')
  await page.click('[data-task-details] [data-session-selector-input]')
  await page.click('[data-task-details] [data-session-selector] button')
  await page.click('[data-task-owner-save]')
  await page.waitForFunction(() => document.querySelector('[data-task-warning]')?.textContent === 'Task assigned, but the owner notification could not be delivered.')
  const userAssign = requests.filter(request => request.action === 'assign').at(-1)
  assert.deepEqual(userAssign, {
    pathname: '/prefix/ui/api/tasks/task-active/assign', method: 'POST', action: 'assign',
    body: { ownerSessionId: null, notifySession: true },
  })
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_tasks_last_owner_v1')), null)
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForSelector('[data-task-warning="detail"]')
  assert.equal(await page.$eval('[data-task-warning="detail"]', node => node.textContent), 'Task assigned, but the owner notification could not be delivered.')
  await page.click('[aria-label="Close task details"]')
  await page.setViewport({ width: 1400, height: 900 })
})
