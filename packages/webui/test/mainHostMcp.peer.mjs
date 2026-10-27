// Real official-SDK MCP peer used by the concentrated .NET original-App workflow.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { createServer } from 'node:http'
import { appendFile, readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [mode, root, label = 'initial'] = process.argv.slice(2)
await mkdir(root, { recursive: true })
await appendFile(join(root, 'processes.ndjson'), JSON.stringify({ pid: process.pid, label, mode }) + '\n')
const unsafe = 'unsafe*/\nline\u202e'
const manyProperties = Object.fromEntries(Array.from({ length: 60 }, (_, index) => ['key' + index, { type: 'string', description: 'property */\nCONTROL\u202e' }]))
const basic = { type: 'object', properties: { tag: { type: 'string' }, value: {}, __cancelTool: { type: 'boolean' } }, additionalProperties: true }
const tools = [
  { name: 'echo_effect', description: 'Write one real effect and return exact JSON arguments', inputSchema: basic },
  { name: 'hold_effect', description: 'Hold a real MCP request until file release or protocol cancellation', inputSchema: basic },
  { name: 'result_case', description: 'Return text JSON structured metadata binary or protocol error cases', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, tag: { type: 'string' } }, required: ['kind'] } },
  { name: unsafe, description: 'Unsafe metadata */\nDO-NOT-EXECUTE\u202e', inputSchema: { type: 'object', properties: { 'key*/\nname': { type: 'string', description: 'field */\nGUARD' }, requiredMissing: { type: 'string' } }, required: ['key*/\nname'], additionalProperties: false } },
  { name: 'schema_required_open', description: 'Open undeclared required field', inputSchema: { type: 'object', properties: { optional: { type: 'string' } }, required: ['extra'], additionalProperties: { type: 'number' } } },
  { name: 'schema_required_closed', description: 'Closed impossible required field', inputSchema: { type: 'object', properties: {}, required: ['extra'], additionalProperties: false } },
  { name: 'schema_many', description: 'Truncated constraints', inputSchema: { type: 'object', properties: manyProperties, required: Object.keys(manyProperties), additionalProperties: false } },
  { name: 'schema_union', description: 'Bounded nested union enum const', inputSchema: { type: 'object', properties: { choice: { oneOf: [{ const: 'one' }, { enum: ['two', 'three'] }] }, nested: { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } } } },
  { name: 'schema_ref', description: 'Unsupported reference retained as unknown', inputSchema: { type: 'object', $ref: '#/$defs/example', $defs: { example: { type: 'object' } } } },
  ...Array.from({ length: 12 }, (_, index) => ({ name: 'schema_extra_' + index, description: 'Schema detail budget example', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } })),
]
const exists = file => access(file).then(() => true, () => false)
const sleep = ms => new Promise(done => setTimeout(done, ms))
const log = data => appendFile(join(root, 'calls.ndjson'), JSON.stringify({ ...data, pid: process.pid, label }) + '\n')
function peer() {
  const server = new Server({ name: 'synthetic-sdk-peer', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => { await log({ event: 'list' }); return { tools } })
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const { name, arguments: args = {} } = request.params
    const tag = String(args.tag || name)
    await log({ event: 'call', name, args, tag })
    if (name === 'echo_effect' || name === unsafe) {
      await writeFile(join(root, 'effect-' + tag + '.txt'), JSON.stringify({ label, args }))
      return { content: [{ type: 'text', text: JSON.stringify({ label, args, pid: process.pid,
        configuredEnv: process.env.MCP_SYNTHETIC_ENV === 'configured-test-value', customSecret: Boolean(process.env.MCP_HOST_ONLY_SENTINEL) }) }] }
    }
    if (name === 'hold_effect') {
      await writeFile(join(root, 'started-' + tag), label)
      while (!await exists(join(root, 'release-' + tag))) {
        if (context.signal.aborted) { await writeFile(join(root, 'cancelled-' + tag), label); throw new McpError(ErrorCode.InternalError, 'Peer observed protocol cancellation') }
        await sleep(15)
      }
      await writeFile(join(root, 'effect-' + tag + '.txt'), label)
      return { content: [{ type: 'text', text: JSON.stringify({ label, tag, pid: process.pid }) }] }
    }
    if (name === 'result_case') {
      const kind = args.kind
      if (kind === 'protocol') throw new McpError(ErrorCode.InvalidParams, 'Synthetic protocol failure: ' + (process.env.MCP_SYNTHETIC_SECRET || 'ordinary-detail'))
      if (kind === 'disconnect') { setTimeout(() => process.exit(0), 20); await new Promise(() => {}) }
      if (kind === 'large') return { content: [{ type: 'text', text: JSON.stringify({ long: 'START-' + 'payload-value-'.repeat(8000) + '-END', label }) }] }
      if (kind === 'metadata') return { content: [{ type: 'text', text: 'META-TEXT' }], _meta: { retained: true, label }, structuredContent: { nested: { value: 7 }, array: ['alpha', 'beta'] } }
      if (kind === 'error_object') return { content: [{ type: 'text', text: JSON.stringify({ error: { message: 'vendor-error', metadata: { retained: true } } }) }] }
      if (kind === 'opaque') return { content: [{ type: 'text', text: 'OPAQUE-TEXT' }], customTag: { retained: true, label } }
      if (kind === 'multi') return { content: [{ type: 'text', text: 'FIRST' }, { type: 'text', text: 'SECOND' }] }
      if (kind === 'isError') return { content: [{ type: 'text', text: 'DECLARED-TOOL-ERROR' }], isError: true }
      if (kind === 'array') return { content: [{ type: 'text', text: '[1,{"value":"two"}]' }] }
      if (kind === 'plain') return { content: [{ type: 'text', text: 'plain text π' }] }
      if (kind === 'primitive') return { content: [{ type: 'text', text: '42' }] }
      if (kind === 'resource') return { content: [{ type: 'resource', resource: { uri: 'test://owned/resource', mimeType: 'text/plain', text: 'RESOURCE-TEXT', _meta: { label } } }] }
      if (kind === 'image' || kind === 'audio' || kind === 'blob') {
        await writeFile(join(root, 'effect-' + tag + '.txt'), 'REMOTE-EFFECT-COMPLETED')
        const data = kind === 'image' ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS0AAAAASUVORK5CYII=' : Buffer.from('SYNTHETIC-BINARY-CONTENT').toString('base64')
        return { content: [...(kind === 'image' ? [{ type: 'text', text: 'IMAGE-EXPLANATION' }] : []), kind === 'blob' ? { type: 'resource', resource: { uri: 'test://owned/binary', mimeType: 'application/octet-stream', blob: data } } : { type: kind, mimeType: kind === 'audio' ? 'audio/wav' : 'image/png', data }] }
      }
      throw new McpError(ErrorCode.InvalidParams, 'Unknown result case')
    }
    throw new McpError(ErrorCode.MethodNotFound, 'Unknown fixture tool')
  })
  return server
}
async function connectPeer(transport) {
  const server = peer(); await server.connect(transport)
  const receive = transport.onmessage
  transport.onmessage = (message, extra) => {
    if (message.method === 'notifications/cancelled') void log({ event: 'cancel-notification', params: message.params })
    receive?.(message, extra)
  }
  return server
}
if (mode === 'stdio') {
  await connectPeer(new StdioServerTransport())
} else if (mode === 'http') {
  const streamable = new Map(); const sse = new Map()
  const http = createServer(async (req, res) => {
    try {
      await log({ event: 'http', url: req.url, method: req.method, authMatched: req.headers.authorization === 'Bearer synthetic-explicit-auth' })
      if (req.url === '/mcp') {
        let transport = streamable.get(req.headers['mcp-session-id'])
        if (!transport && req.method === 'POST') {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => streamable.set(id, transport) })
          await connectPeer(transport)
          transport.onclose = () => streamable.delete(transport.sessionId)
        }
        if (!transport) { res.writeHead(400); res.end(); return }
        await transport.handleRequest(req, res)
      } else if (req.url === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res); sse.set(transport.sessionId, transport)
        transport.onclose = () => sse.delete(transport.sessionId)
        await connectPeer(transport)
      } else if (req.url?.startsWith('/messages')) {
        const transport = sse.get(new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId'))
        if (!transport) { res.writeHead(404); res.end(); return }
        await transport.handlePostMessage(req, res)
      } else { res.writeHead(405); res.end() }
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error.message)) }
  })
  http.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: http.address().port, pid: process.pid }) + '\n'))
} else throw new Error('Select stdio or http')
