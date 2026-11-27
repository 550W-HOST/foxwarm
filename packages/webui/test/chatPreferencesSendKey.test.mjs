import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// The send key resolves as: the browser's stored choice, else the installation default
// from the WebUI settings, else Ctrl/Cmd+Enter.
const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: key => { storage.delete(key) },
}
globalThis.window = { location: { pathname: '/' }, innerWidth: 1280 }
let settingsResponse = null
const settingsRequests = []
globalThis.fetch = async (url) => {
  settingsRequests.push(String(url))
  if (settingsResponse instanceof Error) throw settingsResponse
  return { ok: !!settingsResponse, json: async () => settingsResponse }
}

async function load(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { readChatPreferences, loadInstallationChatDefaults, reloadInstallationChatDefaults } = await load('../src/chatPreferences.ts')
const KEY = 'foxwarm_send_key_mode_v1'

test('without a stored choice or installation default, Ctrl/Cmd+Enter sends', async () => {
  settingsResponse = new Error('offline')
  await loadInstallationChatDefaults()
  assert.equal(readChatPreferences().sendKeyMode, 'modEnter')
  assert.deepEqual(settingsRequests, ['/api/webui/settings'])
})

test('a new installation default applies only to browsers that never chose', async () => {
  settingsResponse = { settings: { sendKeyDefault: 'enter' } }
  await reloadInstallationChatDefaults()
  assert.equal(readChatPreferences().sendKeyMode, 'enter')
  assert.equal(storage.has(KEY), false, 'the default is not written to the browser')
  storage.set(KEY, 'modEnter')
  assert.equal(readChatPreferences().sendKeyMode, 'modEnter')
  storage.delete(KEY)
})

test('an existing installation (modEnter or no record) keeps Ctrl/Cmd+Enter; a stored Enter still wins', async () => {
  for (const settings of [{ sendKeyDefault: 'modEnter' }, { instanceName: '', tabIcon: '' }]) {
    settingsResponse = { settings }
    await reloadInstallationChatDefaults()
    assert.equal(readChatPreferences().sendKeyMode, 'modEnter')
  }
  storage.set(KEY, 'enter')
  assert.equal(readChatPreferences().sendKeyMode, 'enter')
  storage.delete(KEY)
})

test('the installation default is requested once per page until first run reloads it', async () => {
  const before = settingsRequests.length
  await loadInstallationChatDefaults()
  await loadInstallationChatDefaults()
  assert.equal(settingsRequests.length, before)
})
