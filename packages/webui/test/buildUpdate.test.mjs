import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({ entryPoints: [new URL('../src/buildUpdate.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { watchFrontendBuild } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const reloadBundle = await build({ entryPoints: [new URL('../src/updateReload.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { requestUpdateReload, BEFORE_UPDATE_RELOAD } = await import(`data:text/javascript;base64,${Buffer.from(reloadBundle.outputFiles[0].text).toString('base64')}`)

function fixture(t) {
  const names = ['window', 'document', 'location', 'DOMParser', 'fetch']
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  t.after(() => names.forEach((name, i) => originals[i] ? Object.defineProperty(globalThis, name, originals[i]) : delete globalThis[name]))
  const window = new EventTarget(), document = new EventTarget()
  const requests = [], intervals = new Map(), timeouts = new Map()
  let timer = 0, now = 20000, confirms = 0, reloads = 0
  window.self = window.top = window
  window.frames = []
  window.setInterval = fn => { intervals.set(++timer, fn); return timer }
  window.clearInterval = id => intervals.delete(id)
  window.setTimeout = fn => { timeouts.set(++timer, fn); return timer }
  window.clearTimeout = id => timeouts.delete(id)
  window.confirm = () => { confirms++; return true }
  document.visibilityState = 'visible'
  document.getElementById = () => ({})
  document.querySelectorAll = () => [{ getAttribute: () => './assets/current.js' }]
  Object.assign(globalThis, { window, document, location: { href: 'https://test.invalid/nested/', search: '', reload: () => { reloads++ } },
    DOMParser: class { parseFromString(src) { return { getElementById: () => ({}), querySelectorAll: () => [{ getAttribute: () => src }] } } },
    fetch: (_url, options) => new Promise(resolve => requests.push({ options, resolve })),
  })
  t.mock.method(Date, 'now', () => now)
  return { window, document, requests, intervals, timeouts, advance: () => { now += 16000 },
    counts: () => ({ confirms, reloads }),
    respond: async (index, src = './assets/next.js') => {
      requests[index].resolve({ ok: true, headers: new Headers({ 'content-type': 'text/html' }), text: async () => src })
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

test('polling coalesces events, skips hidden documents and aborts/cleans up on unmount', async t => {
  const f = fixture(t), updates = []
  const stop = watchFrontendBuild(value => updates.push(value))
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.cache, 'no-store')
  f.advance(); f.window.dispatchEvent(new Event('focus'))
  assert.equal(f.requests.length, 1, 'one request in flight')
  await f.respond(0); assert.deepEqual(updates, ['/nested/assets/next.js'])
  f.window.dispatchEvent(new Event('focus')); assert.equal(f.requests.length, 2)
  await f.respond(1, './assets/current.js'); assert.deepEqual(updates, ['/nested/assets/next.js', null])
  f.window.dispatchEvent(new Event('online')); assert.equal(f.requests.length, 2, 'events are throttled')
  f.advance(); f.document.visibilityState = 'hidden'; [...f.intervals.values()][0]()
  assert.equal(f.requests.length, 2)
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.requests.length, 3)
  stop()
  assert.equal(f.requests[2].options.signal.aborted, true)
  assert.equal(f.intervals.size, 0)
  await f.respond(2); assert.equal(updates.length, 2, 'late responses cannot notify after disposal')
  assert.equal(f.timeouts.size, 0)
  f.advance(); f.window.dispatchEvent(new Event('focus')); f.window.dispatchEvent(new Event('online'))
  f.document.dispatchEvent(new Event('visibilitychange')); assert.equal(f.requests.length, 3)
})

test('popups, valid embedded leaves, iframes and development entries do not install a poller', t => {
  const f = fixture(t)
  for (const search of ['?foxwarmPopup=agents&foxwarmPopupVersion=1', '?foxwarmEmbed=agents&foxwarmEmbedNonce=abcdefghijklmnop']) {
    location.search = search; watchFrontendBuild(() => {})()
  }
  location.search = ''; f.window.top = {}; watchFrontendBuild(() => {})()
  f.window.top = f.window; f.document.querySelectorAll = () => [{ getAttribute: () => '/src/main.tsx' }]
  watchFrontendBuild(() => {})()
  assert.equal(f.requests.length, 0); assert.equal(f.intervals.size, 0)
})

test('every reload prepares first, and a guard cancels confirmation and navigation', t => {
  const f = fixture(t)
  f.window.addEventListener(BEFORE_UPDATE_RELOAD, event => event.preventDefault(), { once: true })
  assert.equal(requestUpdateReload(), false)
  assert.deepEqual(f.counts(), { confirms: 0, reloads: 0 })
  assert.equal(requestUpdateReload(), true)
  assert.deepEqual(f.counts(), { confirms: 1, reloads: 1 })
  assert.equal(requestUpdateReload(false), true)
  assert.deepEqual(f.counts(), { confirms: 1, reloads: 2 })
})


test('a nested same-origin composer can block top-level reload without owning a notice', t => {
  const f = fixture(t), child = new EventTarget(), nested = new EventTarget()
  child.frames = [nested]; nested.frames = []
  f.window.frames = [child, { get document() { throw new Error('Cross-origin') } }]
  nested.addEventListener(BEFORE_UPDATE_RELOAD, event => event.preventDefault(), { once: true })
  assert.equal(requestUpdateReload(), false)
  assert.deepEqual(f.counts(), { confirms: 0, reloads: 0 })
  assert.equal(requestUpdateReload(), true)
  assert.deepEqual(f.counts(), { confirms: 1, reloads: 1 })
})
