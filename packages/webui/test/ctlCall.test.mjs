import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'ctl-call-'))
after(() => rm(dir, { recursive: true, force: true }))
const load = async (entry, name) => {
  const file = join(dir, name)
  await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
  return import(pathToFileURL(file).href)
}
globalThis.window ??= { location: { pathname: '/', origin: 'http://localhost' } }
const { ctlDescriptor, ctlAsUnified } = await load('../src/ctlCall.ts', 'ctl.mjs')
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
