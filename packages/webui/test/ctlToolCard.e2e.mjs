import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

// A ctl call renders like the call it runs (diff controls, downloads), with its command shown.
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const ids = ['direct', 'ctl', 'sendDirect', 'sendCtl']
let browser
let server
let page

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup } from ${JSON.stringify(toolEntry)}
    const edit = { filePath: 'MEMORY.md', oldText: 'original line', newText: 'replacement line' }
    const fixtures = {
      direct: { name: 'edit_memory', args: edit },
      ctl: { name: 'ctl', args: { command: 'memory edit MEMORY.md --old-text @old --new-text @new', values: { old: edit.oldText, new: edit.newText } } },
      sendDirect: { name: 'send_file', args: { filePath: '/workspace/report.txt' } },
      sendCtl: { name: 'ctl', args: { command: 'file send /workspace/report.txt' } },
    }
    for (const [id, base] of Object.entries(fixtures)) {
      const call = { id, ...base }
      const response = { tool_use_id: id, name: call.name, response: id.startsWith('send') ? { fullPath: '/workspace/report.txt', output: 'sent' } : { output: 'File edited successfully' } }
      const msg = { role: 'model', parts: [{ functionCall: call }], __meta: { seq: 1 } }
      const nextMsg = { role: 'tool', parts: [{ functionResponse: response }], __meta: { seq: 2 } }
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, { msg, nextMsg, messageKeyPrefix: id }))
    }
  `
  const built = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'ctl-tool-card.tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const bundle = built.outputFiles[0].text
  server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(bundle)
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html>${ids.map(id => `<div id="${id}"></div>`).join('')}<script src="/bundle.js"></script>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForSelector('#sendCtl .foxwarm-tool-card')
  for (const id of ids) await page.click(`#${id} .foxwarm-tool-card`)
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const card = id => page.evaluate(root => {
  const element = document.getElementById(root)
  return {
    text: element.innerText,
    buttons: [...element.querySelectorAll('button')].map(button => button.title).filter(title => !/^(Collapse|Expand) /.test(title)),
    tag: element.querySelector('.foxwarm-tool-tag')?.textContent,
    command: element.querySelector('[data-ctl-command]')?.textContent,
  }
}, id)

test('a ctl edit renders the diff view of the edit it runs', async () => {
  const [direct, ctl] = [await card('direct'), await card('ctl')]
  assert.deepEqual(ctl.buttons, direct.buttons)
  assert.equal(ctl.tag, direct.tag)
  assert.equal(ctl.command, 'ctl memory edit MEMORY.md --old-text @old --new-text @new')
  for (const text of ['original line', 'replacement line']) assert.ok(ctl.text.includes(text), ctl.text)
})

test('a ctl file send offers the same download', async () => {
  const [direct, ctl] = [await card('sendDirect'), await card('sendCtl')]
  assert.deepEqual(ctl.buttons, direct.buttons)
  assert.ok(ctl.buttons.some(title => title.startsWith('Download')), JSON.stringify(ctl.buttons))
  assert.equal(ctl.command, 'ctl file send /workspace/report.txt')
})
