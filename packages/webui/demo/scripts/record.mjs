// Records what the demo replays: direct API reads and realtime snapshots for
// every Session, then a browser crawl of the real WebUI that captures the
// remaining GET requests it makes. Nothing here is hand-written response data.
import puppeteer from 'puppeteer-core'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const enc = encodeURIComponent

export async function recordSnapshot({ baseUrl, token, log = () => {}, crawlFirst = [] }) {
  const headers = { Authorization: `Bearer ${token}` }
  const get = {}
  const binary = {}
  const post = {}

  async function fetchApi(path, init = {}) {
    const response = await fetch(`${baseUrl}/api${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
    const type = response.headers.get('content-type') || ''
    if (!type.includes('json')) throw new Error(`${path} returned ${type}`)
    const body = await response.json()
    if (!response.ok) throw new Error(`${path} -> ${response.status}: ${JSON.stringify(body).slice(0, 300)}`)
    return { status: response.status, body }
  }
  async function recordGet(path) {
    if (get[path]) return get[path].body
    const result = await fetchApi(path)
    get[path] = result
    return result.body
  }
  async function recordBinary(key, url) {
    if (binary[key]) return
    const response = await fetch(url, { headers })
    if (!response.ok) { log(`  binary ${key} -> ${response.status}`); return }
    binary[key] = { type: response.headers.get('content-type') || 'application/octet-stream', base64: Buffer.from(await response.arrayBuffer()).toString('base64') }
  }

  // Realtime: one subscription to every Session gives list rows and per-Session snapshots.
  const listRoots = await fetchApi('/session-list/sidebar?mode=default&limit=100&childLimit=20')
  const ids = []
  const collect = rows => { for (const row of rows || []) if (!ids.includes(row.id)) ids.push(row.id) }
  collect(listRoots.body.sessions)
  for (const group of listRoots.body.children || []) collect(group.sessions)
  const realtime = await recordRealtime({ baseUrl, token, ids })
  const rows = Object.fromEntries(realtime.rows.map(row => [row.id, row]))
  for (const id of Object.keys(rows)) if (!ids.includes(id)) ids.push(id)

  const byId = (await fetchApi('/session-list/by-id', { method: 'POST', body: JSON.stringify({ ids, includePaths: true }) })).body
  const activity = (await fetchApi('/session-list/descendant-activity', { method: 'POST', body: JSON.stringify({ ids }) })).body
  const children = { children: [] }
  for (let index = 0; index < ids.length; index += 20) {
    const parents = ids.slice(index, index + 20).map(parentSessionId => ({ parentSessionId }))
    children.children.push(...(await fetchApi('/session-list/children', { method: 'POST', body: JSON.stringify({ mode: 'default', limit: 20, parents }) })).body.children || [])
  }
  for (const id of ids) {
    const history = await recordGet(`/sessions/${enc(id)}/history?tail=100`)
    const continuous = await recordGet(`/sessions/${enc(id)}/history/continuous`)
    await recordGet(`/sessions/${enc(id)}/questions`)
    for (const block of contextBlocks([history, continuous])) {
      await recordGet(`/sessions/${enc(id)}/context-blocks/${block}/expand?previewLength=4000`).catch(() => {})
      await recordGet(`/sessions/${enc(id)}/context-blocks/${block}/expand`).catch(() => {})
    }
    for (const ref of references([history, continuous])) {
      if (ref.apiPath) await recordBinary(`api:${ref.apiPath.split('?')[0]}`, `${baseUrl}/api${ref.apiPath}`)
      if (ref.downloadPath) await recordBinary(`path:${ref.downloadPath}`, `${baseUrl}/download?${new URLSearchParams({ path: ref.downloadPath })}`)
    }
  }
  for (const agent of (await recordGet('/agents')).agents || []) {
    const agentId = agent.id || agent.agentId || agent.name
    if (agentId) await recordGet(`/agents/${enc(agentId)}/memory`).catch(() => {})
  }
  const tasks = await recordGet('/tasks?limit=50')
  for (const task of tasks.tasks || []) await recordGet(`/tasks/${enc(task.id)}`).catch(() => {})

  // Browser crawl: every GET the real WebUI makes while visiting each surface.
  const browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on('response', async response => {
      const url = new URL(response.url())
      const request = response.request()
      if (!url.pathname.startsWith('/api/') || response.status() >= 300 && response.status() < 400) return
      const path = url.pathname.slice(4) + url.search
      try {
        const text = await response.text()
        const type = response.headers()['content-type'] || ''
        if (!type.includes('json')) return
        if (request.method() === 'GET') { get[path] ??= { status: response.status(), body: JSON.parse(text) } }
        else if (READ_POSTS.has(url.pathname.slice(4))) post[`${url.pathname.slice(4)} ${request.postData() || ''}`] ??= { status: response.status(), body: JSON.parse(text) }
      } catch {}
    })
    await page.setCookie({ name: 'foxwarm_token', value: token, url: `${baseUrl}/` })
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' })
    const visit = async (hash, extra = 1200) => {
      await page.evaluate(value => { location.hash = value }, hash)
      await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {})
      await sleep(extra)
    }
    const order = [...crawlFirst, ...ids.filter(id => !crawlFirst.includes(id))]
    for (const id of order) await visit(`#tab/chat:${id}`)
    for (const tab of ['system:tasks', 'system:agents', 'system:search', 'system:setup', 'system:logs']) await visit(`#tab/${tab}`)
    await visit('#nodes')
  } finally {
    await browser.close()
  }

  return {
    sessions: ids,
    rows,
    realtime: realtime.frames,
    byId: Object.fromEntries((byId.results || []).map(result => [result.requestedId, result])),
    activity: Object.fromEntries((activity.results || []).map(result => [result.sessionId, result])),
    children: Object.fromEntries((children.children || []).map(group => [group.parentSessionId, group.sessions])),
    revision: byId.revision,
    get,
    post,
    binary,
  }
}

// Read-only POST endpoints whose exact recorded answers are worth replaying.
const READ_POSTS = new Set(['/session-sequence', '/session-list/group-pages'])

function contextBlocks(values) {
  const found = new Set()
  walk(values, value => {
    const block = value?.__meta?.contextBlock
    if (block && (typeof block.id === 'number' || typeof block.id === 'string')) found.add(block.id)
  })
  return [...found]
}

function references(values) {
  const found = new Map()
  walk(values, value => {
    if (typeof value?.apiPath === 'string' && value.apiPath.startsWith('/')) found.set(`a:${value.apiPath}`, { apiPath: value.apiPath })
    if (typeof value?.downloadPath === 'string') found.set(`d:${value.downloadPath}`, { downloadPath: value.downloadPath })
  })
  return [...found.values()]
}

function walk(value, visit) {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return }
  if (!value || typeof value !== 'object') return
  visit(value)
  for (const item of Object.values(value)) walk(item, visit)
}

async function recordRealtime({ baseUrl, token, ids }) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/webui/stream`, { headers: { Authorization: `Bearer ${token}` } })
  const frames = {}
  const rows = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime snapshot timed out')), 20000)
    socket.onerror = event => { clearTimeout(timer); reject(new Error(`Realtime error: ${event.message || 'unknown'}`)) }
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.type === 'connected') {
        socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: true, sessionListIds: ids, sessionIds: ids }))
      } else if (message.type === 'session-list-delta') {
        rows.push(...(message.sessions || []))
      } else if (message.type === 'subscriptions-applied') {
        clearTimeout(timer)
        socket.close()
        resolve()
      } else if (message.sessionId && message.type !== 'subscriptions-accepted') {
        ;(frames[message.sessionId] ||= []).push(message)
      }
    }
  })
  return { frames, rows }
}
