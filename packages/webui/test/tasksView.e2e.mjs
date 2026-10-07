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
const requests = []

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
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/prefix/ui/api/session-list/search') {
      return json(response, { sessions: [
        { id: 'worker/main', agent: 'worker', displayName: 'Worker' },
        { id: 'other/main', agent: 'other', displayName: 'Other' },
      ] })
    }
    if (url.pathname === '/prefix/ui/api/session-list/by-id') {
      return json(response, { results: [{ requestedId: 'worker/main', session: { id: 'worker/main', agent: 'worker', displayName: 'Worker' } }] })
    }
    if (url.pathname === '/prefix/ui/api/tasks' && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'create' })
      return json(response, { task: { ...task('open'), id: 'task-user', title: 'Created from WebUI', createdByKind: 'user', createdBySessionId: null, ownerSessionId: 'worker/main' } }, 201)
    }
    if (url.pathname.endsWith('/comments') && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'comment' })
      return json(response, { task: task('active') })
    }
    if (url.pathname.endsWith('/assign') && request.method === 'POST') {
      requests.push({ pathname: url.pathname, method: request.method, action: 'assign' })
      return json(response, { task: { ...task('active'), ownerSessionId: 'worker/main' } })
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
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 4)
  assert.match(await page.$eval('[data-task-row="task-open"]', row => row.textContent), /Unassigned.*creator\/main/)
  assert.deepEqual(await page.$eval('[data-task-row="task-active"] td:nth-child(3)', cell => ({ whiteSpace: getComputedStyle(cell).whiteSpace, wideEnough: cell.getBoundingClientRect().width >= 256 })), { whiteSpace: 'nowrap', wideEnough: true })
  assert.match(await page.$eval('[data-tasks-view]', element => element.textContent), /4 tasks shown · 4 more tasks/)
  assert.match(await page.$eval('[data-task-filters]', element => element.textContent), /Agent.*Relationship/)
  assert.deepEqual(await page.$$eval('[data-task-agent-filter] option', options => options.map(option => option.value)), ['', 'creator', 'worker'])
  await page.select('[data-task-agent-filter]', 'worker')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 3)
  await page.select('[data-task-agent-relation]', 'creator')
  assert.equal(await page.$$eval('[data-task-row]', rows => rows.length), 0)
  await page.select('[data-task-agent-relation]', 'owner')
  assert.match(await page.$eval('[data-tasks-view]', element => element.textContent), /3 tasks shown · 1 hidden by the Agent filter · 4 more tasks not loaded/)
  await page.select('[data-task-agent-filter]', '')
  assert.deepEqual(requests.filter(request => request.status).map(request => [request.status, request.limit]), statuses.map(status => [status, '50']))
  assert.ok(requests.every(request => request.method === 'GET' && request.pathname.startsWith('/prefix/ui/api/tasks')))
  await click('Board')
  assert.deepEqual(await page.$$eval('[data-task-column]', columns => columns.map(column => column.dataset.taskColumn)), statuses)
  for (const status of statuses) {
    assert.equal(await page.$$eval(`[data-task-column="${status}"] [data-task-card]`, cards => cards.length), 1)
    assert.match(await page.$eval(`[data-task-card="task-${status}"]`, card => card.textContent), new RegExp(`task-${status}`))
  }
  await page.click('[data-task-card="task-completed"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details] h4')?.textContent === 'completed task')
  assert.match(await page.$eval('[data-task-details]', detail => detail.textContent), /Task details.*completed task.*Description.*A small task.*Parent.*task-parent.*Owner.*worker\/main.*Result.*The result is ready\..*2 more child tasks.*3 more notes/s)
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
  assert.ok(userCreate)
  await page.click('[data-task-row="task-active"] button')
  await page.waitForSelector('[data-task-details] textarea')
  const comment = page.locator('[data-task-details] textarea')
  await comment.fill('User comment')
  await page.click('[data-task-details] button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('[data-task-details] textarea')?.value === '')
  await page.click('[data-task-details] [data-session-selector-input]')
  await page.locator('[data-task-details] [data-session-selector-input]').fill('other')
  await page.waitForSelector('[data-session-option="other/main"]')
  await page.click('[data-session-option="other/main"]')
  await page.click('[data-task-owner-save]')
  await page.waitForFunction(() => (document.querySelector('[data-task-owner-save]'))?.hasAttribute('disabled'))
  assert.ok(requests.some(request => request.action === 'comment'))
  assert.ok(requests.some(request => request.action === 'assign'))
})
