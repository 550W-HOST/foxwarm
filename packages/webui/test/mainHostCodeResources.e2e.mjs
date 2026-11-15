// Browser consumers of Code's built-in extensions, grammars and webview resources.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const host = await createHostFixture('code-resources')
const failures = [], errors = []
try {
  await writeFile(join(host.work, 'highlight.js'), 'const packedValue = "syntax resources";\nconsole.log(packedValue);\n')
  await writeFile(join(host.work, 'preview.md'), '# Packed markdown preview\n\n**Extension content** with a [link](https://example.invalid).\n')
  await host.start()
  const page = await host.openApp()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === host.origin && response.status() >= 400
      && /\/vscode-web\/(?:static|extensions|webview)\//.test(url.pathname)
      && !url.pathname.endsWith('/package.nls.json'))
      failures.push({ path: url.pathname, status: response.status() })
  })
  const open = async name => {
    const url = new URL('/vscode-web/', host.origin)
    url.searchParams.set('nodeId', 'master')
    url.searchParams.set('initialFolderUri', 'foxwarm://node+master' + host.work)
    url.searchParams.set('openFilePath', join(host.work, name))
    url.searchParams.set('openFileNodeId', 'master')
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.editor-instance .view-lines', { timeout: 40000 })
  }
  await open('highlight.js')
  await page.waitForFunction(() => {
    const tokens = [...document.querySelectorAll('.editor-instance .view-lines span[class*="mtk"]')]
    return tokens.some(span => span.textContent === 'const') && new Set(tokens.map(span => getComputedStyle(span).color)).size > 1
  })
  await open('preview.md')
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await page.waitForSelector('.quick-input-widget input')
  await page.type('.quick-input-widget input', 'Markdown: Open Preview')
  await page.keyboard.press('Enter')
  const preview = await until(async () => {
    for (const frame of page.frames()) {
      try {
        if (await frame.evaluate(() => document.querySelector('h1')?.textContent === 'Packed markdown preview')) return frame
      } catch { /* The webview replaces its bootstrap frame while loading. */ }
    }
    return false
  }, 'built-in Markdown preview', 40000)
  assert.equal(await preview.$eval('strong', element => element.textContent), 'Extension content')
  assert.deepEqual(failures, [])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', javascriptSyntax: true, markdownPreview: true, resourceErrors: failures }))
  await host.stop()
} finally { await host.cleanup() }
