import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: [new URL('../src/commandIngress.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm' })
const { isKnownCommand } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const registry = JSON.parse(await readFile(new URL('../../../dotnet/Foxwarm/Tools/Ctl/CtlCommands.json', import.meta.url), 'utf8'))
const headsBundle = await build({ entryPoints: [new URL('../src/userCommandHeads.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm' })
const { userCommandHeads } = await import(`data:text/javascript;base64,${Buffer.from(headsBundle.outputFiles[0].text).toString('base64')}`)
const heads = userCommandHeads(registry)

test('user command heads come from the registry', () => {
  for (const head of ['/help', '/stop', '/compact', '/whoami', '/session', '/history', '/timer', '/node', '/channel']) assert(heads.includes(head), head)
  for (const retired of ['/messages', '/search', '/attach', '/verbose', '/delete-messages', '/memory', '/tool']) assert(!heads.includes(retired), retired)
})

test('every command head uses the backend case-sensitive Source token boundaries', () => {
  for (const name of heads) {
    for (const prefix of ['', ' \t', '\uFEFF', '\u2007']) {
      assert.equal(isKnownCommand(prefix + name), true)
      assert.equal(isKnownCommand(prefix + name + '\nmalformed args'), true)
      assert.equal(isKnownCommand(prefix + name + '/file'), false)
      assert.equal(isKnownCommand(prefix + name + '-unknown'), false)
    }
  }
})

test('unknown slash text, typos, paths and non-Source whitespace remain messages', () => {
  for (const text of ['/messages 5', '/search query', '/', '/stpo', '/Stop', '/unknown explain this', '/home/example/file', '/session/archive', '/stop.txt', '/stop-extra', '\u0085/stop', '/stop\u0085compact', '/session\u0085move renamed', '@helper /stop']) {
    assert.equal(isKnownCommand(text), false, text)
  }
})
