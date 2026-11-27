// Recording loopback proxy in front of an owned managed Main for component fixtures. It serves the
// fixture page at the deployment prefix and forwards every other request unchanged, so component
// bundles call the real managed routes while the test observes, delays or replaces exchanges.
import { createServer, request as forward } from 'node:http'
import { once } from 'node:events'

export async function createMainHostProxy({ target, prefix, page, intercept }) {
  const requests = []
  const upstream = new URL(target)
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://fixture')
    const record = { method: req.method, url: req.url, path: url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : url.pathname, cookie: req.headers.cookie || '', body: body.toString() }
    requests.push(record)
    if (req.method === 'GET' && (url.pathname === prefix + '/' || url.pathname === prefix)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(await page()); return
    }
    // Forward the exchange; `buffered` lets an interceptor hold the complete upstream response.
    const send = (options = {}) => new Promise((resolve, reject) => {
      const outgoing = forward({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } }, response => {
        if (!options.buffered) { res.writeHead(response.statusCode, response.headers); response.pipe(res); response.once('end', resolve); return }
        const parts = []; response.on('data', part => parts.push(part))
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }))
      })
      outgoing.once('error', reject); outgoing.end(body)
    })
    const respond = ({ status, headers = {}, body = '' }) => { res.writeHead(status, headers); res.end(body) }
    try {
      if (!await intercept?.(record, { send, respond, res })) await send()
    } catch (error) { if (!res.headersSent) { res.writeHead(502); res.end(String(error)) } else res.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, url: origin + prefix + '/', requests,
    close: () => { server.closeAllConnections(); return new Promise(done => server.close(done)) },
  }
}
