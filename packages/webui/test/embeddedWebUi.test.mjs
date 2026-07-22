import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-embedded-webui-test-'))
const bundledPath = path.join(tempDir, 'embeddedWebUi.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/embeddedWebUi.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { parseFoxwarmEmbeddedTarget, postFoxwarmEmbedHostMessage, readFoxwarmActiveTargetMessage, readFoxwarmFocusModelsMessage } = await import(pathToFileURL(bundledPath).href)
const nonce = '0123456789abcdef0123456789abcdef'

test('parses only fixed sidebar, chat, Agents, and Setup embed targets with a bridge nonce', () => {
  assert.deepEqual(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=sidebar&foxwarmEmbedNonce=${nonce}`), { kind: 'sidebar', nonce })
  assert.deepEqual(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=agents&foxwarmEmbedNonce=${nonce}`), { kind: 'agents', nonce })
  assert.deepEqual(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=setup&foxwarmEmbedNonce=${nonce}`), { kind: 'setup', nonce })
  assert.deepEqual(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=chat&foxwarmEmbedNonce=${nonce}&sessionId=${encodeURIComponent('agent/task')}&title=Task`), {
    kind: 'chat', nonce, sessionId: 'agent/task', title: 'Task',
  })
  assert.equal(parseFoxwarmEmbeddedTarget('?foxwarmEmbed=sidebar'), null)
  assert.equal(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=chat&foxwarmEmbedNonce=${nonce}&sessionId=`), null)
  assert.equal(parseFoxwarmEmbeddedTarget(`?foxwarmEmbed=terminal&foxwarmEmbedNonce=${nonce}`), null)
})

test('accepts only nonce-bound fixed active-target messages from the Code host', () => {
  const base = { channel: 'foxwarm-webui-host', version: 1, nonce, type: 'active-target' }
  assert.deepEqual(readFoxwarmActiveTargetMessage({ ...base, target: { kind: 'session', sessionId: 'agent/task' } }, nonce), { kind: 'session', sessionId: 'agent/task' })
  assert.deepEqual(readFoxwarmActiveTargetMessage({ ...base, target: { kind: 'agents' } }, nonce), { kind: 'agents' })
  assert.deepEqual(readFoxwarmActiveTargetMessage({ ...base, target: { kind: 'setup' } }, nonce), { kind: 'setup' })
  assert.equal(readFoxwarmActiveTargetMessage({ ...base, target: null }, nonce), null)
  assert.equal(readFoxwarmActiveTargetMessage({ ...base, nonce: 'wrong', target: { kind: 'agents' } }, nonce), undefined)
  assert.equal(readFoxwarmActiveTargetMessage({ ...base, target: { kind: 'session', sessionId: '' } }, nonce), undefined)
})

test('accepts only the nonce-bound fixed Models focus signal from the Code host', () => {
  const message = { channel: 'foxwarm-webui-host', version: 1, nonce, type: 'focus-models' }
  assert.equal(readFoxwarmFocusModelsMessage(message, nonce), true)
  assert.equal(readFoxwarmFocusModelsMessage({ ...message, nonce: 'wrong' }, nonce), false)
  assert.equal(readFoxwarmFocusModelsMessage({ ...message, type: 'focus-config' }, nonce), false)
})

test('posts a versioned fixed-shape message only when embedded', () => {
  const messages = []
  const parent = { postMessage: (...args) => messages.push(args) }
  globalThis.window = { parent }
  postFoxwarmEmbedHostMessage(nonce, { type: 'open-session', sessionId: 'agent/task' })
  assert.deepEqual(messages, [[{
    channel: 'foxwarm-webui-embed', version: 1, nonce, type: 'open-session', sessionId: 'agent/task',
  }, '*']])
  postFoxwarmEmbedHostMessage(nonce, { type: 'open-terminal' })
  assert.deepEqual(messages[1], [{
    channel: 'foxwarm-webui-embed', version: 1, nonce, type: 'open-terminal',
  }, '*'])
  postFoxwarmEmbedHostMessage(nonce, { type: 'open-setup', focus: 'models' })
  assert.deepEqual(messages[2], [{
    channel: 'foxwarm-webui-embed', version: 1, nonce, type: 'open-setup', focus: 'models',
  }, '*'])
  globalThis.window = { parent: null }
  globalThis.window.parent = globalThis.window
  postFoxwarmEmbedHostMessage(nonce, { type: 'open-session', sessionId: 'ignored' })
  assert.equal(messages.length, 3)
})
