import { get as httpGet } from 'node:http'
// Small helpers shared by the drill environments and the drills.
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Polls `probe` until it returns a truthy value; throws after `timeout` ms. */
export async function until(probe, what, timeout = 60000, interval = 200) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeout} ms waiting until ${what}` + (last ? `: ${last.message}` : ''))
    await sleep(interval)
  }
}

export async function getJson(url, timeout = 5000, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return await response.json()
}

/** An API client of the public entry, authenticated with the sign-in token. */
export function apiClient(base, token) {
  const call = async (method, path, body, timeout = 15000) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await response.text()
    let parsed = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    return { status: response.status, body: parsed }
  }
  return {
    base,
    token,
    get: (path, timeout) => call('GET', path, undefined, timeout),
    post: (path, body, timeout) => call('POST', path, body ?? {}, timeout),
  }
}

/**
 * One GET on a new connection (no keep-alive), as a probe sees the entry: a pooled connection to
 * a replica that has since stopped would measure the client's connection reuse instead.
 */
// One GET on a new connection. Settles exactly once: on the complete response, on any request
// or response error (including a 200 that closes mid-body), or at `timeout` after the start.
export function probe(url, token, timeout = 3000) {
  return new Promise(resolve => {
    let settled = false
    const settle = result => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(result)
    }
    const request = httpGet(url, { agent: false, headers: { authorization: 'Bearer ' + token } }, response => {
      response.on('error', error => settle({ ok: false, status: response.statusCode, error: error.code || error.message }))
      response.on('aborted', () => settle({ ok: false, status: response.statusCode, error: 'response aborted' }))
      response.on('close', () => {
        if (!response.complete) settle({ ok: false, status: response.statusCode, error: 'response closed before its end' })
      })
      response.on('end', () => settle({ ok: response.statusCode === 200, status: response.statusCode }))
      response.resume()
    })
    const deadline = setTimeout(() => {
      settle({ ok: false, error: 'timeout' })
      request.destroy(new Error('timeout'))
    }, timeout)
    request.on('error', error => settle({ ok: false, error: error.code || error.message }))
  })
}

export function log(...parts) {
  console.log(`[drill ${new Date().toISOString()}]`, ...parts)
}

export function assert(condition, message) {
  if (!condition) throw new Error('Drill check failed: ' + message)
}
