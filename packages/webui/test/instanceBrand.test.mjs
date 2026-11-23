import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), 'foxwarm-instance-brand-'))
after(() => rm(temp, { recursive: true, force: true }))
const output = path.join(temp, 'brand.cjs')
await build({
  stdin: {
    contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import InstanceBrand from './src/components/InstanceBrand';
      export { hasHostChannel, requestInstanceMenu } from './src/windowFrame';
      export function render(branding, hosted) {
        return renderToStaticMarkup(React.createElement(InstanceBrand, { branding, hosted }));
      }`,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: output, bundle: true, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent',
})
const brand = createRequire(import.meta.url)(output)

test('the brand shows the instance emoji and name when set, otherwise the Foxwarm logo and name', () => {
  const plain = brand.render({ instanceName: '', tabIcon: '' }, false)
  assert.match(plain, /<svg[^>]*foxwarm-sidebar-brand-mark/)
  assert.match(plain, /<span class="foxwarm-sidebar-wordmark truncate" data-brand-default="">Foxwarm<\/span>/)
  assert.doesNotMatch(plain, /foxwarm-sidebar-brand-icon/)

  const branded = brand.render({ instanceName: '  Lab server ', tabIcon: ' 🧪 ' }, false)
  assert.doesNotMatch(branded, /<svg/)
  assert.match(branded, /<span class="foxwarm-sidebar-brand-icon shrink-0" aria-hidden="true">🧪<\/span>/)
  assert.match(branded, /<span class="foxwarm-sidebar-wordmark truncate">Lab server<\/span>/)

  // Each field falls back on its own.
  assert.match(brand.render({ instanceName: 'Lab server', tabIcon: '' }, false), /<svg[\s\S]*>Lab server</)
  assert.match(brand.render({ instanceName: '', tabIcon: '🧪' }, false), /🧪[\s\S]*data-brand-default="">Foxwarm</)
})

test('the brand is a menu button only inside a Desktop host', () => {
  const browser = brand.render({ instanceName: '', tabIcon: '' }, false)
  assert.doesNotMatch(browser, /<button/)
  const hosted = brand.render({ instanceName: '', tabIcon: '' }, true)
  assert.match(hosted, /<button type="button" data-instance-menu="" aria-haspopup="menu" title="Switch instance"/)
})

test('the instance-menu request goes to the host channel only when one exists', () => {
  const rect = { left: 12.4, top: 8.6, width: 120.2, height: 31.5 }
  const saved = { window: global.window }
  try {
    global.window = {}
    global.window.parent = global.window
    assert.equal(brand.hasHostChannel(), false)
    assert.equal(brand.requestInstanceMenu(rect), false)

    const webview = []
    global.window.chrome = { webview: { postMessage: message => webview.push(message) } }
    assert.equal(brand.hasHostChannel(), true)
    assert.equal(brand.requestInstanceMenu(rect), true)
    assert.deepEqual(webview, [{ type: 'instance-menu', anchor: [12, 9, 120, 32] }])

    const webkit = []
    global.window = { webkit: { messageHandlers: { foxwarmFrame: { postMessage: message => webkit.push(message) } } } }
    global.window.parent = global.window
    assert.equal(brand.requestInstanceMenu(rect), true)
    assert.deepEqual(webkit, [{ type: 'instance-menu', anchor: [12, 9, 120, 32] }])

    // A frame inside the page never reaches the host.
    const frame = { chrome: { webview: { postMessage: () => assert.fail('posted from a frame') } }, parent: {} }
    global.window = frame
    assert.equal(brand.hasHostChannel(), false)
    assert.equal(brand.requestInstanceMenu(rect), false)
  } finally {
    global.window = saved.window
  }
})
