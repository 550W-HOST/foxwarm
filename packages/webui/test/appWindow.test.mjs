import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-app-window-test-'))
await esbuild.build({ entryPoints: [path.join(webuiRoot, 'src/appWindow.ts')], outfile: path.join(tempDir, 'appWindow.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' })
const appWindow = await import(pathToFileURL(path.join(tempDir, 'appWindow.mjs')).href)
test.after(() => rm(tempDir, { recursive: true, force: true }))

/** A minimal window: display-mode matches, an optional Desktop host frame, and its top document. */
function stubWindow({ displayMode = 'browser', host, top } = {}) {
  const win = {
    matchMedia: query => ({ matches: query === `(display-mode: ${displayMode})`, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  }
  if (host) win.foxwarmFrame = host
  win.top = top ?? win
  return win
}

function withWindow(win, run) {
  const previous = globalThis.window
  globalThis.window = win
  try { return run() } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

const windowsHost = { platform: 'windows', left: 0, right: 144, top: 48 }

test('app windows are the Desktop hosts and installed PWAs in standalone or window-controls overlay', () => {
  assert.equal(withWindow(stubWindow(), appWindow.isAppWindow), false)
  assert.equal(withWindow(stubWindow({ displayMode: 'standalone' }), appWindow.isAppWindow), true)
  assert.equal(withWindow(stubWindow({ displayMode: 'window-controls-overlay' }), appWindow.isAppWindow), true)
  assert.equal(withWindow(stubWindow({ displayMode: 'minimal-ui' }), appWindow.isAppWindow), false)
  assert.equal(withWindow(stubWindow({ host: windowsHost }), appWindow.isAppWindow), true)
  assert.equal(withWindow(stubWindow({ host: { platform: 'macos', left: 78, right: 0, top: 38 } }), appWindow.isAppWindow), true)
  // Only a valid host frame counts.
  assert.equal(withWindow(stubWindow({ host: { platform: 'linux', left: 0, right: 0, top: 30 } }), appWindow.isAppWindow), false)
  // Same-origin frames (Code's embedded WebUI) read the host frame of their top document.
  assert.equal(withWindow(stubWindow({ top: stubWindow({ host: windowsHost }) }), appWindow.isAppWindow), true)
  const crossOriginTop = {}
  Object.defineProperty(crossOriginTop, 'foxwarmFrame', { get() { throw new Error('SecurityError') } })
  assert.equal(withWindow(stubWindow({ top: crossOriginTop }), appWindow.isAppWindow), false)
})

test('Code copy says new window in app windows and new browser tab in the browser', () => {
  assert.deepEqual(appWindow.newWindowCopy(true), { codeTooltip: 'Open code in a new window', codeOption: 'Open in new window' })
  assert.deepEqual(appWindow.newWindowCopy(false), { codeTooltip: 'Open code in a new browser tab', codeOption: 'Open in new browser tab' })
})

test('link confirmation names a new window for same-origin links and the browser for others in app windows', () => {
  const base = 'http://127.0.0.1:49152/?foxwarmPopup=chat'
  assert.equal(appWindow.linkOpenConfirmation('https://example.com/a', false, base), 'Open this link in a new tab?\n\nhttps://example.com/a')
  assert.equal(appWindow.linkOpenConfirmation('/api/files/report.pdf', false, base), 'Open this link in a new tab?\n\n/api/files/report.pdf')
  assert.equal(appWindow.linkOpenConfirmation('/api/files/report.pdf', true, base), 'Open this link in a new window?\n\n/api/files/report.pdf')
  assert.equal(appWindow.linkOpenConfirmation('http://127.0.0.1:49152/vscode-web/', true, base), 'Open this link in a new window?\n\nhttp://127.0.0.1:49152/vscode-web/')
  assert.equal(appWindow.linkOpenConfirmation('https://example.com/a', true, base), 'Open this link in your browser?\n\nhttps://example.com/a')
  assert.equal(appWindow.linkOpenConfirmation('http://127.0.0.1:49153/', true, base), 'Open this link in your browser?\n\nhttp://127.0.0.1:49153/')
  assert.equal(appWindow.linkOpenConfirmation('http://[bad', true, base), 'Open this link in your browser?\n\nhttp://[bad')
})
