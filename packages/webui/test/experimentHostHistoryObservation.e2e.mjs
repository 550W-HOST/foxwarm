import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeModelFixture } from './experimentModelFixture.mjs'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const providerToken = 'history-observation-provider-token'
const parentId = 'history-observation-parent'
const movedId = 'history-observation-moved'
let provider
const fixture = await createHostFixture('history-observation', {
  env: {
    FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken,
    FOXWARM_EXPERIMENT_REQUEST_MODEL: 'history-observation-model',
    FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'history-observation-model',
  },
})

function complete(res) {
  res.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'history observation response' }],
          },
        ],
      },
    })}\n\n`,
  )
  res.end()
}

async function history(sessionId) {
  return (await fixture.api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/history?tail=500`)).body
}

async function waitForRows(sessionId, count) {
  return until(async () => {
    const value = await history(sessionId)
    return value.messages?.length >= count ? value : false
  }, `${sessionId} history`, 20000)
}

try {
  provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/responses')
      assert.equal(request.headers.authorization, `Bearer ${providerToken}`)
      for await (const _chunk of request) {}
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      complete(response)
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end()
      throw error
    }
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  await writeModelFixture(fixture.data, {
    default: 'history-observation-model',
    providers: {
      'history-observation-model': {
        providerType: 'openai-responses',
        baseUrl: `http://127.0.0.1:${provider.address().port}`,
        apiKey: providerToken,
        models: ['history-observation-model'],
      },
    },
  })
  await fixture.start()

  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: parentId })
  assert.equal(created.status, 200, JSON.stringify(created))
  for (let index = 0; index < 30; index += 1) {
    const sent = await fixture.api('POST', `/api/sessions/${parentId}/message`, { text: `history-seed-${index}` })
    assert.equal(sent.status, 202, JSON.stringify(sent))
    await waitForRows(parentId, (index + 1) * 2)
  }

  const fork = await fixture.api('POST', `/api/sessions/${parentId}/fork`, { suffix: 'child' })
  assert.equal(fork.status, 200, JSON.stringify(fork))
  const childId = fork.body.newSessionId
  assert.equal(typeof childId, 'string')
  const postForkText = 'history-parent-after-fork'
  const postFork = await fixture.api('POST', `/api/sessions/${parentId}/message`, { text: postForkText })
  assert.equal(postFork.status, 202, JSON.stringify(postFork))
  const parentAfterFork = await waitForRows(parentId, 62)
  const postForkRow = parentAfterFork.messages.find(row => JSON.stringify(row).includes(postForkText))
  assert(postForkRow?.__meta?.seq)
  const childWindow = await fixture.api(
    'GET',
    `/api/history/window?sessionId=${encodeURIComponent(childId)}&target=msg%23${postForkRow.__meta.seq}`,
  )
  assert.equal(childWindow.status, 200, JSON.stringify(childWindow))
  assert(childWindow.body.messages.every(row => !JSON.stringify(row).includes(postForkText)))

  const centered = await fixture.api('GET', `/api/history/window?sessionId=${parentId}&target=msg%2330`)
  assert.equal(centered.status, 200, JSON.stringify(centered))
  assert.equal(centered.body.hasEarlier, true)
  const earlier = await fixture.api(
    'GET',
    `/api/history/window?sessionId=${parentId}&beforeSeq=${centered.body.firstSeq}`,
  )
  assert.equal(earlier.status, 200, JSON.stringify(earlier))
  assert.equal(earlier.body.hasEarlier, true)
  assert.equal(earlier.body.hasLater, true)

  const selected = await fixture.api('GET', `/api/history/window?sessionId=${parentId}&target=msg%231-45`)
  assert.equal(selected.status, 200, JSON.stringify(selected))
  assert(selected.body.messages.length > 0)
  assert.equal(selected.body.hasMoreInTarget, true)
  assert.equal(selected.body.hasLater, true)
  const continued = await fixture.api(
    'GET',
    `/api/history/window?sessionId=${parentId}&afterSeq=${selected.body.lastSeq}&targetEndSeq=45`,
  )
  assert.equal(continued.status, 200, JSON.stringify(continued))
  assert(continued.body.messages.length > 0)
  assert.equal(continued.body.hasMoreInTarget, true)
  const finished = await fixture.api(
    'GET',
    `/api/history/window?sessionId=${parentId}&afterSeq=${continued.body.lastSeq}&targetEndSeq=45`,
  )
  assert.equal(finished.status, 200, JSON.stringify(finished))
  assert(finished.body.messages.length > 0)
  assert.equal(finished.body.hasMoreInTarget, false)
  assert.equal(finished.body.hasLater, true)

  const moved = await fixture.api('POST', `/api/sessions/${parentId}/message`, { text: `/session move ${movedId}` })
  assert.equal(moved.status, 200, JSON.stringify(moved))
  const aliasWindow = await fixture.api('GET', `/api/history/window?sessionId=${parentId}&target=msg%231`)
  assert.equal(aliasWindow.status, 200, JSON.stringify(aliasWindow))
  const debug = await fixture.api('GET', `/api/sessions/${movedId}/debug-file`)
  assert.equal(debug.status, 200, JSON.stringify(debug))
  assert.equal(debug.body.payload.contextFrontier, undefined)
  const tree = await fixture.api('GET', '/api/agents/tree')
  assert.equal(tree.status, 200, JSON.stringify(tree))
  assert(tree.body.agents.some(row => row.id === childId))

  const invalid = await fixture.api('GET', `/api/history/window?sessionId=${movedId}&beforeSeq=not-a-number`)
  assert.equal(invalid.status, 400, JSON.stringify(invalid))
  assert.equal(invalid.body.code, 'HISTORY_SEARCH_INVALID')
  const duplicate = await fixture.api(
    'GET',
    `/api/history/window?sessionId=${movedId}&target=msg%231&target=msg%232`,
  )
  assert.equal(duplicate.status, 400, JSON.stringify(duplicate))
  const semantic = await fixture.api('GET', '/api/history/search?query=history-seed')
  assert.equal(semantic.status, 503, JSON.stringify(semantic))
  assert.equal(semantic.body.code, 'VECTOR_DISABLED')
  assert.equal((await fetch(`${fixture.origin}/api/agents/tree`)).status, 401)

  const page = await fixture.openApp()
  await page.setViewport({ width: 520, height: 800 })
  await page.waitForSelector('button[title="Search history"]')
  await page.click('button[title="Search history"]')
  await page.waitForSelector('#history-search-query')
  await page.type('#history-search-query', `sessionId=${parentId} msg#1-45`)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-history-search-results] [data-history-result]')
  assert((await page.$eval('[data-history-search-results]', node => node.textContent || '')).includes('Selected msg#1–45'))
  await page.evaluate(() => { location.hash = 'tab/chat:history-observation-moved' })
  await page.waitForSelector('.foxwarm-chat-root')
  await page.click('button[title="Session options"]')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'debug info')?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'refresh'))
  assert((await page.evaluate(() => document.body.textContent || '')).includes('session file:'))

  console.log(JSON.stringify({ result: 'ok', childId, populatedWindow: true, selectedRangeContinuation: true, aliasWindow: true, tree: true, exactSearch: true, debugModal: true, semanticStatus: semantic.status }))
} finally {
  await fixture.cleanup()
  if (provider?.listening) await new Promise(done => provider.close(done))
}
