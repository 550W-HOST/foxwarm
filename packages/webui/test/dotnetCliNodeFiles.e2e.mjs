// New headless CLI through normal Source and C# Main model, transfer and image owners.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const dll = resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')
for (const runtime of ['source', 'dotnet']) {
  const env = {}, fixture = await createHostFixture('native-cli-' + runtime, { runtime, env })
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '' })
  const plans = new Map(), rounds = new Map(), requests = [], errors = [], processes = []
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
  const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NATIVE-FILES-DONE-' + key }] }]
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw)
      const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...prompt.matchAll(/NATIVEFILES:([\w-]+)/g)].at(-1)?.[1]
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || final(key)
      requests.push({ key, body })
      for (const tool of output.filter(part => part.type === 'function_call')) assert((body.tools || []).some(def => def.type === 'function' && def.name === tool.name), 'ordinary advertised tool ' + tool.name)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: native-cli-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, models: ['wire'] } } }))
  async function online() { return until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'native-files' && node.online), runtime + ' native Node online', 22000) }
  async function launch(extra) {
    const cwd = join(fixture.root, 'cli'), agents = join(cwd, 'agents')
    await mkdir(join(agents, 'main'), { recursive: true })
    const child = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [dll, '--host', fixture.origin, '--no-local-trigger', '--credentials-file', join(cwd, 'credentials.json'), ...extra], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: agents }, stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = { child, output: '' }; processes.push(handle)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-20000) })
    return handle
  }
  async function stop(handle) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
    const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
    await Promise.race([exited, sleep(4000).then(() => handle.child.kill('SIGKILL'))]); await exited
  }
  async function turn(id, key, steps) {
    plans.set(key, steps); rounds.set(key, 0)
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'NATIVEFILES:' + key })
    assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
    return until(async () => {
      if (errors.length) throw new Error(errors.join('\n'))
      const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
      return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'NATIVE-FILES-DONE-' + key)) ? state : null
    }, runtime + ' model/file turn ' + key, 30000)
  }
  function good(state, id) { const result = pair(state, id); assert(result && !result.error, id + ': ' + JSON.stringify(result)); return result }
  try {
    await fixture.start()
    let cli = await launch(['--id', 'native-files', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()])
    const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'native-files'), 'ordinary pairing pending')
    assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    await online()
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'native-files-owner' })
    assert.equal(created.status, 200, JSON.stringify(created)); const id = created.body.sessionId
    let state = await turn(id, 'select', [[call('select', 'node', { action: 'select', nodeId: 'native-files' })]])
    good(state, 'select')
    const cwd = join(fixture.root, 'cli/project'), agent = join(fixture.root, 'cli/agents/main')
    await mkdir(cwd); assert.equal((await fixture.api('POST', route(id) + '/cwd', { cwd })).status, 200)
    state = await turn(id, 'file-tools', [[
      call('write', 'write', { filePath: 'nested/data.txt', content: 'first\r\nsecond\nlast', createDirs: true }),
      call('edit', 'edit', { filePath: 'nested/data.txt', oldText: 'second', newText: 'SECOND' }),
      call('patch', 'edit', { apply_patch: '*** Begin Patch\n*** Update File: nested/data.txt\n@@\n-first\n+FIRST\n*** End Patch' }),
      call('read', 'read', { filePath: 'nested/data.txt', startLine: 2, endLine: 3 }),
      call('agent-write', 'write', { filePath: '$fw_tmp/agent.txt', content: 'agent-owned', createDirs: true }),
    ]])
    for (const name of ['write', 'edit', 'patch', 'read', 'agent-write']) good(state, name)
    assert.equal(await readFile(join(cwd, 'nested/data.txt'), 'utf8'), 'FIRST\r\nSECOND\r\nlast')
    assert.equal(await readFile(join(agent, 'tmp/agent.txt'), 'utf8'), 'agent-owned')
    assert(good(state, 'read').output.includes('SECOND'))
    assert(!JSON.stringify(good(state, 'read')).includes('__foxwarmResolvedToolPaths'))
    assert(state.history.some(row => JSON.stringify(row).includes('nested/data.txt')))

    const mainRoot = runtime === 'source' ? join(fixture.data, 'agents/main') : fixture.work
    await mkdir(mainRoot, { recursive: true })
    const binary = Buffer.alloc(1024 * 1024 + 7, 0x97); await writeFile(join(mainRoot, 'source.bin'), binary)
    state = await turn(id, 'transfer', [[
      call('to-node', 'copy_between_nodes', { sourceNode: 'master', sourcePath: 'source.bin', targetNode: 'native-files', targetPath: 'transfer.bin' }),
      call('to-main', 'copy_between_nodes', { sourceNode: 'native-files', sourcePath: 'transfer.bin', targetNode: 'master', targetPath: 'returned.bin' }),
    ]])
    good(state, 'to-node'); good(state, 'to-main'); assert.deepEqual(await readFile(join(agent, 'transfer.bin')), binary); assert.deepEqual(await readFile(join(mainRoot, 'returned.bin')), binary)
    state = await turn(id, 'programmatic', [[call('programmatic', 'run_script', { code: "r = call_tool('read', {'filePath': 'nested/data.txt'})\nreturn {'content': r['content'], 'truncated': r['truncated'], 'selectedBytes': r['selectedBytes']}" })]])
    assert.deepEqual(good(state, 'programmatic').result, { content: 'FIRST\r\nSECOND\r\nlast', truncated: false, selectedBytes: 19 })
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 120, g: 25, b: 90, alpha: 1 } } }).png().toBuffer()
    await writeFile(join(cwd, 'pixels.dat'), png)
    let imageId
    state = await turn(id, 'image', [[call('image', 'read', { filePath: 'pixels.dat' })], body => {
      const ids = []
      function collect(value) {
        if (typeof value === 'string') for (const match of value.matchAll(/\[IMAGE: id=("(?:\\.|[^"\\])*"|[^,\]\s]+)/g)) ids.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1])
        else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
      }
      collect(body.input); assert(ids.length > 0, JSON.stringify(body.input)); imageId = ids.at(-1)
      return [call('export', 'image_write_to_file', { id: imageId, filePath: join(cwd, 'exported.png') }), call('delivery', 'send_file', { filePath: join(cwd, 'pixels.dat') })]
    }])
    good(state, 'image'); good(state, 'export'); good(state, 'delivery'); assert.deepEqual(await readFile(join(cwd, 'exported.png')), png)
    assert(requests.some(({ key, body }) => key === 'image' && JSON.stringify(body).includes('input_image')))
    assert(!requests.some(({ body }) => JSON.stringify(body).includes('__foxwarmResolvedToolPaths')))
    state = await turn(id, 'partial', [[call('partial', 'edit', { apply_patch: '*** Begin Patch\n*** Add File: kept.txt\n+kept\n*** Update File: missing.txt\n-old\n+new\n*** End Patch' })]])
    assert(pair(state, 'partial').error); assert.equal(await readFile(join(cwd, 'kept.txt'), 'utf8'), 'kept')

    state = await turn(id, 'unified-edit', [[
      call('batch', 'edit', { filePath: 'nested/data.txt', edits: [{ oldText: 'FIRST', newText: 'SECOND' }, { oldText: 'SECOND', newText: '$&\n' }] }),
    ], [call('all', 'edit', { filePath: 'nested/data.txt', oldText: '$', newText: '$$', replaceAll: true })]])
    good(state, 'batch'); good(state, 'all')
    assert.equal(await readFile(join(cwd, 'nested/data.txt'), 'utf8'), 'SECOND\r\n$$&\n\r\nlast')

    await stop(cli); cli = await launch([]); await online()
    state = await turn(id, 'credential-restart', [[call('restart-read', 'read', { filePath: 'nested/data.txt' })]])
    good(state, 'restart-read')
    await fixture.stop(); await fixture.start(); await online()
    state = await turn(id, 'main-restart', [[call('main-restart-read', 'read', { filePath: 'nested/data.txt' })]])
    good(state, 'main-restart-read')
    assert.equal(errors.length, 0)
    console.log(JSON.stringify({ runtime, actualCliProcesses: processes.length, hostStarts: fixture.hostPids.length, modelRequests: requests.length, fileTools: true, programmatic: true, transfers: true, inlineImageExportAndDelivery: true, credentialAndMainRestart: true }))
  } catch (error) { console.error(runtime, fixture.output, processes.map(process => process.output).join('\n')); throw error }
  finally {
    for (const process of processes) await stop(process)
    model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
  }
}
