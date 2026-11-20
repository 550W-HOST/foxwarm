// The small part of a Matrix homeserver the Matrix channel uses: it lets the
// generator deliver a message from another chat app, with a real sender,
// through the runtime's ordinary channel ingress.
import { createServer } from 'node:http'
import { once } from 'node:events'

export const matrixRoom = '!release-desk:example.org'
export const matrixBot = '@foxwarm:example.org'
export const matrixToken = 'demo-matrix-token'

export async function startMatrixStub({ log = () => {} } = {}) {
  const pending = []
  const sent = []
  const waiters = new Set()
  let batch = 0
  let event = 0
  const reply = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const syncBody = events => ({
    next_batch: `s${++batch}`,
    rooms: events.length ? { join: { [matrixRoom]: { timeline: { events } } } } : {},
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : null
    const path = url.pathname
    log(`matrix ${req.method} ${path}`)
    if (path === '/_matrix/client/versions') return reply(res, { versions: ['v1.4', 'v1.11'] })
    if (path === '/_matrix/client/v3/capabilities') return reply(res, { capabilities: {} })
    if (path.startsWith('/_matrix/client/v3/pushrules')) return reply(res, { global: {} })
    if (/\/filter$/.test(path)) return reply(res, { filter_id: 'demo-filter' })
    if (path === '/_matrix/client/v3/sync') {
      if (pending.length) return reply(res, syncBody(pending.splice(0)))
      const timeout = Math.min(Number(url.searchParams.get('timeout')) || 0, 1000)
      const done = () => { waiters.delete(done); reply(res, syncBody(pending.splice(0))) }
      waiters.add(done)
      setTimeout(() => { if (waiters.has(done)) done() }, timeout)
      return
    }
    if (/\/send\//.test(path)) {
      sent.push(body)
      return reply(res, { event_id: `$sent${sent.length}` })
    }
    if (/\/typing\/|\/receipt\/|\/read_markers/.test(path)) return reply(res, {})
    return reply(res, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' }, 404)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sent,
    // Queues one text message from `sender` and wakes any waiting sync.
    deliver(sender, text) {
      pending.push({
        type: 'm.room.message',
        sender,
        event_id: `$demo${++event}`,
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: text },
      })
      for (const waiter of [...waiters]) waiter()
    },
    close: () => new Promise(done => server.close(done)),
  }
}
