import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createHostFixture } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

async function sampleCenterHex(pngBuffer, box) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const x = Math.min(info.width - 1, Math.max(0, Math.round(box.x + box.width / 2)))
  const y = Math.min(info.height - 1, Math.max(0, Math.round(box.y + box.height / 2)))
  const idx = (y * info.width + x) * 4
  return '#' + [data[idx], data[idx + 1], data[idx + 2]].map(v => v.toString(16).padStart(2, '0')).join('')
}

function makeGate() {
  let release
  let markArrived
  const released = new Promise(resolve => { release = resolve })
  const arrived = new Promise(resolve => { markArrived = resolve })
  return { released, release, arrived, markArrived }
}

async function openPausedEmbeddedCode(page, { osMode, colorMode, themeId = 'foxwarm.default', expectedHex, expectedRgb }) {
  const errors = []
  const onPageError = err => errors.push(err.message)
  const onConsole = msg => {
    if (msg.type() === 'error' && /content security policy/i.test(msg.text())) errors.push(msg.text())
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)

  const client = await page.createCDPSession()
  const htmlGate = makeGate()
  const cssGate = makeGate()
  const jsGate = makeGate()

  try {
    await page.setCacheEnabled(false)
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: osMode }])
    await page.evaluate(({ themeId, colorMode }) => {
      localStorage.setItem('foxwarm_theme_selection_v3', JSON.stringify({
        version: 3,
        themeId,
        lightThemeId: themeId,
        darkThemeId: themeId,
        colorMode,
      }))
      // Clear any open Code tab from a previous run so clicking Code starts a fresh iframe load.
      localStorage.removeItem('foxwarm_workbench_state_v4')
    }, { themeId, colorMode })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForWebUiReady(page)

    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*vscode-web*' }] })
    client.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const url = request.url
      try {
        if (/\/vscode-web\/?(\?|$)/.test(url)) {
          htmlGate.markArrived(url)
          await htmlGate.released
        } else if (url.includes('workbench.web.main.internal.css')) {
          cssGate.markArrived(url)
          await cssGate.released
        } else if (url.includes('workbench.web.main.internal.js')) {
          jsGate.markArrived(url)
          await jsGate.released
        }
        await client.send('Fetch.continueRequest', { requestId })
      } catch {
        // Ignore requests paused during shutdown.
      }
    })

    const codeBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Code') || null
    )
    assert.ok(codeBtn.asElement(), 'Code launcher button is present')
    await codeBtn.asElement().click()

    await htmlGate.arrived
    await page.waitForSelector('iframe[data-foxwarm-vscode-web-frame="true"]')
    const frameBox = await page.$eval('iframe[data-foxwarm-vscode-web-frame="true"]', el => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })

    // Stage 1: before HTML commits (host + iframe element).
    assert.equal(await sampleCenterHex(await page.screenshot(), frameBox), expectedHex)

    // Stage 2: HTML received, CSS paused.
    htmlGate.release()
    await cssGate.arrived
    assert.equal(await sampleCenterHex(await page.screenshot(), frameBox), expectedHex)

    // Stage 3: CSS loaded, main JS paused (the stage that previously flashed #ffffff in dark mode).
    cssGate.release()
    await jsGate.arrived
    await page.waitForFunction(() => {
      const doc = document.querySelector('iframe[data-foxwarm-vscode-web-frame="true"]')?.contentDocument
      return !!doc?.head?.querySelector('.initialShellColors')
    })
    assert.equal(await sampleCenterHex(await page.screenshot(), frameBox), expectedHex)
    const state = await page.evaluate(() => {
      const doc = document.querySelector('iframe[data-foxwarm-vscode-web-frame="true"]').contentDocument
      return {
        colorScheme: getComputedStyle(doc.documentElement).colorScheme,
        bg: getComputedStyle(doc.body).backgroundColor,
      }
    })
    assert.equal(state.colorScheme, colorMode)
    assert.equal(state.bg, expectedRgb)

    // Stage 4: releasing JS lets Code mount and remove .initialShellColors cleanly without CSP/runtime errors.
    jsGate.release()
    const frameHandle = await page.$('iframe[data-foxwarm-vscode-web-frame="true"]')
    const frame = await frameHandle.contentFrame()
    await frame.waitForSelector('.monaco-workbench', { timeout: 30000 })
    await frame.waitForFunction(() => !document.head.querySelector('.initialShellColors'), { timeout: 15000 })
    assert.deepEqual(errors, [])
  } finally {
    htmlGate.release()
    cssGate.release()
    jsGate.release()
    await client.detach().catch(() => {})
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  }
}

async function checkStandaloneLoading(browser, origin, { osMode, clearCanvasCookie = false, expectedHex, expectedColorScheme, waitForMount = false }) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  page.on('console', msg => {
    if (msg.type() === 'error' && /content security policy/i.test(msg.text())) errors.push(msg.text())
  })
  const client = await page.createCDPSession()
  const jsGate = makeGate()
  try {
    await page.setCacheEnabled(false)
    await page.setViewport({ width: 800, height: 600 })
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: osMode }])
    if (clearCanvasCookie) {
      await client.send('Network.deleteCookies', { name: 'foxwarm_canvas', url: origin })
    }
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*workbench.web.main.internal.js*' }] })
    client.on('Fetch.requestPaused', async ({ requestId }) => {
      jsGate.markArrived()
      try {
        await jsGate.released
        await client.send('Fetch.continueRequest', { requestId })
      } catch {}
    })

    const nav = page.goto(`${origin}/vscode-web/?nodeId=master`, { waitUntil: 'domcontentloaded' })
    await jsGate.arrived
    await page.waitForFunction(() => !!document.head?.querySelector('.initialShellColors'))
    assert.equal(
      await sampleCenterHex(await page.screenshot(), { x: 0, y: 0, width: 800, height: 600 }),
      expectedHex,
    )
    const colorScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    assert.equal(colorScheme, expectedColorScheme)

    jsGate.release()
    await nav
    if (waitForMount) {
      await page.waitForSelector('.monaco-workbench', { timeout: 30000 })
      await page.waitForFunction(() => !document.head.querySelector('.initialShellColors'), { timeout: 15000 })
    }
    assert.deepEqual(errors, [])
  } finally {
    jsGate.release()
    await client.detach().catch(() => {})
    await page.close()
  }
}

test('embedded and standalone Code loading backgrounds follow foxwarm_canvas and media fallback', async () => {
  const owned = await createHostFixture('code-loading-theme', {})
  await writeModelFixture(owned.data, {
    defaultModel: 'mock/m',
    providers: {
      mock: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'k',
        models: [{ id: 'm', contextWindow: 8192 }],
      },
    },
  })

  try {
    await owned.start()
    const page = await owned.openApp()
    await page.setViewport({ width: 1280, height: 800 })

    // Embedded dark (with OS light, proving the cookie/theme wins over prefers-color-scheme).
    await openPausedEmbeddedCode(page, {
      osMode: 'light',
      colorMode: 'dark',
      themeId: 'foxwarm.default',
      expectedHex: '#111827',
      expectedRgb: 'rgb(17, 24, 39)',
    })

    // Standalone inherits the dark foxwarm_canvas cookie even with OS light.
    await checkStandaloneLoading(page.browser(), owned.origin, {
      osMode: 'light',
      expectedHex: '#111827',
      expectedColorScheme: 'dark',
      waitForMount: true,
    })

    // Embedded light (with OS dark, proving light cookie/theme wins over prefers-color-scheme).
    await openPausedEmbeddedCode(page, {
      osMode: 'dark',
      colorMode: 'light',
      themeId: 'foxwarm.default',
      expectedHex: '#f3f4f6',
      expectedRgb: 'rgb(243, 244, 246)',
    })

    // Standalone without foxwarm_canvas falls back to light dark + prefers-color-scheme.
    await checkStandaloneLoading(page.browser(), owned.origin, {
      osMode: 'dark',
      clearCanvasCookie: true,
      expectedHex: '#111827',
      expectedColorScheme: 'light dark',
    })
    await checkStandaloneLoading(page.browser(), owned.origin, {
      osMode: 'light',
      clearCanvasCookie: true,
      expectedHex: '#f3f4f6',
      expectedColorScheme: 'light dark',
    })
  } finally {
    await owned.cleanup()
  }
})
