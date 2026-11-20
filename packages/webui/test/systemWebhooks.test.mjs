import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/systemWebhooks.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { isLocalWebhookUrl, orderWebhooks, webhookActionLabel, webhookDeliveryTitle, webhookOutcomeTone, webhookVerifyLabel } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const row = (id, patch = {}) => ({
  id, url: `https://example.test/webhooks/${id}`, session: 'ops/main', targetSessionId: 'ops/main', verify: 'bearer', events: [],
  action: 'message', wake: true, pending: 0, unauthorized: 0, deliveries: [], ...patch,
})

test('labels describe verification, action and delivery', () => {
  assert.equal(webhookVerifyLabel({ verify: 'github' }), 'GitHub signature')
  assert.equal(webhookVerifyLabel({ verify: 'header', header: 'cf-webhook-auth' }), 'Secret in cf-webhook-auth')
  assert.equal(webhookVerifyLabel({ verify: 'bearer' }), 'Bearer token')
  assert.equal(webhookActionLabel({ action: 'message', wake: true }), 'Message the session')
  assert.equal(webhookActionLabel({ action: 'message', wake: false }), 'Message the session without waking it')
  assert.equal(webhookActionLabel({ action: 'toolscript', wake: true }), 'Run a ToolScript handler')
  assert.equal(webhookDeliveryTitle({ event: 'pull_request', action: 'opened' }), 'pull_request · opened')
  assert.equal(webhookDeliveryTitle({}), '')
})

test('outcome tones separate success, failure, waiting and noise', () => {
  assert.deepEqual(['delivered', 'completed', 'failed', 'rejected', 'unavailable', 'rate-limited', 'queued', 'ignored', 'duplicate', 'unknown'].map(webhookOutcomeTone),
    ['success', 'success', 'danger', 'danger', 'danger', 'warning', 'active', 'muted', 'muted', 'muted'])
})

test('loopback addresses are recognized as unreachable from outside', () => {
  assert.equal(isLocalWebhookUrl('http://127.0.0.1:3001/webhooks/a'), true)
  assert.equal(isLocalWebhookUrl('http://localhost/webhooks/a'), true)
  assert.equal(isLocalWebhookUrl('http://[::1]:3001/webhooks/a'), true)
  assert.equal(isLocalWebhookUrl('https://foxwarm.example/base/webhooks/a'), false)
  assert.equal(isLocalWebhookUrl('not a url'), false)
})

test('webhooks needing attention come first', () => {
  const rows = [
    row('b'),
    row('a'),
    row('missing', { targetSessionId: null }),
    row('failing', { deliveries: [{ at: 2, outcome: 'failed', status: 202 }, { at: 1, outcome: 'completed', status: 202 }] }),
    row('recovered', { deliveries: [{ at: 2, outcome: 'completed', status: 202 }, { at: 1, outcome: 'failed', status: 202 }] }),
  ]
  assert.deepEqual(orderWebhooks(rows).map(item => item.id), ['failing', 'missing', 'a', 'b', 'recovered'])
})
