import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: [new URL('../src/commandIngress.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm' })
const { isKnownCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const catalog = JSON.parse(await readFile(new URL('../../../dotnet/Foxwarm/Channels/CommandCatalog.json', import.meta.url), 'utf8'))

test('every catalog head uses the backend case-sensitive Source token boundaries', () => {
  for (const { name } of catalog) {
    for (const prefix of ['', ' \t', '\uFEFF', '\u2007']) {
      assert.equal(isKnownCommand(prefix + name), true)
      assert.equal(isKnownCommand(prefix + name + '\nmalformed args'), true)
      assert.equal(isKnownCommand(prefix + name + '/file'), false)
      assert.equal(isKnownCommand(prefix + name + '-unknown'), false)
    }
  }
})

test('unknown slash text, typos, paths and non-Source whitespace remain messages', () => {
  for (const text of ['/', '/stpo', '/Stop', '/unknown explain this', '/home/example/file', '/session/archive', '/stop.txt', '/stop-extra', '\u0085/stop', '/stop\u0085compact', '/session\u0085move renamed', '@helper /stop']) {
    assert.equal(isKnownCommand(text), false, text)
  }
})
