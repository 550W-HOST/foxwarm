import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const call = (id, seq) => ({ role: 'model', parts: [{ functionCall: { id, name: 'exec', args: { command: `echo ${id}` } } }], __meta: { seq } })
const result = (id, seq) => ({ role: 'tool', parts: [{ functionResponse: { name: 'exec', tool_use_id: id, response: { output: `${id} result` } } }], __meta: { seq } })
const answer = (text, seq) => ({ role: 'model', parts: [{ text }], __meta: { seq } })
const image = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx7zWQAAAABJRU5ErkJggg==' } }
const generatedImage = { inlineDataRef: { mimeType: 'image/png', imageId: 'generated-fixture', apiPath: '/blobs/generated-fixture.png' }, imageMeta: { origin: 'generated' } }
const unavailableImage = { inlineDataUnavailable: { mimeType: 'image/png', unavailable: true } }
const webSearch = { providerMeta: { openaiResponses: { outputItem: { type: 'web_search_call', action: { type: 'search', query: 'sample query' } } } } }
const cases = {
  mixed: [
    { role: 'model', parts: [{ text: 'INTRO_MIXED' }, call('mixed', 1).parts[0]], __meta: { seq: 1, usage: { cachedTokens: 1, inputTokens: 2, outputTokens: 3 } } },
    result('mixed', 2), answer('FINAL_MIXED', 3),
  ],
  imageBetween: [
    call('image-a', 51), result('image-a', 52),
    { role: 'model', parts: [image], __meta: { seq: 53 } },
    call('image-b', 54), result('image-b', 55), answer('FINAL_IMAGE_BETWEEN', 56),
  ],
  imageMixedCall: [
    call('image-prior', 61), result('image-prior', 62),
    { role: 'model', parts: [{ thinking: 'THOUGHT_BEFORE_IMAGE' }, generatedImage, call('image-next', 63).parts[0]], __meta: { seq: 63 } },
    result('image-next', 64),
    { role: 'model', parts: [{ thinking: 'THOUGHT_AFTER_IMAGE' }, { text: 'FINAL_IMAGE_MIXED' }], __meta: { seq: 65 } },
  ],
  imageUnavailable: [
    call('unavailable-a', 71), result('unavailable-a', 72),
    { role: 'model', parts: [unavailableImage], __meta: { seq: 73 } },
    call('unavailable-b', 74), result('unavailable-b', 75), answer('FINAL_UNAVAILABLE', 76),
  ],
  toolText: [
    call('text-tool', 91), result('text-tool', 92),
    { role: 'tool', parts: [{ text: 'TOOL_ROW_NOTE' }], __meta: { seq: 93 } },
    answer('FINAL_TOOL_TEXT', 94),
  ],
  toolImage: [
    call('with-image', 81),
    { role: 'tool', parts: [
      { functionResponse: { name: 'exec', tool_use_id: 'with-image', response: { output: 'tool image result' } } },
      { toolUseId: 'with-image', inlineDataRef: { mimeType: 'image/png', imageId: 'tool-fixture', apiPath: '/blobs/tool-fixture.png' } },
    ], __meta: { seq: 82 } },
    call('after-tool-image', 83), result('after-tool-image', 84), answer('FINAL_TOOL_IMAGE', 85),
  ],
  boundary: [
    call('previous', 11), result('previous', 12),
    { role: 'model', parts: [{ thinking: 'THOUGHT_PREVIOUS' }, { text: 'INTRO_NEXT' }, call('next', 13).parts[0]], __meta: { seq: 13 } },
    result('next', 14),
    { role: 'model', parts: [{ thinking: 'THOUGHT_FINAL' }, { text: 'FINAL_BOUNDARY' }], __meta: { seq: 15 } },
  ],
  system: [
    { role: 'model', parts: [{ system: 'META_MIXED' }, call('system', 41).parts[0]], __meta: { seq: 41 } },
    result('system', 42), answer('FINAL_SYSTEM', 43),
  ],
  hosted: [
    { role: 'model', parts: [{ text: 'INTRO_HOSTED' }, webSearch, call('hosted', 21).parts[0]], __meta: { seq: 21 } },
    result('hosted', 22), answer('FINAL_HOSTED', 23),
  ],
  image: [
    { role: 'model', parts: [{ text: 'INTRO_IMAGE' }, image, call('image', 31).parts[0]], __meta: { seq: 31, usage: { cachedTokens: 1, inputTokens: 2, outputTokens: 3 } } },
    result('image', 32), answer('FINAL_IMAGE', 33),
  ],
}
let browser, page, server

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    const cases = ${JSON.stringify(cases)}
    for (const [id, messages] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main', messages, isMobile: false, groupTools: true, showUsageBadge: true,
      }))
    }
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'mixed-tool-group-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((request, response) => {
    if (request.url?.endsWith('-fixture.png')) {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(Buffer.from(image.inlineData.data, 'base64'))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>${Object.keys(cases).map(id => `<div id="${id}"></div>`).join('')}<script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelectorAll('[data-tool-group]').length === 14)
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const snapshot = async id => page.$eval(`#${id}`, root => {
  const groups = [...root.querySelectorAll('[data-tool-group]')]
  const ordinaryCards = [...root.querySelectorAll('.foxwarm-assistant-message-card')]
  return {
    groups: groups.map(group => ({ expanded: group.dataset.toolGroupExpanded, header: group.querySelector('.foxwarm-tool-group-header')?.textContent.trim() })),
    ordinary: ordinaryCards.map(card => ({ text: card.textContent.trim(), insideCard: !!card.closest('[data-tool-group-card]') })),
    reasoning: [...root.querySelectorAll('[data-model-thread-card="reasoning"]')].map(card => ({ text: card.textContent.trim(), insideCard: !!card.closest('[data-tool-group-card]') })),
    tools: [...root.querySelectorAll('.foxwarm-tool-card:not(.foxwarm-tool-group-card)')].map(card => ({ text: card.textContent.trim(), insideCard: !!card.closest('[data-tool-group-card]') })),
    badges: root.querySelectorAll('[data-usage-badge]').length,
    images: [...root.querySelectorAll('img[alt="Image 1"]')].map(img => ({ insideCard: !!img.closest('[data-tool-group-card]') })),
    allImages: [...root.querySelectorAll('img')].map(img => ({ insideCard: !!img.closest('[data-tool-group-card]') })),
    unavailableImages: [...root.querySelectorAll('div')].filter(node => node.textContent.trim() === 'Image unavailable' && node.childElementCount === 0).map(node => ({ insideCard: !!node.closest('[data-tool-group-card]') })),
    searches: [...root.querySelectorAll('[data-model-thread-card="web-search"]')].map(card => ({ insideCard: !!card.closest('[data-tool-group-card]') })),
    modelSystem: [...root.querySelectorAll('pre')].filter(node => node.textContent.includes('META_MIXED')).map(node => ({ insideCard: !!node.closest('[data-tool-group-card]') })),
    anchorKeys: [...root.querySelectorAll('[data-chat-message-anchor-key]')].map(node => node.getAttribute('data-chat-message-anchor-key')),
  }
})
const toggle = async (id, index, targetExpanded) => {
  await page.$eval(`#${id}`, (root, index) => {
    const group = root.querySelectorAll('[data-tool-group]')[index]
    group.querySelector(`[aria-label="${group.dataset.toolGroupExpanded === 'true' ? 'Collapse' : 'Expand'} tool group"]`).click()
  }, index)
  await page.waitForFunction((id, index, targetExpanded) => document.querySelectorAll(`#${id} [data-tool-group]`)[index]?.dataset.toolGroupExpanded === String(targetExpanded), {}, id, index, targetExpanded)
}

test('mixed text and tool call leave the ordinary assistant card outside the persistent group in both states', async () => {
  const collapsed = await snapshot('mixed')
  assert.equal(collapsed.groups[0].header, 'exec ×1')
  assert.deepEqual(collapsed.ordinary, [{ text: 'INTRO_MIXED', insideCard: false }, { text: 'FINAL_MIXED', insideCard: false }])
  assert.equal(collapsed.tools.length, 0)
  assert.equal(collapsed.badges, 1)
  assert.deepEqual(collapsed.anchorKeys, ['seq-local-1', 'seq-local-3'])
  const order = await page.$eval('#mixed', root => {
    const nodes = [root.querySelector('.foxwarm-assistant-message-card'), root.querySelector('[data-tool-group-card]'), root.querySelectorAll('.foxwarm-assistant-message-card')[1]]
    return nodes.every((node, index) => index === 0 || nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  assert.ok(order, 'text card precedes its call group; final text follows it')
  await page.evaluate(() => { window.firstOrdinaryCard = document.querySelector('#mixed .foxwarm-assistant-message-card') })
  await toggle('mixed', 0, true)
  const expanded = await snapshot('mixed')
  assert.deepEqual(expanded.ordinary, collapsed.ordinary)
  assert.equal(expanded.groups[0].header, collapsed.groups[0].header)
  assert.equal(expanded.tools.length, 1)
  assert.ok(expanded.tools[0].insideCard)
  assert.equal(expanded.badges, 1, 'the model usage badge appears once')
  assert.deepEqual(expanded.anchorKeys, collapsed.anchorKeys)
  assert.equal(await page.evaluate(() => window.firstOrdinaryCard === document.querySelector('#mixed .foxwarm-assistant-message-card')), true, 'ordinary card remains mounted while the group expands')
  await toggle('mixed', 0, false)
  assert.deepEqual((await snapshot('mixed')).ordinary, collapsed.ordinary)
})

test('folded thinking follows the preceding group, while a mixed next-row text and final text remain ordinary', async () => {
  const collapsed = await snapshot('boundary')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×1reasoning ×1', 'exec ×1reasoning ×1'])
  assert.deepEqual(collapsed.ordinary, [{ text: 'INTRO_NEXT', insideCard: false }, { text: 'FINAL_BOUNDARY', insideCard: false }])
  assert.equal(collapsed.reasoning.length, 0)
  assert.equal(collapsed.tools.length, 0)
  assert.deepEqual(collapsed.anchorKeys, ['seq-local-11', 'seq-local-13', 'seq-local-15'])
  await toggle('boundary', 0, true)
  const previousOpen = await snapshot('boundary')
  assert.equal(previousOpen.reasoning.length, 1)
  assert.ok(previousOpen.reasoning[0].text.includes('THOUGHT_PREVIOUS'))
  assert.equal(previousOpen.reasoning[0].insideCard, false)
  assert.equal(previousOpen.tools.length, 1)
  assert.ok(previousOpen.tools[0].text.includes('previous result'))
  assert.deepEqual(previousOpen.ordinary, collapsed.ordinary)
  await toggle('boundary', 1, true)
  const bothOpen = await snapshot('boundary')
  assert.equal(bothOpen.reasoning.length, 2)
  assert.ok(bothOpen.reasoning.some(card => card.text.includes('THOUGHT_FINAL') && !card.insideCard))
  assert.equal(bothOpen.tools.length, 2)
  assert.ok(bothOpen.tools[1].text.includes('next result') && bothOpen.tools[1].insideCard)
  assert.deepEqual(bothOpen.ordinary, collapsed.ordinary)
  await toggle('boundary', 0, false)
  const previousClosed = await snapshot('boundary')
  assert.equal(previousClosed.reasoning.some(card => card.text.includes('THOUGHT_PREVIOUS')), false)
  assert.equal(previousClosed.reasoning.some(card => card.text.includes('THOUGHT_FINAL')), true)
  assert.equal(previousClosed.tools.length, 1)
  assert.deepEqual(previousClosed.ordinary, collapsed.ordinary)
  await toggle('boundary', 1, false)
  const bothClosed = await snapshot('boundary')
  assert.equal(bothClosed.reasoning.length, 0)
  assert.equal(bothClosed.tools.length, 0)
  assert.deepEqual(bothClosed.ordinary, collapsed.ordinary)
  assert.deepEqual(bothClosed.anchorKeys, collapsed.anchorKeys)
})

test('the historical text-bearing hosted-search exception stays outside the group card in both states', async () => {
  const collapsed = await snapshot('hosted')
  assert.equal(collapsed.searches.length, 1)
  assert.equal(collapsed.searches[0].insideCard, false)
  assert.deepEqual(collapsed.ordinary.map(card => card.text), ['INTRO_HOSTED', 'FINAL_HOSTED'])
  await toggle('hosted', 0, true)
  const expanded = await snapshot('hosted')
  assert.equal(expanded.searches.length, 1)
  assert.equal(expanded.searches[0].insideCard, false)
  assert.equal(expanded.tools.length, 1)
  assert.deepEqual(expanded.ordinary, collapsed.ordinary)
})

test('model images and usage remain single outside/attached surfaces while mixed calls expand', async () => {
  const collapsed = await snapshot('image')
  assert.deepEqual(collapsed.ordinary.map(card => card.text), ['INTRO_IMAGE', 'FINAL_IMAGE'])
  assert.deepEqual(collapsed.images, [{ insideCard: false }])
  assert.equal(collapsed.badges, 1)
  await toggle('image', 0, true)
  const expanded = await snapshot('image')
  assert.deepEqual(expanded.images, collapsed.images)
  assert.equal(expanded.badges, 1)
  assert.equal(expanded.tools.length, 1)
  assert.deepEqual(expanded.ordinary, collapsed.ordinary)
})


test('ordinary model system content stays visible once outside a mixed tool group', async () => {
  const collapsed = await snapshot('system')
  assert.deepEqual(collapsed.modelSystem, [{ insideCard: false }])
  assert.equal(collapsed.tools.length, 0)
  await toggle('system', 0, true)
  const expanded = await snapshot('system')
  assert.deepEqual(expanded.modelSystem, collapsed.modelSystem)
  assert.equal(expanded.tools.length, 1)
  assert.deepEqual(expanded.ordinary, collapsed.ordinary)
})

test('independent image between two calls splits A/image/B into two grouped runs in both states', async () => {
  const collapsed = await snapshot('imageBetween')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×1', 'exec ×1'])
  assert.deepEqual(collapsed.images, [{ insideCard: false }])
  assert.deepEqual(collapsed.anchorKeys, ['seq-local-51', 'seq-local-53', 'seq-local-54', 'seq-local-56'])
  assert.equal(collapsed.tools.length, 0)
  const order = await page.$eval('#imageBetween', root => {
    const [first, second] = root.querySelectorAll('[data-tool-group]')
    const image = root.querySelector('img')
    const final = root.querySelector('.foxwarm-assistant-message-card')
    return [first, image, second, final].every((node, index, nodes) => index === 0 || !!(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
  })
  assert.ok(order, 'the image stays between the two collapsed group cards')
  await toggle('imageBetween', 0, true)
  const firstOpen = await snapshot('imageBetween')
  assert.equal(firstOpen.tools.length, 1)
  assert.ok(firstOpen.tools[0].text.includes('image-a result') && firstOpen.tools[0].insideCard)
  assert.deepEqual(firstOpen.images, collapsed.images)
  await toggle('imageBetween', 1, true)
  const bothOpen = await snapshot('imageBetween')
  assert.equal(bothOpen.tools.length, 2)
  assert.ok(bothOpen.tools[1].text.includes('image-b result') && bothOpen.tools[1].insideCard)
  assert.deepEqual(bothOpen.images, collapsed.images)
  assert.deepEqual(bothOpen.anchorKeys, collapsed.anchorKeys)
  await toggle('imageBetween', 0, false)
  assert.equal((await snapshot('imageBetween')).tools.length, 1)
  await toggle('imageBetween', 1, false)
  assert.deepEqual((await snapshot('imageBetween')).images, collapsed.images)
})

test('a generated image plus next call keeps earlier thinking with the preceding group', async () => {
  const collapsed = await snapshot('imageMixedCall')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×1reasoning ×1', 'exec ×1reasoning ×1'])
  assert.deepEqual(collapsed.allImages, [{ insideCard: false }])
  assert.equal(collapsed.reasoning.length, 0)
  assert.deepEqual(collapsed.anchorKeys, ['seq-local-61', 'seq-local-63', 'seq-local-65'])
  await toggle('imageMixedCall', 0, true)
  const previousOpen = await snapshot('imageMixedCall')
  assert.equal(previousOpen.reasoning.length, 1)
  assert.ok(previousOpen.reasoning[0].text.includes('THOUGHT_BEFORE_IMAGE') && !previousOpen.reasoning[0].insideCard)
  assert.deepEqual(previousOpen.allImages, collapsed.allImages)
  assert.equal(previousOpen.tools.length, 1)
  await toggle('imageMixedCall', 1, true)
  const bothOpen = await snapshot('imageMixedCall')
  assert.equal(bothOpen.tools.length, 2)
  assert.ok(bothOpen.tools[1].text.includes('image-next result'))
  assert.ok(bothOpen.reasoning.some(card => card.text.includes('THOUGHT_AFTER_IMAGE') && !card.insideCard))
  assert.deepEqual(bothOpen.allImages, collapsed.allImages)
  await toggle('imageMixedCall', 0, false)
  const previousClosed = await snapshot('imageMixedCall')
  assert.equal(previousClosed.reasoning.some(card => card.text.includes('THOUGHT_BEFORE_IMAGE')), false)
  assert.deepEqual(previousClosed.allImages, collapsed.allImages)
})

test('unavailable standalone model image also breaks a tool run without disappearing', async () => {
  const collapsed = await snapshot('imageUnavailable')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×1', 'exec ×1'])
  assert.deepEqual(collapsed.unavailableImages, [{ insideCard: false }])
  assert.equal(collapsed.tools.length, 0)
  await toggle('imageUnavailable', 0, true)
  await toggle('imageUnavailable', 1, true)
  const expanded = await snapshot('imageUnavailable')
  assert.equal(expanded.tools.length, 2)
  assert.deepEqual(expanded.unavailableImages, collapsed.unavailableImages)
})

test('image attached to a tool result stays paired inside one two-call group', async () => {
  const collapsed = await snapshot('toolImage')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×2'])
  assert.equal(collapsed.allImages.length, 0)
  await toggle('toolImage', 0, true)
  await page.$eval('#toolImage .foxwarm-tool-card:not(.foxwarm-tool-group-card) [aria-label="Expand exec tool"]', node => node.click())
  await page.waitForFunction(() => document.querySelector('#toolImage .foxwarm-tool-card:not(.foxwarm-tool-group-card) [aria-label="Collapse exec tool"]') !== null)
  const expanded = await snapshot('toolImage')
  assert.equal(expanded.tools.length, 2)
  assert.ok(expanded.tools[0].text.includes('tool image result'))
  assert.deepEqual(expanded.allImages, [{ insideCard: true }])
  assert.deepEqual(expanded.anchorKeys, ['seq-local-81', 'seq-local-83', 'seq-local-85'])
})


test('tool-role text remains grouped content rather than disappearing with ordinary model surfaces', async () => {
  const collapsed = await snapshot('toolText')
  assert.deepEqual(collapsed.groups.map(group => group.header), ['exec ×1'])
  assert.deepEqual(collapsed.ordinary, [{ text: 'FINAL_TOOL_TEXT', insideCard: false }])
  await toggle('toolText', 0, true)
  const expanded = await snapshot('toolText')
  assert.deepEqual(expanded.ordinary, [
    { text: 'TOOL_ROW_NOTE', insideCard: true },
    { text: 'FINAL_TOOL_TEXT', insideCard: false },
  ])
  assert.equal(expanded.tools.length, 1)
})
