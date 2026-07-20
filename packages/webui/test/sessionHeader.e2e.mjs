import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)
const embedNonce = 'session-header-e2e-nonce-0123456789'

let browser
let token
let cwdSession

async function authenticate(page, viewport) {
  await page.setViewport(viewport)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!localStorage.getItem('foxwarm_token'), { timeout: 15_000 })
  await page.evaluate(() => history.replaceState(null, '', location.pathname))
  await page.reload({ waitUntil: 'networkidle2' })
}

async function expectHeaderSubtitle(page) {
  const expected = `session ${cwdSession.id} · ${cwdSession.cwd}`
  await page.waitForFunction((value) => document.querySelector('[data-session-header-subtitle]')?.textContent === value, { timeout: 15_000 }, expected)
  const subtitle = await page.$eval('[data-session-header-subtitle]', (element) => ({
    text: element.textContent,
    title: element.getAttribute('title'),
  }))
  assert.deepEqual(subtitle, { text: expected, title: cwdSession.cwd })
}

async function expectCwdSearchWithoutRowDisplay(page) {
  const search = await page.waitForSelector('input[placeholder="Search sessions"]', { timeout: 15_000 })
  await search.click({ clickCount: 3 })
  await search.type(cwdSession.cwd)
  await page.waitForFunction((sessionId) => !!document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`), { timeout: 10_000 }, cwdSession.id)
  const rowText = await page.$eval(`[data-session-id=${JSON.stringify(cwdSession.id)}]`, (row) => row.textContent || '')
  assert.equal(rowText.includes(cwdSession.cwd), false)
  assert.equal(rowText.includes('cwd:'), false)
}

before(async () => {
  token = (await readFile(tokenFile, 'utf8')).trim()
  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  try {
    await authenticate(page, { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
    const sessions = await page.evaluate(async () => (await (await fetch('./api/sessions')).json()).sessions)
    cwdSession = sessions.find((session) => typeof session.cwd === 'string' && session.cwd.trim())
    assert.ok(cwdSession, 'test environment needs a session with cwd')
  } finally {
    await page.close()
  }
})

after(async () => {
  await browser?.close()
})

test('desktop list hides cwd but search still finds it, and Chat shows it in the subtitle', async () => {
  const page = await browser.newPage()
  try {
    await authenticate(page, { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
    await expectCwdSearchWithoutRowDisplay(page)
    await page.evaluate((sessionId) => window.alphabotTest.switchToSession(sessionId), cwdSession.id)
    await expectHeaderSubtitle(page)
  } finally {
    await page.close()
  }
})

test('mobile list hides cwd and Chat shows it from its per-session snapshot', async () => {
  const page = await browser.newPage()
  try {
    await authenticate(page, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
    await expectCwdSearchWithoutRowDisplay(page)
    await page.evaluate((sessionId) => window.alphabotTest.switchToSession(sessionId), cwdSession.id)
    await expectHeaderSubtitle(page)
  } finally {
    await page.close()
  }
})

test('Code embedded sidebar hides cwd and embedded Chat gets cwd without a global list request', async () => {
  const page = await browser.newPage()
  try {
    await authenticate(page, { width: 360, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/?foxwarmEmbed=sidebar&foxwarmEmbedNonce=${embedNonce}`, { waitUntil: 'networkidle2' })
    await expectCwdSearchWithoutRowDisplay(page)

    let globalListRequests = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/api/sessions')) globalListRequests += 1
    })
    await page.goto(`${baseUrl}/?foxwarmEmbed=chat&foxwarmEmbedNonce=${embedNonce}&sessionId=${encodeURIComponent(cwdSession.id)}&title=Embedded`, { waitUntil: 'networkidle2' })
    await expectHeaderSubtitle(page)
    assert.equal(globalListRequests, 0)
  } finally {
    await page.close()
  }
})