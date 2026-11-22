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
const { ctlDescriptor, ctlAsUnified, ctlConcrete, ctlCommandName, ctlCommandText, ctlSummary, partialJson } = await load('../src/ctlCall.ts', 'ctl.mjs')
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
test('tool call of an MCP tool names the tool arguments in every argument spelling', () => {
  const args = { repo: 'octo-org/demo', sort: { by: 'updated', labels: ['bug', 'ui'] } }
  const descriptor = { toolId: 'mcp:github/search_issues', args }
  const json = JSON.stringify(args)
  for (const call of [
    { command: 'tool call mcp:github/search_issues --args @args', values: { args } },
    { command: 'tool call mcp:github/search_issues --args=@args', values: { args } },
    { command: 'ctl tool call mcp:github/search_issues --args @args', valuesJson: JSON.stringify({ args }) },
    { command: `tool call mcp:github/search_issues --args '${json}'` },
    { command: `tool call mcp:github/search_issues --args='${json}'` },
    { command: `tool call --source mcp --server github --name search_issues --args '${json}'` },
  ]) {
    const expected = call.command.includes('--source') ? { source: 'mcp', server: 'github', name: 'search_issues', args } : descriptor
    assert.deepEqual(ctlConcrete({ name: 'ctl', args: call }), { name: 'call_tool', args: expected }, call.command)
  }
  // An unbound @name leaves the tool without arguments, as Main reports it.
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: { command: 'tool call mcp:github/search_issues --args @args' } }).args, { toolId: 'mcp:github/search_issues', args: {} })
})

test('partial JSON keeps what has arrived', () => {
  const cases = [
    ['{"a":1}', { a: 1 }],
    ['', undefined],
    ['{', {}],
    ['{"a', {}],
    ['{"a"', {}],
    ['{"a":', {}],
    ['{"a":"x', { a: 'x' }],
    ['{"a":"x\\', { a: 'x' }],
    ['{"a":"x\\"y', { a: 'x"y' }],
    ['{"a":"\\u00', { a: '' }],
    ['{"a":1,"b":tr', { a: 1 }],
    ['{"a":1,"b":12', { a: 1, b: 12 }],
    ['{"a":1,"b":1.', { a: 1 }],
    ['{"a":[1,"b', { a: [1, 'b'] }],
    ['{"a":{"b":["c"],"d":{', { a: { b: ['c'], d: {} } }],
    ['{"a":"}{]["', { a: '}{][' }],
  ]
  for (const [text, expected] of cases) assert.deepEqual(partialJson(text), expected, text)
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

// Tags name a ctl call by its command path; the icon (name) stays the tool it runs.
const shared = await load('../src/components/chatShared.tsx', 'shared.mjs')
const rows = await load('../src/components/timelineRows.ts', 'rows.mjs')
const ctl = (command, values) => ({ command, ...(values ? { values } : {}) })

test('ctl calls are tagged with their command path', () => {
  const cases = [
    [ctl('memory edit MEMORY.md --old-text a --new-text b'), 'memory edit'],
    [ctl('node copy master a box b'), 'node copy'],
    [ctl('history recall msg#12'), 'history recall'],
    [ctl('session view a/b --count 3'), 'session view'],
    [ctl('node select box'), 'node select'],
    [ctl('node destroy box'), 'node destroy'],
    // `tool call builtin:x`: the command path of x, chosen by its fixed arguments, else its name.
    [ctl('tool call builtin:edit_memory --args @a', { a: { filePath: 'M.md', oldText: 'a', newText: 'b' } }), 'memory edit'],
    [ctl('tool call builtin:node --args @a', { a: { action: 'select', nodeId: 'box' } }), 'node select'],
    [ctl('tool call builtin:node --args @a', { a: {} }), 'node'],
    [ctl('tool call builtin:task --args @a', { a: { action: 'list' } }), 'task'],
    // Help, discovery, --help and malformed calls stay ctl.
    [ctl('help'), 'ctl'],
    [ctl('session --help'), 'ctl'],
    [ctl('session list --help'), 'ctl'],
    [ctl('tool search memory'), 'ctl'],
    [ctl('tool call mcp:srv/probe --help'), 'ctl'],
    [ctl('session list "unclosed'), 'ctl'],
    [ctl('bogus verb'), 'ctl'],
  ]
  for (const [args, expected] of cases) {
    assert.equal(ctlCommandName(args), expected, args.command)
    assert.equal(slimCtl.ctlCommandName(args), expected, args.command)
    assert.equal(shared.formatToolLabel('ctl', args), expected, args.command)
  }
  // MCP and Node tools given to `tool call` are tagged like the direct call.
  for (const [args, direct] of [
    [ctl('tool call node:box/read --args @a', { a: { filePath: 'x' } }), shared.formatToolLabel('read', { filePath: 'x' })],
    [ctl('tool call mcp:srv/probe --args @a', { a: {} }), shared.formatToolLabel('call_tool', { toolId: 'mcp:srv/probe', args: {} })],
  ]) {
    assert.equal(ctlCommandName(args), undefined, args.command)
    assert.equal(shared.formatToolLabel('ctl', args), direct, args.command)
  }
  assert.equal(shared.formatToolLabel('edit_memory', {}), 'edit_memory')
})

test('collapsed tag summaries count ctl calls by command path with the target icon', () => {
  let n = 0
  const call = (name, args, status = 'ok') => {
    const id = 'c' + ++n
    return [
      { role: 'model', parts: [{ functionCall: { id, name, args } }], __meta: { seq: n * 2, timestamp: 1700000000000 + n * 1000 } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name, response: status === 'ok' ? { output: 'ok' } : { error: { type: 'x', message: 'no' } } } }], __meta: { seq: n * 2 + 1 } },
    ]
  }
  const messages = [
    ...call('ctl', ctl('memory edit A.md --old-text a --new-text b')),
    ...call('ctl', ctl('memory edit B.md --old-text a --new-text b')),
    ...call('ctl', ctl('tool call builtin:edit_memory --args @a', { a: { filePath: 'C.md', oldText: 'a', newText: 'b' } })),
    ...call('ctl', ctl('node select box')),
    ...call('ctl', ctl('node destroy box')),
    ...call('ctl', ctl('tool search memory')),
    ...call('edit_memory', { filePath: 'D.md', oldText: 'a', newText: 'b' }),
    { role: 'model', parts: [{ text: 'Done' }], __meta: { seq: 100, timestamp: 1700000100000 } },
  ]
  const base = { isMobile: false, showUsageBadge: false, showTimeDividers: false, nestedDepth: 0, expandedGroupKeys: new Set() }
  const result = rows.buildTimelineRows({ ...base, messages, timelineView: 'grouped' }, null)
  const group = result.rows.find(row => row.group)?.group
  assert(group, 'tool group')
  const counted = shared.summarizeToolTagCounts(group.summaryItems).map(item => [item.name, item.label])
  assert.deepEqual(counted, [
    ['edit_memory', 'memory edit ×3'],
    ['node', 'node select ×1'],
    ['node', 'node destroy ×1'],
    ['ctl', 'ctl ×1'],
    ['edit_memory', 'edit_memory ×1'],
  ])
})

test('a streaming ctl call shows the call it runs with the values received so far', () => {
  const command = 'tool call mcp:github/search_issues --args @args'
  const streaming = `{"command":${JSON.stringify(command)},"values":{"args":{"repo":"octo-org/demo","sort":{"labels":["bu`
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: streaming }), { name: 'call_tool', args: { toolId: 'mcp:github/search_issues', args: { repo: 'octo-org/demo', sort: { labels: ['bu'] } } } })
  assert.equal(ctlCommandText({ name: 'ctl', args: streaming }), command)
  assert.equal(shared.formatToolLabel('ctl', streaming), 'tool:mcp:github/search_issues')
  // Values not yet arriving leave the bound argument empty; builtin commands stream the same way.
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: `{"command":${JSON.stringify(command)},"val` }).args, { toolId: 'mcp:github/search_issues', args: {} })
  assert.deepEqual(ctlConcrete({ name: 'ctl', args: '{"command":"memory write a.md @body","values":{"body":"line one\\nline' }), { name: 'write_memory', args: { filePath: 'a.md', content: 'line one\nline' } })
  // A command still arriving stays a plain ctl call until it names one.
  const early = { name: 'ctl', args: '{"command":"tool call mcp:github/search_issues --ar' }
  assert.equal(ctlConcrete(early), early)
  assert.equal(ctlCommandName(early.args), 'ctl')
})

test('a ctl summary is shown unless the tool it runs states its own', () => {
  const exec = (own, summary) => ({ name: 'ctl', args: { command: 'tool call node:worker/exec --args @args', values: { args: { command: 'make', ...(own ? { summary: own } : {}) } }, ...(summary !== undefined ? { summary } : {}) } })
  assert.equal(ctlSummary(exec(undefined, 'Run make')), 'Run make')
  assert.equal(ctlSummary(exec('Build the project', 'Run make')), undefined)
  assert.equal(ctlSummary(exec(undefined, '  ')), undefined)
  assert.equal(ctlSummary(exec(undefined)), undefined)
  // An MCP tool's own summary argument is not a stated summary.
  assert.equal(ctlSummary({ name: 'ctl', args: { command: 'tool call mcp:server/exec --args @args', values: { args: { summary: 'MCP text' } }, summary: 'Ask the server' } }), 'Ask the server')
  assert.equal(ctlSummary({ name: 'ctl', args: { command: 'skill load code-index', summary: 'Load the skill' } }), 'Load the skill')
  assert.equal(ctlSummary({ name: 'ctl', args: { command: 'node --help', summary: 'Look up flags' } }), 'Look up flags')
  assert.equal(ctlSummary({ name: 'exec', args: { command: 'make', summary: 'Build' } }), undefined)
  // While the call streams, the summary appears once its string is received.
  assert.equal(ctlSummary({ name: 'ctl', args: '{"command":"timer list","summary":"Show tim' }), 'Show tim')
  // The stored summary never changes the call it runs.
  assert.deepEqual(ctlConcrete(exec(undefined, 'Run make')).args, { command: 'make' })
})
