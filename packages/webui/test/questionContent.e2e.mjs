import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, url, page
const entry = new URL('../src/components/QuestionCard.tsx', import.meta.url).pathname
const source = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QuestionOutcome, QuestionAnswerBubble } from ${JSON.stringify(entry)}
const record = { id: 'q-legacy', status: 'answered', questions: [{ question: '**Which** file?' }], answer: { viaMessage: true, text: '<attachment-ref ref="attachment1" /> **Use this** and \\x60Code\\x60.\\n\\n- First\\n- Second\\n<foxwarm-image name="attachment1_screen.png" node="master" path="/private/upload.png" />' } }
createRoot(document.getElementById('legacy')).render(React.createElement(QuestionOutcome, { record }))
createRoot(document.getElementById('structured')).render(React.createElement(QuestionOutcome, { record: { id: 'q-structured', status: 'answered', questions: [{ question: 'Choose a **database**' }], answer: { answers: [{ selected: ['SQLite'], text: '**Keep** backups.\\n\\n\\x60\\x60\\x60sql\\nselect 1;\\n\\x60\\x60\\x60\\n<img src=x onerror="window.xss=true"><script>window.xss=true</script>' }], note: '**Encrypted** disks' } } }))
createRoot(document.getElementById('bubble')).render(React.createElement(QuestionAnswerBubble, { answer: { questionId: 'q-bubble', questions: ['**Database?**'], answers: [{ text: '**SQLite** and \\x60backups\\x60 [docs](https://example.test)' }] } }))
`

before(async () => {
  const result = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'question-content-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  const script = result.outputFiles[0].text
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssName, 'Build the WebUI before running browser styling tests')
  const css = await readFile(new URL(cssName, assets), 'utf8')
  server = createServer((request, response) => {
    if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return }
    if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); return }
    if (request.url.startsWith('/download?')) { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')); return }
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>:root{--foxwarm-color-user-text:rgb(250,240,230);--foxwarm-color-accent:rgb(10,20,30);--foxwarm-console-accent:rgb(10,20,30)}#bubble{background:navy;color:rgb(250,240,230)}body{font-family:system-ui;max-width:650px}pre{overflow:auto}</style><div id="legacy"></div><div id="structured"></div><div id="bubble"></div><script src="/fixture.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage()
}, { timeout: 30000 })

after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)) })

async function mount() {
  await page.goto(url)
  await page.waitForSelector('#legacy button')
}

test('legacy summaries hide raw transport tags and expanded answers render Markdown with attachment chips', async () => {
  await mount()
  const summary = await page.$eval('#legacy', el => el.innerText)
  assert.match(summary, /Answered[\s\S]*Image: screen.png.*Use this/)
  assert.doesNotMatch(summary, /attachment-ref|foxwarm-image|\/private\/upload|\*\*/)
  await page.click('#legacy > div > button')
  assert.equal(await page.$eval('#legacy dd strong', el => el.textContent), 'Use this')
  assert.equal(await page.$eval('#legacy dd code', el => el.textContent), 'Code')
  assert.equal(await page.$$eval('#legacy dd li', els => els.length), 2)
  assert.equal(await page.$eval('[data-question-attachment="attachment1"] button', el => el.textContent), 'screen.png')
  assert.doesNotMatch(await page.$eval('#legacy', el => el.innerText), /attachment-ref|foxwarm-image|\/private\/upload/)
})

test('legacy image attachment opens a safe preview without exposing metadata', async () => {
  await mount()
  await page.click('#legacy > div > button')
  await page.click('[aria-label="Preview screen.png"]')
  await page.waitForSelector('dialog[open]')
  const src = await page.$eval('dialog img', el => el.getAttribute('src'))
  assert.match(src, /^\/download\?/)
  assert.match(src, /preview=1/)
  assert.doesNotMatch(await page.$eval('dialog', el => el.innerText), /foxwarm-image|attachment-ref/)
})

test('structured outcomes render code and notes through the sanitized Markdown renderer', async () => {
  await mount()
  await page.click('#structured > div > button')
  assert.equal(await page.$eval('#structured dd strong', el => el.textContent), 'Keep')
  assert.equal(await page.$eval('#structured dd pre code', el => el.textContent.trim()), 'select 1;')
  assert.match(await page.$eval('#structured', el => el.innerText), /Encrypted/)
  assert.equal(await page.$$eval('#structured script, #structured [onerror]', els => els.length), 0)
  assert.equal(await page.evaluate(() => !!window.xss), false)
})

test('structured answer bubbles use the same Markdown presentation while retaining user colors', async () => {
  await mount()
  assert.equal(await page.$eval('#bubble strong', el => el.textContent), 'Database?')
  assert.equal(await page.$eval('#bubble code', el => el.textContent), 'backups')
  for (const treatment of ['standard', 'console']) {
    for (const dark of [false, true]) {
      await page.evaluate(({ treatment, dark }) => {
        document.documentElement.setAttribute('data-foxwarm-component-treatment', treatment)
        document.documentElement.classList.toggle('dark', dark)
      }, { treatment, dark })
      assert.equal(await page.$eval('#bubble a', el => getComputedStyle(el).color), 'rgb(250, 240, 230)', `${treatment} dark=${dark}`)
    }
  }
})

test('answer links retain the ordinary confirmation before opening a new tab', async () => {
  await mount()
  const dialog = new Promise(resolve => page.once('dialog', async dialog => { const message = dialog.message(); await dialog.dismiss(); resolve(message) }))
  await page.click('#bubble a')
  assert.match(await dialog, /Open this link in a new tab\?[\s\S]*https:\/\/example.test/)
})
