import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { isImeComposing, isSendKey, sendShortcutLabel } = await load('../src/sendKey.ts')
const key = (overrides = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, keyCode: 13, ...overrides })

test('Ctrl/Cmd+Enter sends in both modes; plain Enter only in enter mode', () => {
  for (const mode of ['modEnter', 'enter']) {
    assert.equal(isSendKey(key({ ctrlKey: true }), mode), true, mode)
    assert.equal(isSendKey(key({ metaKey: true }), mode), true, mode)
    assert.equal(isSendKey(key({ ctrlKey: true, shiftKey: true }), mode), true, mode)
  }
  assert.equal(isSendKey(key(), 'modEnter'), false)
  assert.equal(isSendKey(key(), 'enter'), true)
  assert.equal(isSendKey(key({ shiftKey: true }), 'enter'), false)
  assert.equal(isSendKey(key({ shiftKey: true }), 'modEnter'), false)
  assert.equal(isSendKey(key({ key: 'a', ctrlKey: true }), 'enter'), false)
})

test('nothing sends while an input method is composing, including the committing Enter', () => {
  assert.equal(isImeComposing(key({ isComposing: true })), true)
  assert.equal(isImeComposing(key({ keyCode: 229 })), true)
  assert.equal(isImeComposing(key()), false)
  for (const mode of ['modEnter', 'enter']) {
    assert.equal(isSendKey(key({ isComposing: true }), mode), false, mode)
    assert.equal(isSendKey(key({ keyCode: 229 }), mode), false, mode)
    assert.equal(isSendKey(key({ ctrlKey: true, keyCode: 229 }), mode), false, mode)
  }
})

test('the shortcut label follows the mode and platform', () => {
  assert.equal(sendShortcutLabel('enter', 'Win32'), 'Enter')
  assert.equal(sendShortcutLabel('modEnter', 'Win32'), 'Ctrl+Enter')
  assert.equal(sendShortcutLabel('modEnter', 'MacIntel'), 'Cmd+Enter')
})
