#!/usr/bin/env node
// Real normal-startup hosts with owned data; no browser, external Node or model calls.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture } from '../../packages/webui/test/experimentHostFixture.mjs'

const results = { runtime: 'managed', checks: [], observations: [] }
const fallbackUrl = 'https://browser.example/browser/'
const explicitUrl = 'https://explicit.example/node/'
for (const scenario of [
  { name: 'normal browser fallback' },
  { name: 'empty environment override', override: '' },
  { name: 'empty environment suppresses configured address', override: '', configured: true },
  { name: 'configured public address', configured: true },
]) {
  const env = { FOXWARM_BIND_ADDRESS: '127.0.0.1', FOXWARM_PUBLIC_BASE_URL: scenario.override }
  const f = await createHostFixture('onboarding-empty-override', { normalStartup: true, env })
  env.FOXWARM_AGENTS_DIR = join(f.root, 'agents')
  const prefix = scenario.configured && scenario.override !== '' ? '/mount' : ''
  const expected = prefix ? 'https://configured.example/mount' : fallbackUrl.replace(/\/$/, '')
  const post = (route, body) => f.api('POST', prefix + '/api/nodes/onboarding/' + route, body)
  const check = async (name, action) => {
    try { await action(); results.checks.push({ scenario: scenario.name, name, passed: true }) }
    catch (error) { results.checks.push({ scenario: scenario.name, name, passed: false, error: error.message }) }
  }
  try {
    await writeFile(join(f.data, 'state/config.yaml'), `bot:\n  httpPort: ${f.port}\n` + (scenario.configured ? 'url: https://configured.example/mount\n' : ''))
    await f.start()
    results.observations.push({ scenario: scenario.name, startup: 'ready', routePrefix: prefix })
    await check('initial browser-shaped command suggestion', async () => {
      const response = await post('commands', { fallbackUrl })
      results.observations.push({ scenario: scenario.name, request: 'commands fallback', status: response.status, baseUrl: response.body.baseUrl, error: response.body.error })
      assert.equal(response.status, 200)
      assert.equal(response.body.baseUrl, expected)
      assert(response.body.commands.bareMetal.includes(expected + '/node/run.sh'))
    })
    await check('explicit valid address wins', async () => {
      const response = await post('commands', { fallbackUrl, baseUrl: explicitUrl })
      assert.equal(response.status, 200)
      assert.equal(response.body.baseUrl, explicitUrl.replace(/\/$/, ''))
    })
    await check('invalid explicit addresses fail before shell credential creation', async () => {
      for (const baseUrl of ['', null, 'https://invalid.example/?query']) {
        assert.equal((await post('commands', { fallbackUrl, baseUrl })).status, 400)
        assert.equal((await post('create-shell', { fallbackUrl, baseUrl, nodeId: 'explicit-shell' })).status, 400)
      }
      // Reusing the ID through the normal API proves rejected URLs did not reserve it.
      const response = await post('create-shell', { fallbackUrl, baseUrl: explicitUrl, nodeId: 'explicit-shell' })
      assert.equal(response.status, 200)
      assert(response.body.command.includes(explicitUrl.replace(/\/$/, '') + '/node/run-shell.sh'))
      assert(response.body.command.includes("--host='https://explicit.example/node'"))
    })
    await check('shell creation uses the same fallback selection', async () => {
      const response = await post('create-shell', { fallbackUrl, nodeId: 'fallback-shell' })
      results.observations.push({ scenario: scenario.name, request: 'create-shell fallback', status: response.status, usesExpectedAddress: response.body.command?.includes(expected + '/node/run-shell.sh'), error: response.body.error })
      assert.equal(response.status, 200)
      assert(response.body.command.includes(expected + '/node/run-shell.sh'))
      assert(response.body.command.includes("--host='" + expected + "'"))
    })
    await f.stop()
  } finally { await f.cleanup() }
}
console.log(JSON.stringify(results, null, 2))
if (results.checks.some(check => !check.passed)) process.exitCode = 1
