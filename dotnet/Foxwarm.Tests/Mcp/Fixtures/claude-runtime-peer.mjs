// Controlled NDJSON child. It never invokes a model or reads account credentials.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'

const require = createRequire(path.join(process.env.FOXWARM_TS_ROOT, 'package.json'))
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')))
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')))
const args = process.argv.slice(2)
const arg = name => args[args.indexOf(name) + 1]
process.on("uncaughtException", async error => { await fs.writeFile(path.join(fixtureDirectory, "peer-error.txt"), String(error.stack || error)); process.exit(1) })
const fixtureDirectory = process.env.FOXWARM_CLAUDE_PEER_DIRECTORY
const settings = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'peer.json'), 'utf8'))
const config = JSON.parse(await fs.readFile(arg('--mcp-config'), 'utf8')).mcpServers.foxwarm
const id = arg(args.includes('--resume') ? '--resume' : '--session-id')
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())
const overlay = JSON.parse(await fs.readFile(arg('--settings'), 'utf8'))
let settingsProbe = null
if (settings.probeSettingSources) {
  const sources = args.includes('--setting-sources') ? arg('--setting-sources').split(',') : ['user', 'project', 'local']
  const paths = {
    user: path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
    project: path.join(process.cwd(), '.claude', 'settings.json'),
    local: path.join(process.cwd(), '.claude', 'settings.local.json'),
  }
  const loaded = []
  let effective = {}
  for (const source of sources) {
    const contents = await fs.readFile(paths[source], 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (contents) { loaded.push(paths[source]); effective = { ...effective, ...JSON.parse(contents) } }
  }
  effective = { ...effective, ...overlay }
  // Observe fixture selection only. Never execute the commands stored in fixture settings.
  settingsProbe = { sources, loaded, model: effective.model, apiKeyHelper: !!effective.apiKeyHelper, hooks: !!effective.hooks }
}
await fs.appendFile(path.join(fixtureDirectory, 'inputs.jsonl'), JSON.stringify({ args, input, id, cwd: process.cwd(), settingsProbe, resumed: args.includes('--resume'), endpoint: config.url, token: config.headers.Authorization, overlay, prompt: await fs.readFile(arg('--append-system-prompt-file'), 'utf8') }) + '\n')
const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl')
await fs.mkdir(path.dirname(transcript), { recursive: true })
await fs.appendFile(transcript, JSON.stringify(input) + '\n')
async function emit(event) {
  const line = JSON.stringify({ session_id: id, ...event }) + '\r\n'
  // Exercise actual split byte/NDJSON boundaries, including inside Unicode.
  const bytes = Buffer.from(line)
  for (let i = 0; i < bytes.length; i += 7) {
    if (!process.stdout.write(bytes.subarray(i, i + 7))) await once(process.stdout, 'drain')
  }
}
if (settings.descendant) { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); await fs.writeFile(path.join(fixtureDirectory, 'descendant.pid'), String(child.pid)) }
if (settings.malformed) { process.stdout.write('{broken\n'); await new Promise(() => { setInterval(() => {}, 1000) }) }
const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
const client = new Client({ name: 'controlled-claude-peer', version: '1.0.0' })
await client.connect(transport)
const tools = await client.listTools()
await fs.writeFile(path.join(fixtureDirectory, 'tools.json'), JSON.stringify(tools))
await emit({ type: 'system', subtype: 'init', model: 'cli-configured-model', tools: [...tools.tools.map(tool => `mcp__foxwarm__${tool.name}`), ...(settings.extraTool ? ['Bash'] : []), 'EndConversation'], mcp_servers: [{ name: 'foxwarm', status: 'connected' }], plugins: settings.plugins ? [{ name: 'unexpected-plugin' }] : [] })
async function waitFor(name) {
  await new Promise(resolve => {
    const done = () => { watcher.close(); resolve() }
    const watcher = watch(fixtureDirectory, (_, filename) => { if (filename === name) done() })
    fs.stat(path.join(fixtureDirectory, name)).then(done, () => {})
  })
}
if (settings.emptyOnce && !(await fs.stat(path.join(fixtureDirectory, 'empty-once')).catch(() => null))) {
  await fs.writeFile(path.join(fixtureDirectory, 'empty-once'), 'done')
  settings.empty = true
  settings.calls = []
}
if (settings.pauseBeforeCalls) { await fs.writeFile(path.join(fixtureDirectory, 'before-calls'), 'ready'); await waitFor('allow-calls') }
for (const [index, operation] of (settings.calls || []).entries()) {
  const result = await client.callTool({ name: operation.name || 'call_tool', arguments: operation.args })
  await fs.appendFile(path.join(fixtureDirectory, 'results.jsonl'), JSON.stringify({ index, result }) + '\n')
  if (settings.pauseAfterFirstCall && index === 0) { await fs.writeFile(path.join(fixtureDirectory, 'after-first-call'), 'ready'); await waitFor('policy-restored') }
  await emit({ type: 'assistant', uuid: `echo-${index}`, message: { id: `echo-${index}`, content: [{ type: 'tool_use', id: `cli-${index}`, name: operation.name || 'call_tool', input: operation.args }] } })
  await emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `cli-${index}`, content: 'observed' }] } })
}
await fs.writeFile(path.join(fixtureDirectory, 'ready'), 'ready')
if (settings.hold) await new Promise(() => { setInterval(() => {}, 1000) })
if (settings.crash) process.exit(17)
if (settings.empty) {
  await emit({ type: 'assistant', uuid: 'end', message: { content: [{ type: 'tool_use', id: 'end', name: 'EndConversation', input: {} }] } })
  await emit({ type: 'result', subtype: 'success', result: '' })
  await client.close()
  process.exit(0)
}
const answer = settings.answer || 'Hello 🦊'
await emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } })
if (settings.partialCrash) process.exit(18)
if (settings.compact) await emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1000 } })
const assistant = { type: 'assistant', uuid: 'final', message: { id: 'final', content: [{ type: 'text', text: answer }] } }
await emit(assistant)
await emit(assistant)
await emit({ type: 'result', subtype: 'success', result: answer, usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 1.25, num_turns: 1 })
// Deliberately hostile late data must not create another canonical result or business effect.
if (settings.late) {
  await emit({ type: 'result', subtype: 'success', result: 'duplicate', usage: { input_tokens: 999 }, total_cost_usd: 999 })
  await emit({ type: 'assistant', uuid: 'late', message: { content: [{ type: 'text', text: 'late' }] } })
}
await client.close()

if (settings.exitAfterResult) process.exit(0)
