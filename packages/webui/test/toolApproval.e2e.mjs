import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHostFixture, until } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()

const shots = process.env.FOXWARM_TOOL_APPROVAL_SCREENSHOTS
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
// Finishing a turn can re-render its activity collapsed, so expand collapsed activities until
// the approval notice itself is rendered rather than expanding once.
const revealApproval = (page, selector) => until(async () => {
  const found = await page.$(selector)
  if (found) return found
  await page.$$eval('[data-timeline-activity] [data-activity-toggle="top"][aria-expanded="false"]', buttons => buttons.forEach(button => button.click()))
  return null
}, selector)
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'APPROVAL-DONE-' + key }] }]

test('a scoped approver reviews and decides tool calls that match an ask rule', { timeout: 180000 }, async () => {
  const fixture = await createHostFixture('tool-approval')
  const plans = new Map(), rounds = new Map(), inputs = new Map(), errors = []
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw)
      const text = JSON.stringify(body.input || [])
      const key = [...text.matchAll(/APPROVAL:([\w-]+)/g)].at(-1)?.[1]
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      inputs.set(key, [...(inputs.get(key) || []), text])
      const output = plans.get(key)?.[round] || final(key)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const reviewerToken = 'synthetic-approval-reviewer', viewerToken = 'synthetic-approval-viewer'
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: tool-approval-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\naccess:\n  identities:\n    reviewer:\n      token: ${reviewerToken}\n      surfaces:\n        webui: {sessions: [gated]}\n    viewer:\n      token: ${viewerToken}\n      surfaces:\n        webui: {sessions: [gated]}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(join(fixture.data, 'state/tool-authorization.yaml'), 'version: 1\ndefaultAction: allow\nrules:\n  - id: confirm-write\n    tool: {source: node, name: write}\n    action: ask\n    reason: Writes need a decision.\n    approval: {approvers: [reviewer]}\n')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, models: ['wire'] } } }))
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const view = async id => (await fixture.api('GET', route(id) + '/questions')).body
  const session = async id => (await fixture.api('GET', route(id) + '/history')).body.session
  async function send(id, key, steps) {
    plans.set(key, steps); rounds.set(key, 0)
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'APPROVAL:' + key })
    assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
  }
  const pendingApproval = async id => until(async () => (await view(id)).approvals?.find(record => record.status === 'pending'), 'pending approval')
  const screenshot = async (page, name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }) } }
  try {
    await fixture.start()
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'gated' })
    assert.equal(created.status, 200, JSON.stringify(created))
    const gated = created.body.sessionId

    await send(gated, 'approve', [[call('write-1', 'write', { filePath: 'approved.txt', content: 'approved content' })]])
    const first = await pendingApproval(gated)
    assert.equal(first.toolCallId, 'write-1')
    assert.deepEqual(first.approvers, ['reviewer'])
    await until(async () => (await session(gated)).runtimeState?.tool?.approval?.id === first.id, 'runtime names the pending approval')
    assert.equal(existsSync(join(fixture.work, 'approved.txt')), false)

    // A scoped identity that the rule does not name can see the request but not decide it.
    const viewerDecision = await fetch(fixture.origin + route(gated) + '/approvals/' + first.id, { method: 'POST', headers: { authorization: 'Bearer ' + viewerToken, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) })
    assert.equal(viewerDecision.status, 403)

    const page = await fixture.openApp(reviewerToken)
    await page.setViewport({ width: 1280, height: 860 })
    // A browser identity scoped to one Session opens it directly.
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]')
    const form = `[data-question-dock] [data-approval-form="${first.id}"]`
    await page.waitForSelector(form)
    const review = await page.$eval(form, node => node.innerText)
    assert.match(review, /write/)
    assert.match(review, /approved\.txt/)
    assert.match(review, /Rule confirm-write — Writes need a decision\./)
    await screenshot(page, 'approval-dock')
    assert.doesNotMatch(review, /Node master/)
    // The waiting call in the timeline offers a shortcut back to the request.
    await revealApproval(page, '[data-tool-approval="pending"] [data-tool-approval-review]')

    await page.type(`${form} textarea`, 'Only in the workspace.')
    await page.click(`${form} [data-approval-decision="approve"]`)
    await until(async () => existsSync(join(fixture.work, 'approved.txt')), 'approved write ran')
    await until(async () => (inputs.get('approve') || []).length >= 2, 'result reached the model')
    assert.match(inputs.get('approve')[1], /approvalNote/)
    assert.match(inputs.get('approve')[1], /Only in the workspace\./)
    const approved = (await view(gated)).approvals.find(record => record.id === first.id)
    assert.equal(approved.status, 'approved')
    assert.deepEqual(approved.decidedBy, { kind: 'identity', id: 'reviewer' })
    const notice = await revealApproval(page, '[data-tool-approval="approved"]')
    assert.match(await notice.evaluate(node => node.innerText.replace(/\s+/g, ' ')), /Approved by reviewer · Only in the workspace\./)
    await page.waitForSelector('[data-question-dock]', { hidden: true })

    // A rejection never runs the call and returns the note to the model.
    await send(gated, 'reject', [[call('write-2', 'write', { filePath: 'rejected.txt', content: 'no' })]])
    const second = await pendingApproval(gated)
    const rejectForm = `[data-question-dock] [data-approval-form="${second.id}"]`
    await page.waitForSelector(rejectForm)
    await page.type(`${rejectForm} textarea`, 'Use the staging copy.')
    await page.click(`${rejectForm} [data-approval-decision="reject"]`)
    await until(async () => (inputs.get('reject') || []).length >= 2, 'rejection reached the model')
    assert.match(inputs.get('reject')[1], /tool_approval_rejected/)
    assert.match(inputs.get('reject')[1], /Use the staging copy\./)
    assert.equal(existsSync(join(fixture.work, 'rejected.txt')), false)
    await revealApproval(page, '[data-tool-approval="rejected"]')
    await screenshot(page, 'approval-rejected')

    // Stop settles a waiting request as cancelled; the call never runs.
    await send(gated, 'stop', [[call('write-3', 'write', { filePath: 'later.txt', content: 'later' })]])
    const third = await pendingApproval(gated)
    await page.waitForSelector(`[data-question-dock] [data-approval-form="${third.id}"]`)
    const stopped = await fixture.api('POST', route(gated) + '/stop', {})
    assert([200, 202].includes(stopped.status), JSON.stringify(stopped))
    await until(async () => (await view(gated)).approvals.find(record => record.id === third.id)?.status === 'cancelled', 'Stop cancels the request')
    await page.waitForSelector('[data-question-dock]', { hidden: true })
    assert.equal(existsSync(join(fixture.work, 'later.txt')), false)
    assert.deepEqual(errors, [])
  } finally {
    model.close()
    await fixture.cleanup()
  }
})
