import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, url, page
const dockEntry = new URL('../src/components/QuestionCard.tsx', import.meta.url).pathname
const noticeEntry = new URL('../src/components/ApprovalCard.tsx', import.meta.url).pathname
const stateEntry = new URL('../src/sessionQuestionsState.ts', import.meta.url).pathname
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QuestionDock } from ${JSON.stringify(dockEntry)}
import { ToolApprovalNotice } from ${JSON.stringify(noticeEntry)}
import { SessionQuestionsContext } from ${JSON.stringify(stateEntry)}

const pending = (id, extra) => ({ id, status: 'pending', createdAt: 1, origin: 'turn', tool: { source: 'node', name: 'exec', executionNode: 'build-box' }, summary: 'rm -rf build', rules: [{ layer: 'global', id: 'confirm-exec', reason: 'Commands on shared hosts' }], approvers: [], ...extra })
const approvals = [
  pending('ap-large', { canDecide: true, argsTruncated: true, argsPreview: '{"command":"rm -rf build', expiresAt: Date.now() + 4 * 60_000, facts: { paths: [{ raw: 'build', resolved: '/w/build', node: 'build-box' }] } }),
  pending('ap-other', { canDecide: false, tool: { source: 'mcp', server: 'tracker', name: 'close_issue' }, summary: 'close #12', args: { issue: 12 } }),
]
const question = { id: 'q-1', status: 'open', questions: [{ question: 'Which branch?' }] }
window.decisions = []
function Fixture() {
  const [records, setRecords] = React.useState(approvals)
  const [dockRequest, setDockRequest] = React.useState(null)
  const value = {
    sessionId: 's-1',
    view: null,
    byId: new Map([[question.id, question]]),
    open: [question],
    waitingIds: new Set(),
    approvals: records,
    approvalById: new Map(records.map(record => [record.id, record])),
    approvalByCallId: new Map(),
    submit: async () => {},
    decide: async (id, body) => {
      window.decisions.push({ id, body })
      setRecords(current => current.filter(record => record.id !== id))
    },
    reload: () => {},
    dockRequest,
    requestDock: id => setDockRequest(current => ({ questionId: id, nonce: (current?.nonce ?? 0) + 1 })),
  }
  return React.createElement(SessionQuestionsContext.Provider, { value }, React.createElement(QuestionDock, {}))
}
createRoot(document.getElementById('dock')).render(React.createElement(Fixture))
createRoot(document.getElementById('notices')).render(React.createElement(React.Fragment, null,
  React.createElement(ToolApprovalNotice, { approval: { id: 'ap-a', status: 'approved', decidedBy: { kind: 'identity', id: 'reviewer' }, note: 'only this once' } }),
  React.createElement(ToolApprovalNotice, { approval: { id: 'ap-r', status: 'rejected', decidedBy: { kind: 'administrator' } } }),
))
`

before(async () => {
  const result = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'approval-dock-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  const script = result.outputFiles[0].text
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'Build the WebUI before running browser styling tests')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  server = createServer((request, response) => {
    if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return }
    if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); return }
    if (request.url === '/api/sessions/s-1/approvals/ap-large') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ sessionId: 's-1', approval: { id: 'ap-large' }, args: { command: 'rm -rf build && echo complete-tail' } }))
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:system-ui;max-width:650px}</style><div id="dock"></div><div id="notices"></div><script src="/fixture.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage()
}, { timeout: 30000 })

after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

test('pending approvals open the dock first and decide with the note', async () => {
  await page.goto(url)
  await page.waitForSelector('[data-approval-form="ap-large"]')
  const dock = await page.$eval('[data-question-dock]', el => el.innerText)
  assert.match(dock, /3 open requests/)
  assert.match(dock, /Waiting for approval/)
  assert.deepEqual(await page.$$eval('[role="tab"]', tabs => tabs.map(tab => tab.dataset.dockItem)), ['approval', 'approval', 'question'])
  const form = await page.$eval('[data-approval-form="ap-large"]', el => el.innerText)
  assert.match(form, /exec/)
  assert.match(form, /on build-box/)
  assert.match(form, /rm -rf build/)
  assert.match(form, /build-box:\/w\/build/)
  assert.match(form, /Rule confirm-exec — Commands on shared hosts/)
  assert.match(await page.$eval('[data-approval-deadline]', el => el.textContent), /^4m left$/)

  await page.click('[data-approval-form="ap-large"] button[aria-expanded]')
  assert.equal(await page.$eval('[data-approval-args]', el => el.textContent), '{"command":"rm -rf build…')
  await page.click('[data-approval-args-full]')
  await page.waitForFunction(() => document.querySelector('[data-approval-args]')?.textContent.includes('complete-tail'))
  assert.equal(await page.$('[data-approval-args-full]'), null)

  await page.type('[data-approval-form="ap-large"] textarea', '  only this once ')
  await page.click('[data-approval-decision="approve"]')
  await page.waitForFunction(() => window.decisions.length === 1)
  assert.deepEqual(await page.evaluate(() => window.decisions), [{ id: 'ap-large', body: { decision: 'approve', note: 'only this once' } }])
})

test('an identity that cannot decide sees the request without decision controls', async () => {
  await page.waitForSelector('[data-approval-form="ap-other"]')
  const form = await page.$eval('[data-approval-form="ap-other"]', el => el.innerText)
  assert.match(form, /tracker · close_issue/)
  assert.match(form, /Waiting for an approver\./)
  assert.equal(await page.$('[data-approval-form="ap-other"] [data-approval-decision]'), null)
  assert.match(await page.$eval('[data-question-dock]', el => el.innerText), /2 open requests/)
})

test('timeline notices summarize settled approvals with their note', async () => {
  const notices = await page.$$eval('[data-tool-approval]', els => els.map(el => [el.dataset.toolApproval, el.innerText.replace(/\s+/g, ' ').trim()]))
  assert.deepEqual(notices, [['approved', 'Approved by reviewer · only this once'], ['rejected', 'Rejected']])
})
