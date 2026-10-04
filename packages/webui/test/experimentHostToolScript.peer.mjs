// Official SDK schema/result fixture for programmatic ToolScript discovery.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'synthetic-toolscript-schema', version: '1' }, { capabilities: { tools: {} } })
const inputSchema = { type: 'object', properties: { value: { type: 'string', description: 'Escaped */\nmetadata\u202e' } }, additionalProperties: false }
const outputSchema = { type: 'object', properties: { data: { type: 'object', properties: { flag: { type: 'boolean' }, zero: { const: 0 }, nothing: { type: 'null' } }, required: ['flag', 'zero', 'nothing'] } }, required: ['data'] }
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'schema_echo', description: 'Structured fixture */\nmetadata\u202e', inputSchema, outputSchema }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'Fixture text' }], structuredContent: { data: { flag: false, zero: 0, nothing: null } }, _meta: { retained: true } }))
await server.connect(new StdioServerTransport())
