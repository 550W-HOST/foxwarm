import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadModule(entry) {
  const result = await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

// The registry module reads the deployment base path when it loads.
globalThis.window ??= { location: { pathname: '/' } }
const shortcuts = await loadModule('terminalShortcuts.ts')
const registry = await loadModule('terminalRegistry.ts')

const key = (code, modifiers = {}, type = 'keydown') => ({
  type,
  code,
  key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
})

test('Ctrl+C copies only with a selection off Apple platforms', () => {
  const { terminalShortcutAction } = shortcuts
  const ctrlC = key('KeyC', { ctrlKey: true })
  assert.equal(terminalShortcutAction(ctrlC, { apple: false, hasSelection: true }), 'copy')
  assert.equal(terminalShortcutAction(ctrlC, { apple: false, hasSelection: false }), null, 'without a selection ^C reaches the PTY')
  assert.equal(terminalShortcutAction(ctrlC, { apple: true, hasSelection: true }), null, 'macOS keeps Ctrl+C as ^C; Cmd+C copies')
  assert.equal(terminalShortcutAction(key('KeyC', { ctrlKey: true }, 'keyup'), { apple: false, hasSelection: true }), null)
})

test('Ctrl+Shift+C/V copy and paste off Apple platforms', () => {
  const { terminalShortcutAction } = shortcuts
  const options = { apple: false, hasSelection: false }
  assert.equal(terminalShortcutAction(key('KeyC', { ctrlKey: true, shiftKey: true }), options), 'copy')
  assert.equal(terminalShortcutAction(key('KeyV', { ctrlKey: true, shiftKey: true }), options), 'native-paste')
  assert.equal(terminalShortcutAction(key('KeyV', { ctrlKey: true }), options), null, 'Ctrl+V stays ^V')
  assert.equal(terminalShortcutAction(key('KeyX', { ctrlKey: true, shiftKey: true }), options), null)
  assert.equal(terminalShortcutAction(key('KeyC', { ctrlKey: true, shiftKey: true }), { apple: true, hasSelection: true }), null)
  assert.equal(terminalShortcutAction(key('KeyC', { ctrlKey: true, shiftKey: true, altKey: true }), options), null)
})

test('Ctrl+Backspace erases a word and Ctrl+0 resets the font', () => {
  const { terminalShortcutAction } = shortcuts
  assert.equal(terminalShortcutAction(key('Backspace', { ctrlKey: true }), { apple: false, hasSelection: false }), 'word-erase')
  assert.equal(terminalShortcutAction(key('Backspace', { ctrlKey: true }), { apple: true, hasSelection: false }), null)
  assert.equal(terminalShortcutAction(key('Backspace'), { apple: false, hasSelection: false }), null)
  assert.equal(terminalShortcutAction(key('Digit0', { ctrlKey: true }), { apple: false, hasSelection: false }), 'font-reset')
  assert.equal(terminalShortcutAction(key('Digit0', { ctrlKey: true }), { apple: true, hasSelection: false }), 'font-reset', 'pairs with the Ctrl font steps everywhere')
  assert.equal(terminalShortcutAction(key('Digit0', { ctrlKey: true, metaKey: true }), { apple: true, hasSelection: false }), null)
})

test('the page-close guard applies off Apple platforms outside the Desktop hosts', () => {
  const { terminalUnloadGuardApplies, isApplePlatform } = shortcuts
  assert.equal(terminalUnloadGuardApplies({ apple: false, desktopHost: false }), true)
  assert.equal(terminalUnloadGuardApplies({ apple: true, desktopHost: false }), false)
  assert.equal(terminalUnloadGuardApplies({ apple: false, desktopHost: true }), false)
  assert.equal(isApplePlatform('MacIntel'), true)
  assert.equal(isApplePlatform('iPad'), true)
  assert.equal(isApplePlatform('Linux x86_64'), false)
  assert.equal(isApplePlatform('Win32'), false)
})

test('registry rows parse defensively and format for the list', () => {
  const { parseTerminalRegistry, terminalShellName, formatTerminalAge, terminalKillConfirmation } = registry
  assert.deepEqual(parseTerminalRegistry({ terminals: [{ id: 'a', cwd: '/w', nodeId: 'n1', shell: '/bin/bash', pid: 7, createdAt: 5, cols: 80 }, { cwd: '/missing-id' }, null] }), [
    { id: 'a', cwd: '/w', nodeId: 'n1', shell: '/bin/bash', pid: 7, createdAt: 5 },
  ])
  assert.deepEqual(parseTerminalRegistry({ terminals: [{ id: 'b' }] }), [{ id: 'b', cwd: '/', nodeId: 'master', shell: '', pid: 0, createdAt: 0 }])
  assert.deepEqual(parseTerminalRegistry({}), [])
  assert.equal(terminalShellName('/usr/bin/zsh'), 'zsh')
  assert.equal(terminalShellName('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh')
  assert.equal(terminalShellName(''), '')
  const now = 10 * 24 * 3600_000
  assert.equal(formatTerminalAge(now - 20_000, now), 'now')
  assert.equal(formatTerminalAge(now - 5 * 60_000, now), '5m')
  assert.equal(formatTerminalAge(now - 3 * 3600_000, now), '3h')
  assert.equal(formatTerminalAge(now - 2 * 24 * 3600_000, now), '2d')
  assert.equal(formatTerminalAge(0, now), '')
  assert.equal(terminalKillConfirmation({ cwd: '/srv', nodeId: 'gpu' }), 'Kill the terminal in /srv on gpu? Programs running in it will stop.')
})
