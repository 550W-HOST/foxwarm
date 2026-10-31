// Normal Main with real TypeScript and managed CLI Nodes, without an outbound MCP dependency.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { createHostFixture, until } from './mainHostFixture.mjs'

const host = await createHostFixture('mcp-files'), prefix = '/external/files'
const alpha = 'synthetic-file-alpha', beta = 'synthetic-file-beta'
const identities = { alpha: { token: alpha, surfaces: { mcp: {} } }, beta: { token: beta, surfaces: { mcp: {} } } }
const app = webui => ({ url: host.origin + prefix, bot: { httpPort: host.port, enableWebUI: webui }, access: { identities } })
const children = [], clients = [], childOutput = []
const bytes = Buffer.from([0, 255, 128, 13, 10, 239, 187, 191, 42])
const roots = Object.fromEntries(['ts-files', 'managed-files'].map(id => [id, join(host.root, id)]))
const binaryFiles = Object.values(roots).map(root => join(root, 'raw.bin'))
const boundaryFile = join(roots['managed-files'], 'boundary.bin')
const policy = `version: 1
rules:
- id: files
  action: allow
  match:
    externalId: alpha
    tool: {source: node, name: read}
    targetNode: [ts-files, managed-files]
    args: {filePath: {oneOf: ${JSON.stringify([...binaryFiles, boundaryFile])}}}
- id: effects
  action: allow
  match: {externalId: alpha, tool: {source: node, name: [exec, edit]}, targetNode: [ts-files, managed-files]}
- id: placement
  action: allow
  match: {externalId: alpha, tool: {source: builtin, name: node}}
`
async function api(method, path, body) {
  const response = await fetch(host.origin + prefix + path, { method, headers: { authorization: 'Bearer ' + host.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert(response.ok, await response.clone().text())
  return response.json()
}
async function connect() {
  const client = new Client({ name: 'file-qualification', version: '1' })
  client.onerror = () => {}
  await client.connect(new StreamableHTTPClientTransport(new URL(host.origin + prefix + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + alpha } } }))
  clients.push(client)
  return client
}
const call = (client, name, args) => client.callTool({ name, arguments: args })
const concrete = (client, id, name, args) => call(client, 'foxwarm_call', { toolId: `node:${id}/${name}`, args })
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
const value = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(text(result)) }
const download = (id, path, token = alpha) => fetch(host.origin + prefix + '/api/vscode-web/fs/read-file?' + new URLSearchParams({ nodeId: id, path }), { headers: { authorization: 'Bearer ' + token } })
const exists = file => access(file).then(() => true, () => false)
async function ready(client) {
  await until(async () => value(await call(client, 'foxwarm_node', { action: 'list' })).nodes.length === 2, 'both actual CLI Nodes advertise external capabilities')
}
try {
  await writeFile(host.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-completions', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
  await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(app(true)))
  await writeFile(join(host.data, 'state/tool-authorization.yaml'), policy)
  await host.start()
  for (const [id, root] of Object.entries(roots)) {
    await mkdir(root)
    await writeFile(join(root, 'raw.bin'), bytes)
    const credential = await api('POST', '/api/nodes/onboarding/create', { nodeId: id, fallbackUrl: host.origin + prefix })
    const managed = id === 'managed-files'
    const executable = managed ? join(process.env.DOTNET_ROOT, 'dotnet') : process.execPath
    const entry = resolve(managed ? 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll' : 'packages/cli-node/dist/client.js')
    // The owned loopback clients must not use the fixture's deliberately unavailable outbound proxy.
    const child = spawn(executable, [entry, '--host', host.origin + prefix, '--id', id, '--auth-token', credential.authToken, '--credentials-file', join(root, 'credentials.json'), '--no-local-trigger'], { cwd: root, env: { ...testEnvironment.isolatedApplicationEnv(root), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = { id, text: '' }; childOutput.push(log)
    child.stdout.on('data', bytes => { log.text += bytes }); child.stderr.on('data', bytes => { log.text += bytes })
    children.push(child)
  }
  const client = await connect(); await ready(client)
  const discovered = await call(client, 'foxwarm_discover', { sources: ['node'], limit: 50 })
  const tools = value(discovered).tools
  for (const tool of tools) assert(text(discovered).includes(JSON.stringify(tool.toolId)))
  const exec = tools.find(tool => tool.name === 'exec')
  assert.equal(exec.inputSchema.additionalProperties, false)
  assert.match(exec.inputSchema.properties.cwd.description, /Agent directories.*unavailable/)
  assert.match(exec.description, /foxwarm_exec_result/)
  for (const [id, root] of Object.entries(roots)) {
    const invalid = await concrete(client, id, 'exec', { command: 'printf forbidden > rejected-args', timeoutMs: 1000 })
    assert(invalid.isError); assert.match(text(invalid), /Accepted fields: command, cwd, timeout.*No call was sent/)
    assert(!await exists(join(root, 'rejected-args')))
    const patch = await concrete(client, id, 'edit', { apply_patch: '*** Begin Patch\n*** Add File: rejected-patch\n+first\n*** Broken Header\n*** End Patch' })
    assert(patch.isError); assert.match(text(patch), /Invalid apply_patch input.*No call was sent/)
    assert(!await exists(join(root, 'rejected-patch')))
    const partial = await concrete(client, id, 'edit', { apply_patch: '*** Begin Patch\n*** Add File: partial-effect\n+first\n*** Update File: missing-after-first\n@@\n-old\n+new\n*** End Patch' })
    assert(partial.isError); assert.match(text(partial), /effects may have occurred/)
    assert.equal(await readFile(join(root, 'partial-effect'), 'utf8'), 'first')
    const started = value(await concrete(client, id, 'exec', { command: 'printf partial; sleep 2; printf complete', timeout: 1 }))
    assert(started.background); assert.match(started.output, /foxwarm_exec_result/)
    assert.doesNotMatch(started.output, /STOP calling tools|notification message/)
    const complete = await until(async () => { const result = value(await call(client, 'foxwarm_exec_result', { execId: started.execId })); return result.state === 'completed' && result }, 'actual external completion on ' + id)
    assert.match(complete.output, /partialcomplete/)
    const original = await download(id, join(root, 'raw.bin'))
    assert.equal(original.status, 200); assert.equal(original.headers.get('content-type'), 'application/octet-stream')
    assert.equal(original.headers.get('cache-control'), 'no-store'); assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    assert.equal((await download(id, join(root, 'credentials.json'))).status, 403)
    assert.equal((await download(id, join(root, 'raw.bin'), beta)).status, 403)
  }
  const administrator = await download('master', binaryFiles[0], host.token)
  assert.equal(administrator.status, 200); assert.deepEqual(Buffer.from(await administrator.arrayBuffer()), bytes)
  assert.equal((await download('master', binaryFiles[0])).status, 403)
  assert.equal((await download('ts-files', 'relative.bin')).status, 400)
  assert.equal((await download('ts-files', binaryFiles[0], 'unknown-token')).status, 401)
  const otherCode = await fetch(host.origin + prefix + '/api/vscode-web/fs/stat?nodeId=master&path=/', { headers: { authorization: 'Bearer ' + alpha } })
  assert.equal(otherCode.status, 401)
  await host.stop()
  await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(app(false)))
  await host.start()
  const headless = await connect(); await ready(headless)
  for (const [id, root] of Object.entries(roots)) {
    const result = await download(id, join(root, 'raw.bin'))
    assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes)
  }
  const headlessAdmin = await download('master', binaryFiles[0], host.token)
  assert.equal(headlessAdmin.status, 200); assert.deepEqual(Buffer.from(await headlessAdmin.arrayBuffer()), bytes)
  const boundaryBytes = Buffer.alloc(50 * 1024 * 1024); boundaryBytes[0] = 255; boundaryBytes[boundaryBytes.length - 1] = 128
  await writeFile(boundaryFile, boundaryBytes)
  const boundary = await download('managed-files', boundaryFile)
  assert.equal(boundary.status, 200); assert.deepEqual(Buffer.from(await boundary.arrayBuffer()), boundaryBytes)
  await writeFile(boundaryFile, Buffer.alloc(boundaryBytes.length + 1))
  assert.equal((await download('managed-files', boundaryFile)).status, 413)
  await host.stop()
  console.log('PASS normal Main MCP files: real TS/.NET CLI effects and external results, exact read authority, raw bytes, admin preservation, headless reconnect, inclusive 50 MiB limit')
} catch (error) {
  console.error('Owned Main output:', host.output)
  console.error('Owned CLI outputs:', childOutput)
  throw error
} finally {
  for (const client of clients) await client.close().catch(() => {})
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM'); await exited }
  await host.cleanup()
}
