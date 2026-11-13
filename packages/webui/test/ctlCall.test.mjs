import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'ctl-call-'))
after(() => rm(dir, { recursive: true, force: true }))
const load = async (entry, name, plugins = []) => {
  const file = join(dir, name)
  await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent', plugins })
  return import(pathToFileURL(file).href)
}
// The production bundle carries the registry without help text (build/ctlRegistry.ts).
const { slimCtlRegistry } = await load('../build/ctlRegistry.ts', 'slim.mjs')
const slim = { name: 'slim', setup(b) { b.onLoad({ filter: /CtlCommands\.json$/ }, async args => ({ contents: JSON.stringify(slimCtlRegistry(JSON.parse(await readFile(args.path, 'utf8')))), loader: 'json' })) } }
const corpus = JSON.parse(await readFile(new URL('../../../dotnet/Foxwarm.Tests/Tools/Fixtures/ctl-conformance.json', import.meta.url), 'utf8'))
globalThis.window ??= { location: { pathname: '/', origin: 'http://localhost' } }
const { ctlDescriptor, ctlAsUnified, ctlConcrete } = await load('../src/ctlCall.ts', 'ctl.mjs')
const slimCtl = await load('../src/ctlCall.ts', 'ctl-slim.mjs', [slim])

// The same corpus is checked by the C# parser (CtlCommandTests.Conformance_corpus_matches_the_parser).
test('display parser matches the shared conformance corpus with the full and bundled registry', () => {
  for (const parser of [ctlDescriptor, slimCtl.ctlDescriptor]) {
    for (const item of corpus.cases) {
      const args = { command: item.command, ...(item.values ? { values: item.values } : {}) }
      assert.deepEqual(parser(args) ?? null, item.descriptor, item.command)
    }
  }
})

test('ctl calls render as the concrete call they run', () => {
  assert.deepEqual(ctlConcrete({ id: 'c', name: 'ctl', args: { command: 'memory edit MEMORY.md --old-text=a --new-text=b' } }), { id: 'c', name: 'edit_memory', args: { filePath: 'MEMORY.md', oldText: 'a', newText: 'b' } })
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: { command: 'file send out.zip' } }), { name: 'send_file', args: { filePath: 'out.zip' } })
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: { command: 'tool call node:box/edit --args @a', values: { a: { filePath: 'x', oldText: 'a', newText: 'b' } } } }), { name: 'edit', args: { filePath: 'x', oldText: 'a', newText: 'b' } })
  assert.equal(ctlConcrete({ name: 'ctl', args: { command: 'tool call mcp:srv/x' } }).name, 'call_tool')
  const help = { name: 'ctl', args: { command: 'help' } }
  assert.equal(ctlConcrete(help), help)
})
const questions = await load('../src/sessionQuestions.ts', 'questions.mjs')
const communications = await load('../src/components/sessionCommunications.ts', 'communications.mjs')

test('ctl commands display as the capability they name', () => {
  assert.deepEqual(ctlDescriptor({ command: 'skill load node-setup' }), { toolId: 'builtin:skill', args: { action: 'load', skillName: 'node-setup' } })
  assert.deepEqual(ctlDescriptor({ command: "ctl memory write 'a b.md' @body", values: { body: 'x\ny' } }), { toolId: 'builtin:write_memory', args: { filePath: 'a b.md', content: 'x\ny' } })
  assert.deepEqual(ctlDescriptor({ command: 'node copy master a --target-path=c box --overwrite' }).args, { sourceNode: 'master', sourcePath: 'a', targetNode: 'box', targetPath: 'c', overwrite: true })
  assert.deepEqual(ctlDescriptor({ command: 'session list --count 5' }).args, { action: 'list', count: 5 })
  assert.deepEqual(ctlDescriptor({ command: 'tool call node:box/read --args @a', valuesJson: '{"a":{"filePath":"x"}}' }), { toolId: 'node:box/read', args: { filePath: 'x' } })
  assert.equal(ctlDescriptor({ command: 'channel send webui:s done; ok' }).args.message, 'done; ok')
  assert.equal(ctlDescriptor({ command: 'help' }), undefined)
  assert.equal(ctlDescriptor({ command: 'tool search exec' }), undefined)
  assert.equal(ctlDescriptor({ command: 'bogus verb' }), undefined)
  const unchanged = { name: 'ctl', args: { command: 'help' } }
  assert.equal(ctlAsUnified(unchanged), unchanged)
})

test('communication and question cards recognize their tools through ctl', () => {
  const ask = { name: 'ctl', args: { command: 'tool call builtin:ask_user --args @a', values: { a: { question: 'q?' } } } }
  assert.equal(questions.isAskUserCall(ask), true)
  assert.deepEqual(questions.askUserArgs(ask), { question: 'q?' })
  const message = (role, parts) => ({ role, parts })
  const call = { id: 'c1', name: 'ctl', args: { command: 'tool call builtin:send_to_session --args @a', values: { a: { sessionId: 'peer', message: 'hello' } } } }
  const projected = communications.projectSessionCommunications([
    message('model', [{ functionCall: call }]),
    message('tool', [{ functionResponse: { tool_use_id: 'c1', name: 'ctl', response: { output: 'sent' } } }]),
  ])
  assert.equal([...projected.values()].flat().some(item => item.message === 'hello'), true)
})
