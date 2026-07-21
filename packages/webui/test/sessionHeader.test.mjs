import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

async function loadTypeScriptModule(relativePath) {
  const result = await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('session header subtitle appends cwd without an empty separator or path rewriting', async () => {
  const { formatSessionHeaderSubtitle } = await loadTypeScriptModule('../src/sessionHeader.ts')

  assert.equal(formatSessionHeaderSubtitle('agent/main', null), 'session agent/main')
  assert.equal(formatSessionHeaderSubtitle('agent/main', ''), 'session agent/main')
  assert.equal(formatSessionHeaderSubtitle('agent/main', '   '), 'session agent/main')
  assert.equal(formatSessionHeaderSubtitle('agent/main', 'relative/project'), 'session agent/main · relative/project')
  assert.equal(formatSessionHeaderSubtitle('agent/main', '/full/path/to/project'), 'session agent/main · /full/path/to/project')
})

test('session list keeps cwd searchable but renders it only in the Chat header', async () => {
  const [listSource, chatSource] = await Promise.all([
    readFile(new URL('../src/components/SessionListCore.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Chat.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(listSource, /session\.cwd \|\| undefined/)
  assert.doesNotMatch(listSource, /cwd:\s*\{session\.cwd\}/)
  assert.match(chatSource, /formatSessionHeaderSubtitle\(sessionId, sessionRecord\?\.cwd\)/)
  assert.match(chatSource, /data-session-header-subtitle/)
})