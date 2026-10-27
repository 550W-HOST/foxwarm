import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
const [root, image] = process.argv.slice(2)
await appendFile(join(root, 'processes.ndjson'), JSON.stringify({ pid: process.pid }) + '\n')
const data = (await readFile(image)).toString('base64')
const server = new Server({ name: 'synthetic-image-peer', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'image', description: 'Synthetic image fixture', inputSchema: { type: 'object', properties: { corrupt: { type: 'boolean' }, carrier: { type: 'boolean' } } } }] }))
server.setRequestHandler(CallToolRequestSchema, async request => request.params.arguments?.carrier ? { content: [{ type: 'text', text: 'Recognized Source carrier' }], inlineDataItems: [{ mimeType: 'image/png', data: data + '\n'.repeat(50000) }], business: { data: 'opaque business data' } } : ({ content: [
  { type: 'text', text: 'Official SDK image content.' },
  { type: 'image', mimeType: 'image/png', data: request.params.arguments?.corrupt ? Buffer.from('not a PNG raster').toString('base64') : data },
  { type: 'image', mimeType: 'image/png', data },
], business: { data: 'opaque business data', metadata: { image: true } } }))
await server.connect(new StdioServerTransport())
