import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-chat-shared-test-'))
const bundledPath = path.join(tempDir, 'chatShared.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/components/chatShared.tsx')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  formatStructuredSystemText,
  isFoxwarmMetadataLine,
  isHeavySystemTextLine,
  isCollapsibleSystemText,
  isLightweightStructuredSystem,
  isSystemLikeText,
  isLightweightSystemTextLine,
  parseFoxwarmMetadataLine,
} = await import(pathToFileURL(bundledPath).href)

test('foxwarm metadata tags are recognized as system-like small metadata lines', () => {
  const lines = [
    '<foxwarm-system kind="time" />',
    '<foxwarm-metadata hint="compat" />',
    '<foxwarm-message type="channel">',
    '</foxwarm-message>',
  ]

  for (const line of lines) {
    assert.equal(isFoxwarmMetadataLine(line), true)
    assert.equal(isSystemLikeText(line), true)
    assert.equal(isLightweightSystemTextLine(line), true)
    assert.equal(isHeavySystemTextLine(line), false)
    assert.equal(formatStructuredSystemText(line), line)
  }
})

test('non-channel foxwarm-message wrappers are heavy system-like messages for left-side rendering', () => {
  for (const type of ['inter-agent', 'timer', 'trigger']) {
    const line = `<foxwarm-message type="${type}">`
    assert.equal(isFoxwarmMetadataLine(line), true)
    assert.equal(isSystemLikeText(line), true)
    assert.equal(isLightweightSystemTextLine(line), false)
    assert.equal(isHeavySystemTextLine(line), true)
    assert.equal(isCollapsibleSystemText(`${line}\nmessage body\n</foxwarm-message>`), true)
  }

  const channelLine = '<foxwarm-message type="channel">'
  assert.equal(isLightweightSystemTextLine(channelLine), true)
  assert.equal(isHeavySystemTextLine(channelLine), false)
})

test('foxwarm system event tags are heavy system-like messages for left-side rendering', () => {
  const lines = [
    '<foxwarm-system kind="event" type="wait-timeout" seconds="120" hint="wait timeout reached after 120s" />',
    '<foxwarm-system kind="event" type="wait-all-pending" pendingSessions="child-a" hint="waitAllSessions is still pending" />',
  ]

  for (const line of lines) {
    assert.equal(isFoxwarmMetadataLine(line), true)
    assert.equal(isSystemLikeText(line), true)
    assert.equal(isLightweightSystemTextLine(line), false)
    assert.equal(isHeavySystemTextLine(line), true)
    assert.equal(isLightweightStructuredSystem(line), false)
  }
})

test('foxwarm snapshot system tags are system-like and collapsible, not lightweight', () => {
  const selfClosing = '<foxwarm-system kind="snapshot" hint="snapshot" />'
  const openTag = '<foxwarm-system kind="snapshot" hint="snapshot">'

  for (const line of [selfClosing, openTag]) {
    assert.equal(isFoxwarmMetadataLine(line), true)
    assert.equal(isSystemLikeText(line), true)
    assert.equal(isLightweightSystemTextLine(line), false)
    assert.equal(isHeavySystemTextLine(line), true)
    assert.equal(isCollapsibleSystemText(`${line}\nfull system prompt body`), true)
    assert.equal(formatStructuredSystemText(line), line)
  }

  assert.equal(isLightweightStructuredSystem(selfClosing), false)
  assert.deepEqual(parseFoxwarmMetadataLine(selfClosing), {
    tagName: 'foxwarm-system',
    closing: false,
    attrs: { kind: 'snapshot', hint: 'snapshot' },
  })
})

test('legacy system prefixes remain supported', () => {
  assert.equal(isSystemLikeText('[SYSTEM: current time = now]'), true)
  assert.equal(isSystemLikeText('[FROM: telegram:chat]'), true)
  assert.equal(isHeavySystemTextLine('[SYSTEM: snapshot]'), true)
  assert.equal(isCollapsibleSystemText('[SYSTEM: snapshot]\nfull system prompt body'), true)
  assert.equal(formatStructuredSystemText('current session ID = demo'), '[SYSTEM: current session ID = demo]')
})

test('ordinary xml-looking text is not treated as foxwarm metadata', () => {
  assert.equal(isFoxwarmMetadataLine('<not-foxwarm-message>'), false)
  assert.equal(isSystemLikeText('<not-foxwarm-message>'), false)
})
