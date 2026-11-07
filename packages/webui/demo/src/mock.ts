// Browser-side stand-in for the Foxwarm server in the static WebUI demo.
// Read requests are answered from the recorded snapshot; requests that would
// change state are refused with a short read-only notice.

type Json = any
type Recorded = { status: number; body: Json }
type Binary = { type: string; base64: string }

export type DemoSnapshot = {
  recordedAt: number
  sessions: string[]
  rows: Record<string, Json>
  realtime: Record<string, Json[]>
  byId: Record<string, Json>
  activity: Record<string, Json>
  children: Record<string, Json[]>
  revision: string
  get: Record<string, Recorded>
  post: Record<string, Recorded>
  binary: Record<string, Binary>
}

export const READ_ONLY_MESSAGE = 'Demo mode — read-only'

const deploymentBase = () => {
  const path = window.location.pathname.replace(/\/$/, '')
  return path
}

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sortedQuery(search: URLSearchParams): string {
  return [...search.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&')
}

let noticeTimer: number | undefined
export function showReadOnlyNotice(): void {
  let notice = document.getElementById('foxwarm-demo-notice')
  if (!notice) {
    notice = document.createElement('div')
    notice.id = 'foxwarm-demo-notice'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    notice.style.cssText = 'position:fixed;left:50%;bottom:24px;z-index:2147483000;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:rgba(28,25,23,.92);color:#fafaf9;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;transition:opacity .2s;opacity:0'
    document.body.appendChild(notice)
  }
  notice.textContent = READ_ONLY_MESSAGE
  notice.style.opacity = '1'
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { if (notice) notice.style.opacity = '0' }, 2400)
}

export function createDemoServer(snapshot: DemoSnapshot) {
  const base = deploymentBase()
  const apiBase = `${base}/api`
  const downloadPath = `${base}/download`
  const objectUrls = new Map<string, string>()
  const getIndex = new Map<string, Map<string, Recorded>>()
  for (const [key, value] of Object.entries(snapshot.get)) {
    const url = new URL(key, 'http://demo.invalid')
    let byQuery = getIndex.get(url.pathname)
    if (!byQuery) getIndex.set(url.pathname, byQuery = new Map())
    byQuery.set(sortedQuery(url.searchParams), value)
  }
  const known = new Set(snapshot.sessions)

  function binaryUrl(key: string): string | null {
    const cached = objectUrls.get(key)
    if (cached) return cached
    const entry = snapshot.binary[key]
    if (!entry) return null
    const bytes = Uint8Array.from(atob(entry.base64), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: entry.type }))
    objectUrls.set(key, url)
    return url
  }

  // Maps an API or download URL to the recorded resource it names, if any.
  function binaryKey(url: URL): string | null {
    if (url.origin !== window.location.origin) return null
    if (url.pathname === downloadPath) {
      const path = url.searchParams.get('path')
      return path ? `path:${path}` : null
    }
    if (!url.pathname.startsWith(`${apiBase}/`)) return null
    let path = url.pathname.slice(apiBase.length).replace(/\/download$/, '')
    const scoped = /^\/sessions\/[^/]+(\/blobs\/.+)$/.exec(path)
    if (scoped) path = scoped[1]
    return `api:${path}`
  }

  function resourceUrl(value: string): string | null {
    try {
      const key = binaryKey(new URL(value, window.location.href))
      return key ? binaryUrl(key) : null
    } catch {
      return null
    }
  }

  function handlesUrl(url: URL): boolean {
    return url.origin === window.location.origin && (url.pathname.startsWith(`${apiBase}/`) || url.pathname === downloadPath)
  }

  function sliceContinuous(id: string, params: URLSearchParams): Json | null {
    const page = getIndex.get(`/sessions/${encodeURIComponent(id)}/history/continuous`)?.get('')?.body
    if (!page || !Array.isArray(page.messages)) return null
    const before = Number(params.get('beforeSeq'))
    const after = Number(params.get('afterSeq'))
    const seqOf = (message: Json) => message?.__meta?.seq ?? message?.__meta?.contextBlock?.rawEndSeq ?? 0
    let messages: Json[] = page.messages
    if (params.has('beforeSeq')) messages = messages.filter(message => seqOf(message) < before)
    if (params.has('afterSeq')) messages = messages.filter(message => seqOf(message) > after)
    return { ...page, messages, firstSeq: messages.length ? seqOf(messages[0]) : undefined, lastSeq: messages.length ? seqOf(messages[messages.length - 1]) : undefined, hasMore: false }
  }

  function answerGet(url: URL): Response {
    const path = url.pathname.slice(apiBase.length)
    if (path === '/auth/session') return json({ role: 'admin' })
    const recorded = getIndex.get(path)?.get(sortedQuery(url.searchParams))
    if (recorded) return json(recorded.body, recorded.status)

    const continuous = /^\/sessions\/([^/]+)\/history\/continuous$/.exec(path)
    if (continuous) {
      const page = sliceContinuous(decodeURIComponent(continuous[1]), url.searchParams)
      if (page) return json(page)
    }
    const history = /^\/sessions\/([^/]+)\/history$/.exec(path)
    if (history && url.searchParams.has('tail')) {
      const entry = getIndex.get(path)?.get('tail=100')
      if (entry) return json(entry.body, entry.status)
    }
    if (path === '/session-list/sidebar' || path === '/session-list/architecture') {
      const params = new URLSearchParams(url.searchParams)
      params.delete('focusSessionId')
      const entry = getIndex.get(path)?.get(sortedQuery(params))
      if (entry) return json(entry.body, entry.status)
    }
    if (path === '/session-list/search') {
      const query = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim().toLowerCase()
      const limit = Number(url.searchParams.get('limit')) || 50
      const matches = snapshot.sessions.map(id => snapshot.rows[id]).filter(row => row && `${row.id} ${row.displayName || ''} ${row.agent || ''}`.toLowerCase().includes(query))
      return json({ version: 1, revision: snapshot.revision, sessions: matches.slice(0, limit), hasMore: matches.length > limit })
    }
    const state = /^\/sessions\/([^/]+)\/state$/.exec(path)
    if (state) {
      const row = snapshot.rows[decodeURIComponent(state[1])]
      if (row) return json(row)
    }
    if (path === '/history/search') return json({ error: 'History search is not available in the demo.', code: 'DEMO_UNAVAILABLE' }, 503)
    console.warn('[Foxwarm demo] No recorded answer for', `${path}${url.search}`)
    return json({ error: 'Not available in the demo.', code: 'DEMO_UNAVAILABLE' }, 404)
  }

  function answerPost(url: URL, body: Json, rawBody: string): Response {
    const path = url.pathname.slice(apiBase.length)
    if (path === '/session-list/by-id') {
      const ids: string[] = Array.isArray(body?.ids) ? body.ids : []
      return json({ version: 1, revision: snapshot.revision, results: ids.map(id => snapshot.byId[id] ?? { requestedId: id, resolution: { kind: 'missing' }, session: null }) })
    }
    if (path === '/session-list/descendant-activity') {
      const ids: string[] = Array.isArray(body?.ids) ? body.ids : []
      return json({ version: 1, revision: snapshot.revision, results: ids.map(id => snapshot.activity[id] ?? { sessionId: id, busy: 0 }) })
    }
    if (path === '/session-list/children') {
      const limit = Number(body?.limit) || 5
      const parents: Json[] = Array.isArray(body?.parents) ? body.parents : []
      return json({
        version: 1, revision: snapshot.revision, reset: false,
        children: parents.map(parent => {
          const all = snapshot.children[parent?.parentSessionId] || []
          return { parentSessionId: parent?.parentSessionId, sessions: all.slice(0, limit), total: all.length, nextCursor: all.length > limit ? String(limit) : null }
        }),
      })
    }
    if (path === '/download/sign' || /\/blobs\/[^/]+\/download$/.test(path)) {
      const target = path === '/download/sign'
        ? binaryUrl(`path:${body?.path ?? ''}`)
        : binaryUrl(`api:${path.replace(/^\/sessions\/[^/]+/, '').replace(/\/download$/, '')}`)
      return target ? json({ url: target }) : json({ error: 'File unavailable' }, 404)
    }
    const recorded = snapshot.post[`${path} ${rawBody}`]
    if (recorded) return json(recorded.body, recorded.status)
    if (path === '/session-sequence' || path === '/session-list/group-pages') {
      console.warn('[Foxwarm demo] No recorded answer for', path, rawBody)
      return json({ error: 'Not available in the demo.', code: 'DEMO_UNAVAILABLE' }, 404)
    }
    return readOnly()
  }

  function readOnly(): Response {
    showReadOnlyNotice()
    return json({ error: READ_ONLY_MESSAGE, code: 'DEMO_READ_ONLY' }, 403)
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      const key = binaryKey(url)
      const object = key && snapshot.binary[key] ? binaryUrl(key) : null
      if (object) return fetchOriginal(object)
      if (url.pathname === downloadPath) return json({ error: 'File unavailable' }, 404)
      return answerGet(url)
    }
    if (method === 'POST') {
      const rawBody = await request.text().catch(() => '')
      let body: Json = null
      try { body = rawBody ? JSON.parse(rawBody) : null } catch { body = null }
      return answerPost(url, body, rawBody)
    }
    return readOnly()
  }

  const fetchOriginal = window.fetch.bind(window)
  return { handle, handlesUrl, resourceUrl, known, snapshot, apiBase, readOnly }
}

export type DemoServer = ReturnType<typeof createDemoServer>
