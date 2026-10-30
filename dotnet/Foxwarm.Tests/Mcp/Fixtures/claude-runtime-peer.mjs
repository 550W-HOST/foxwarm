// Controlled NDJSON child. It never invokes a model or reads account credentials.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

const require = createRequire(path.join(process.env.FOXWARM_TS_ROOT, 'package.json'))
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')))
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')))
const args = process.argv.slice(2)
const arg = name => args[args.indexOf(name) + 1]
process.on("uncaughtException", async error => { await fs.writeFile(path.join(process.cwd(), "peer-error.txt"), String(error.stack || error)); process.exit(1) })
const settings = JSON.parse(await fs.readFile(path.join(process.cwd(), 'peer.json'), 'utf8'))
const config = JSON.parse(await fs.readFile(arg('--mcp-config'), 'utf8')).mcpServers.foxwarm
const id = arg(args.includes('--resume') ? '--resume' : '--session-id')
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())
await fs.appendFile(path.join(process.cwd(), 'inputs.jsonl'), JSON.stringify({ args, input, id, resumed: args.includes('--resume'), endpoint: config.url, token: config.headers.Authorization, overlay: JSON.parse(await fs.readFile(arg('--settings'), 'utf8')), prompt: await fs.readFile(arg('--append-system-prompt-file'), 'utf8') }) + '\n')
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
if (settings.descendant) { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); await fs.writeFile(path.join(process.cwd(), 'descendant.pid'), String(child.pid)) }
if (settings.malformed) { process.stdout.write('{broken\n'); await new Promise(() => { setInterval(() => {}, 1000) }) }
await emit({ type: 'system', subtype: 'init', model: 'cli-configured-model', tools: ['mcp__foxwarm__search_tools', 'mcp__foxwarm__call_tool', 'EndConversation'], mcp_servers: [{ name: 'foxwarm', status: 'connected' }], plugins: settings.plugins ? [{ name: 'unexpected-plugin' }] : [] })
const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
const client = new Client({ name: 'controlled-claude-peer', version: '1.0.0' })
await client.connect(transport)
const tools = await client.listTools()
await fs.writeFile(path.join(process.cwd(), 'tools.json'), JSON.stringify(tools))
for (const [index, operation] of (settings.calls || []).entries()) {
  const result = await client.callTool({ name: operation.name || 'call_tool', arguments: operation.args })
  await fs.appendFile(path.join(process.cwd(), 'results.jsonl'), JSON.stringify({ index, result }) + '\n')
  await emit({ type: 'assistant', uuid: `echo-${index}`, message: { id: `echo-${index}`, content: [{ type: 'tool_use', id: `cli-${index}`, name: operation.name || 'call_tool', input: operation.args }] } })
  await emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `cli-${index}`, content: 'observed' }] } })
}
await fs.writeFile(path.join(process.cwd(), 'ready'), 'ready')
if (settings.hold) await new Promise(() => { setInterval(() => {}, 1000) })
if (settings.crash) process.exit(17)
if (settings.empty) {
  await emit({ type: 'assistant', uuid: 'end', message: { content: [{ type: 'tool_use', id: 'end', name: 'EndConversation', input: {} }] } })
  await emit({ type: 'result', subtype: 'success', result: '' })
  await client.close()
  process.exit(0)
}
await emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello 🦊' } } })
if (settings.partialCrash) process.exit(18)
if (settings.compact) await emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1000 } })
const assistant = { type: 'assistant', uuid: 'final', message: { id: 'final', content: [{ type: 'text', text: 'Hello 🦊' }] } }
await emit(assistant)
await emit(assistant)
await emit({ type: 'result', subtype: 'success', result: 'Hello 🦊', usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 1.25, num_turns: 1 })
// Deliberately hostile late data must not create another canonical result or business effect.
if (settings.late) {
  await emit({ type: 'result', subtype: 'success', result: 'duplicate', usage: { input_tokens: 999 }, total_cost_usd: 999 })
  await emit({ type: 'assistant', uuid: 'late', message: { content: [{ type: 'text', text: 'late' }] } })
}
await client.close()
