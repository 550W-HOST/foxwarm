import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

// Exercise the exact assets in the WebUI output. The managed operator/replica test
// separately verifies routing, authentication, grants and transitions on real servers.
test('operator console signs in, edits limits and journal, follows placement and suspends and resumes', async () => {
  const requests = [],
    bearer = 'operator-browser-test'
  let state = 'active',
    recording = false,
    retention = null
  let limits = '{"agentFileBytes":9223372036854775807}'
  const server = createServer(async (req, res) => {
    const files = {
      '/': ['index.html', 'text/html'],
      '/operator/console.js': ['console.js', 'text/javascript'],
      '/operator/console.css': ['console.css', 'text/css'],
    }
    if (Object.hasOwn(files, req.url)) {
      const [file, mime] = files[req.url]
      res.writeHead(200, { 'content-type': mime })
      res.end(await readFile(new URL(`../dist/operator/${file}`, import.meta.url)))
      return
    }
    if (!req.url.startsWith('/operator/v1/')) {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      method: req.method,
      body,
    })
    if (req.headers.authorization !== `Bearer ${bearer}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"An operator bearer token is required."}')
      return
    }
    const path = req.url.slice('/operator/v1/'.length)
    res.setHeader('content-type', 'application/json')
    if (path === 'tenants') {
      res.end(
        `[{"slug":"alpha","state":"${state}","profile":"hosted","limits":${limits},"journal":{"enabled":${recording},"retentionDays":${retention}}}]`,
      )
      return
    }
    if (path === 'placement') {
      res.end(
        JSON.stringify({
          tenants: [
            {
              slug: 'alpha',
              owner: 'general-replica-2',
              hot: 2,
              busy: 1,
              providerProblems: {
                pool: 'tenancy-mismatch',
                child: 'parent-not-granted',
                future: 'new-diagnostic',
              },
            },
          ],
          replicas: [
            {
              name: 'general-replica-2',
              role: 'general',
              version: 'test',
              draining: false,
              heartbeatAt: '2025-01-01T01:00Z',
            },
          ],
        }),
      )
      return
    }
    if (path === 'tenants/alpha' && req.method === 'PATCH') {
      const patch = JSON.parse(body)
      if (patch.journal) {
        recording = patch.journal.enabled
        retention = patch.journal.retentionDays
      }
      if (patch.limits) limits = body.match(/"limits":(\{[^}]+\})/)[1]
      res.end('{}')
      return
    }
    if (path === 'tenants/alpha/suspend' || path === 'tenants/alpha/resume') {
      state = path.endsWith('resume') ? 'active' : 'suspended'
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
    })
    const origin = `http://127.0.0.1:${server.address().port}`,
      page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844 })
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(origin)
    await page.type('#token', 'wrong')
    await page.click('#access button')
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('required'))
    await page.type('#token', bearer)
    await page.click('#access button')
    await page.waitForSelector('#tenantRows button', { visible: true })
    const lineCount = (cell) => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      return range.getClientRects().length
    }
    assert.equal(await page.$eval('#tenantRows td:nth-child(3)', lineCount), 1)
    await page.click('#tenantRows button')
    assert.deepEqual(await page.$$eval('#providerStatus li', (items) => items.map((item) => item.textContent)), [
      'pool: tenancy mismatch',
      'child: parent Provider not granted',
      'future: new-diagnostic',
    ])
    assert.equal(await page.$eval('#retentionMode', (e) => e.value), 'unlimited')
    await page.select('#recording', 'true')
    await page.type('#limits label:first-child input', '4')
    await page.click('#save')
    await page.waitForFunction(() => document.querySelector('#notice').textContent === 'Settings saved.')
    assert.match(requests.find((r) => r.method === 'PATCH').body, /"agentFileBytes":9223372036854775807/)
    assert.equal(recording, true)
    assert.equal(retention, null)
    await page.select('#retentionMode', 'days')
    await page.type('#retention', '14')
    await page.click('#save')
    await page.waitForFunction(
      () =>
        document.querySelector('#notice').textContent === 'Settings saved.' &&
        document.querySelector('#retention').value === '14',
    )
    assert.equal(retention, 14)
    await page.click('#stateAction')
    await page.waitForFunction(() => document.querySelector('#stateAction').textContent === 'Resume tenant')
    await page.click('#stateAction')
    await page.waitForFunction(() => document.querySelector('#stateAction').textContent === 'Suspend tenant')
    await page.click('#showReplicas')
    assert.equal(await page.$eval('#replicaRows tr td', (e) => e.textContent), 'general-replica-2')
    assert.equal(await page.$eval('#replicaRows tr td', lineCount), 1)
    assert.equal(await page.$eval('#detail', (e) => e.hidden), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0)
    assert.equal((await page.cookies()).length, 0)
    assert.equal(
      requests.some((r) => r.url.includes(bearer) || r.cookie),
      false,
    )
    await page.click('#signout')
    assert.equal(await page.$eval('#workspace', (e) => e.hidden), true)
    assert.equal(await page.$eval('#token', (e) => e.value), '')
    await page.reload()
    assert.equal(await page.$eval('#signin', (e) => e.hidden), false)
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
