// System on phones over a real C# Main: every section fits the viewport in portrait and
// landscape, in light and dark themes, the section switch stays reachable, and the Usage tables
// scroll inside themselves with their first column kept in view. Desktop keeps its layout.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const EMAIL = ['release.owner', 'example.test'].join('@')
const options = { env: {} }
const fixture = await createHostFixture('system-mobile', options)
options.cwd = process.cwd()
const errors = []
const read = async request => { let body = ''; for await (const chunk of request) body += chunk; return body }
const detector = createServer(async (request, response) => {
  try {
    const { text } = JSON.parse(await read(request))
    const entities = []
    for (let index = text.indexOf(EMAIL); index >= 0; index = text.indexOf(EMAIL, index + EMAIL.length)) {
      const start = Buffer.byteLength(text.slice(0, index))
      entities.push({ start, end: start + Buffer.byteLength(EMAIL), score: 0.97, label: 'private_email' })
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ entities, offset_unit: 'utf8_bytes', input_bytes: Buffer.byteLength(text), input_tokens: text.length }))
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const event = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
const provider = createServer(async (request, response) => {
  try {
    const body = JSON.parse(await read(request))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // A request asking for a tool call runs one command, so Activity has a real row.
    const raw = JSON.stringify(body.input)
    const exec = (body.tools || []).map(tool => tool.name).find(name => /(^|_)exec$/.test(name || ''))
    const output = raw.includes('RUN_TOOL') && !raw.includes('function_call_output') && exec
      ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: exec, arguments: JSON.stringify({ command: 'echo checked-the-release-build-volume-and-artifact-cache', summary: 'Check the release build volume and the artifact cache before the nightly run' }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
    event(response, { type: 'response.completed', response: { id: 'r', status: 'completed', output, usage: { input_tokens: 1_234_000, input_tokens_details: { cached_tokens: 400_000 }, output_tokens: 56_000 } } })
    response.end()
  } catch (error) { errors.push(error.stack); response.destroy() }
})
for (const server of [detector, provider]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
const baseUrl = `http://127.0.0.1:${provider.address().port}`
await writeFile(fixture.modelPath, JSON.stringify({
  default: 'paid/wire',
  providers: {
    paid: { providerType: 'openai-responses', baseUrl, models: [{ id: 'wire', pricing: { cached: 1, input: 2, output: 4 } }], contextLimit: 2000000, asyncCompact: false,
      textRedaction: { enabled: true, endpoint: `http://127.0.0.1:${detector.address().port}/classify`, threshold: 0.5 } },
    free: { providerType: 'openai-responses', baseUrl, models: ['open'], contextLimit: 2000000, asyncCompact: false },
  },
}))
await mkdir(join(fixture.work, 'memory'), { recursive: true })
await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
const LONG = 'nightly-regression-triage-for-the-release-branch'
await writeFile(join(fixture.data, 'state/timers.json'), JSON.stringify({ timers: [
  { id: 'digest', sessionId: LONG, message: 'Post the daily summary of failing suites, flaky tests and open release blockers to the coordinator', cron: '0 9 * * 1-5', newSession: false, createdAt: 1, recentRuns: [{ at: Date.now() - 60_000, outcome: 'delivered' }] },
  { id: 'disk-check', sessionId: 'helper', message: '', action: 'toolscript', script: { code: '# disk check\nprint("checked")', mode: 'foreground', timeoutSecs: 20 }, cron: '*/30 * * * *', createdAt: 2,
    recentRuns: [{ at: Date.now() - 120_000, outcome: 'failed', error: 'Disk probe timed out after 20 seconds on the build volume' }] },
] }))
await appendFile(join(fixture.data, 'state/config.yaml'), `access:
  identities:
    release-alerts-from-continuous-integration:
      token: synthetic-alerts-secret
      surfaces:
        webhook: { session: ${LONG}, verify: { header: cf-webhook-auth }, wake: false }
`)
const shots = process.env.FOXWARM_SYSTEM_SCREENSHOT_DIR
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const route = id => '/api/sessions/' + encodeURIComponent(id)
const day = () => { const now = new Date(); return [new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()] }
const usage = async () => (await fixture.api('GET', `/api/usage?boundaries=${day().join(',')}`)).body
const send = async (id, text) => {
  const before = (await usage()).total.requests
  assert.equal((await fixture.api('POST', route(id) + '/message', { text })).status, 202)
  await until(async () => (await usage()).total.requests > before, 'request recorded for ' + id)
}

// Visible elements that reach past the viewport edge outside a horizontal scroller, plus the
// System scroller's own sideways overflow. A table scroller may be wider than its content box.
const overflow = page => page.evaluate(() => {
  const root = document.querySelector('[data-system-section]')
  const width = document.documentElement.clientWidth
  const scrolls = element => { const style = getComputedStyle(element); return ['auto', 'scroll'].includes(style.overflowX) }
  const describe = element => {
    const data = [...element.attributes].find(attribute => attribute.name.startsWith('data-'))
    return `${element.tagName.toLowerCase()}${data ? `[${data.name}=${data.value}]` : ''} "${(element.textContent || '').trim().slice(0, 30)}"`
  }
  const offenders = []
  for (const element of root.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') continue
    if (rect.right <= width + 1 && rect.left >= -1) continue
    let parent = element.parentElement, scrolled = false
    while (parent && parent !== root) { if (scrolls(parent)) { scrolled = true; break } parent = parent.parentElement }
    if (!scrolled) offenders.push(`${describe(element)} ${Math.round(rect.left)}..${Math.round(rect.right)}`)
  }
  const scroller = root.matches('[data-system-scroll]') ? root : root.querySelector('[data-system-scroll]') || root
  return { width, page: document.scrollingElement.scrollWidth - width, system: Math.max(root.scrollWidth - root.clientWidth, scroller.scrollWidth - scroller.clientWidth), offenders: offenders.slice(0, 12), count: offenders.length }
})
const openSection = async (page, id) => {
  // Webhooks joins the strip once the configured webhook has loaded.
  await page.waitForSelector(`[data-system-tab="${id}"]`)
  await page.$eval(`[data-system-tab="${id}"]`, element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  if (page.viewport()?.hasTouch) await page.tap(`[data-system-tab="${id}"]`)
  else await page.click(`[data-system-tab="${id}"]`)
  await page.waitForSelector(`[data-system-section="${id}"]`)
}
const ready = {
  agents: '[data-system-summary="agents"]',
  sessions: '[data-system-session-list] [data-architecture-session-id]',
  nodes: '[data-node-surface] [data-system-node-table="list"] [data-system-node-id="master"]',
  timers: '[data-system-timer-list] [data-system-timer-id]',
  webhooks: '[data-system-webhook-list] [data-system-webhook-id]',
  activity: '[data-system-section="activity"] [data-activity-row], [data-system-section="activity"] tbody tr, [data-system-section="activity"] li',
  usage: '[data-usage-groups] [data-usage-row-kind]',
}
const failures = []
// Agents: the section subtitle is desktop-header only, there is no separate registry heading, and
// each row carries its rule state: the allowlist Agent shows it, main shows none.
const checkAgents = async (page, label, { phone }) => {
  await page.waitForSelector('[data-architecture-agent-id="release-engineering"]')
  const result = await page.evaluate(() => ({
    subtitles: document.body.innerText.split('Agent workspaces, inheritance and memory.').length - 1,
    registryHeading: document.body.innerText.includes('Agent registry'),
    rows: Object.fromEntries([...document.querySelectorAll('[data-architecture-agent-id]')].map(row => [row.getAttribute('data-architecture-agent-id'), row.textContent])),
  }))
  if (result.subtitles !== (phone ? 0 : 1)) failures.push(`${label} agents: subtitle shown ${result.subtitles} times`)
  if (result.registryHeading) failures.push(`${label} agents: registry heading shown`)
  if (!/Allowlist/.test(result.rows['release-engineering'] || '') || /Allowlist/.test(result.rows.main || '')) failures.push(`${label} agents: rule state ${JSON.stringify(result.rows)}`)
}
// A tap on a row opens its details as a page that starts at its top, and Back returns to the list.
const checkDetailPage = async (page, label, row, detail) => {
  await page.$eval('[data-system-scroll]', scroller => { scroller.scrollTop = scroller.scrollHeight })
  await page.$eval(row, element => element.scrollIntoView({ block: 'center' }))
  await page.tap(row)
  const opened = await page.waitForSelector(`[data-system-split-layout="detail"] ${detail}`, { timeout: 5000 }).catch(() => null)
  if (!opened) { failures.push(`${label}: ${row} opened no detail page`); return }
  await new Promise(resolve => setTimeout(resolve, 300))
  const box = await page.$eval(detail, element => { const rect = element.getBoundingClientRect(); return { top: rect.top, header: document.querySelector('[data-mobile-page-header]')?.getBoundingClientRect().bottom ?? 0, height: innerHeight } })
  if (box.top < box.header - 1 || box.top > box.height / 2) failures.push(`${label}: ${detail} starts at ${Math.round(box.top)} (header ends ${Math.round(box.header)})`)
  await page.tap('[data-system-split-back]')
  if (!await page.waitForSelector('[data-system-split-layout="list"]', { timeout: 5000 }).catch(() => null)) failures.push(`${label}: Back did not return to the list`)
}
// Each Usage table scrolls inside itself; its first column stays in view at either end.
const checkTables = async (page, label) => {
  for (const table of ['[data-usage-groups]', '[data-usage-redaction]']) {
    if (!await page.waitForSelector(`${table} [data-usage-table-scroll]`, { timeout: 5000 }).catch(() => null)) { failures.push(`${label} ${table}: no table scroller`); continue }
    const result = await page.$eval(`${table} [data-usage-table-scroll]`, scroller => {
      const width = document.documentElement.clientWidth
      const header = document.querySelector('[data-mobile-page-header]')?.getBoundingClientRect().bottom ?? 0
      scroller.scrollIntoView({ block: 'center' })
      const box = scroller.getBoundingClientRect()
      const first = () => scroller.querySelector('tbody tr td').getBoundingClientRect()
      const start = first()
      scroller.scrollLeft = scroller.scrollWidth
      const end = first()
      scroller.scrollLeft = 0
      return { box: [box.left, box.right], width, header, top: start.top, start: [start.left, start.right], end: [end.left, end.right] }
    })
    if (result.box[0] < 0 || result.box[1] > result.width + 1) failures.push(`${label} ${table}: scroller ${result.box.map(Math.round)} outside ${result.width}`)
    if (result.start[1] - result.start[0] < 100) failures.push(`${label} ${table}: first column only ${Math.round(result.start[1] - result.start[0])}px`)
    if (Math.abs(result.end[0] - result.start[0]) > 1) failures.push(`${label} ${table}: first column moved ${Math.round(result.start[0])} -> ${Math.round(result.end[0])}`)
    if (result.top < result.header) failures.push(`${label} ${table}: first row under the header`)
    if (shots) await (await page.$(table)).screenshot({ path: join(shots, `phone-${label.replace(' ', '-')}-${table.slice(6, -1)}.png`) })
  }
}

try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'release-engineering' })).status, 201)
  // A trailing deny without selectors makes the Agent's layer an allowlist, shown on its row.
  assert.equal((await fixture.api('PUT', '/api/agents/release-engineering', { rules: [{ id: 'deny-everything-else', action: 'deny' }] })).status, 200)
  const ids = {}
  for (const [agentId, sessionId, parent] of [['main', LONG], ['main', 'helper', LONG], ['release-engineering', 'changelog-and-migration-notes-writer']]) {
    const created = await fixture.api('POST', '/api/sessions', { agentId, sessionId, ...(parent ? { parentSessionId: ids[parent] } : {}) })
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body))
    ids[sessionId] = created.body.sessionId || created.body.id || sessionId
  }
  assert.equal((await fixture.api('POST', route(ids['changelog-and-migration-notes-writer']) + '/model', { model: 'free/open' })).status, 200)
  await send(ids[LONG], `Triage the failures and mail ${EMAIL}`)
  await send(ids.helper, `Collect the logs for ${EMAIL}`)
  await send(ids['changelog-and-migration-notes-writer'], 'Draft the notes')
  await send(ids.helper, 'RUN_TOOL check the build volume')
  await until(async () => JSON.stringify((await fixture.api('POST', '/api/activity', { limit: 100 })).body?.items || []).includes('artifact cache'), 'tool call recorded in activity')

  const page = await fixture.openApp()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.evaluate(() => localStorage.setItem('foxwarm.systemUsage.period', 'today'))

  const views = [
    { name: 'portrait-360', width: 360, height: 780 },
    { name: 'portrait-390', width: 390, height: 844 },
    { name: 'landscape-844', width: 844, height: 390 },
  ]
  for (const theme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
    for (const view of views) {
      await page.setViewport({ width: view.width, height: view.height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      await page.reload({ waitUntil: 'networkidle0' })
      await waitForWebUiReady(page)
      await page.evaluate(() => { location.hash = 'system' })
      await page.waitForSelector('[data-system-section]')
      for (const section of ['agents', 'sessions', 'nodes', 'timers', 'webhooks', 'activity', 'usage']) {
        await openSection(page, section)
        await page.waitForSelector(ready[section]).catch(() => failures.push(`${theme} ${view.name} ${section}: content did not load`))
        const result = await overflow(page)
        if (result.page > 0 || result.system > 0 || result.count) failures.push(`${theme} ${view.name} ${section}: page +${result.page}px, system +${result.system}px, ${result.count} outside: ${result.offenders.join('; ')}`)
        if (view.name !== 'landscape-844' || section === 'usage') await shot(page, `phone-${theme}-${view.name}-${section}.png`)
        if (view.name.startsWith('portrait')) {
          // The selected section is fully visible in the strip, which scrolls rather than the page.
          const tab = await page.$eval('[data-system-tab][aria-selected="true"]', element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth } })
          if (tab.left < 0 || tab.right > tab.width) failures.push(`${theme} ${view.name} ${section}: selected tab ${Math.round(tab.left)}..${Math.round(tab.right)}`)
        }
        if (section === 'usage' && view.name.startsWith('portrait')) await checkTables(page, `${theme} ${view.name}`)
        if (section === 'agents') await checkAgents(page, `${theme} ${view.name}`, { phone: view.width < 768 })
        if (view.name === 'portrait-390' && section === 'agents') await checkDetailPage(page, `${theme} ${view.name} agents`, '[data-architecture-agent-id="release-engineering"]', '[data-architecture-agent-inspector-id="release-engineering"]')
        if (view.name === 'portrait-390' && section === 'sessions') await checkDetailPage(page, `${theme} ${view.name} sessions`, '[data-architecture-session-id$="changelog-and-migration-notes-writer"]', '[data-architecture-inspector-session-id]')
      }
    }
  }

  if (failures.length) console.log('PHONE LAYOUT FAILURES\n' + failures.join('\n'))

  // Desktop keeps the wide layout: the tab strip in one row and the usage table without a scroller.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await page.setViewport({ width: 1500, height: 1000 })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForWebUiReady(page)
  await page.evaluate(() => { location.hash = 'system' })
  await page.waitForSelector('[data-system-section]')
  await openSection(page, 'agents')
  await page.waitForSelector('[data-architecture-agent-id="release-engineering"]')
  await checkAgents(page, 'desktop', { phone: false })
  await openSection(page, 'usage')
  await page.waitForSelector(ready.usage)
  await shot(page, 'desktop-light-usage.png')
  await openSection(page, 'sessions')
  await shot(page, 'desktop-light-sessions.png')

  assert.deepEqual(failures, [])
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(errors, [])
  console.log('System phone layout e2e passed')
} finally {
  await fixture.cleanup()
  for (const server of [detector, provider]) server.close()
}
