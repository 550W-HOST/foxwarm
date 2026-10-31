// POSIX logical cwd through normal Main, real TS/.NET CLI Nodes and persisted Sessions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { createHostFixture, until } from './mainHostFixture.mjs'

test('POSIX exec preserves logical cwd until a real cd through Main and both CLI Nodes', { skip: process.platform !== 'linux' }, async t => {
  // The owned localhost provider must not use the isolation fixture's closed outbound proxy.
  const options = { env: { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' } }
  const host = await createHostFixture('exec-logical-cwd', options)
  options.cwd = host.root
  options.env.PWD = host.root
  const children = [], plans = new Map(), failures = []
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const saved = id => readFile(join(host.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const peer = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      const prompt = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...prompt.matchAll(/LOGICAL-CWD:([\w-]+)/g)].at(-1)?.[1]
      const call = plans.get(key)
      assert(call, 'Only owned test turns may reach the provider.')
      const followup = body.input.some(row => row.type === 'function_call_output' && row.call_id === call.call_id)
      const output = followup ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }] : [call]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 3 } } }) + '\n\n')
    } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  async function turn(id, key, command) {
    plans.set(key, { type: 'function_call', call_id: key, name: 'exec', arguments: JSON.stringify({ command, timeout: 15 }) })
    assert.equal((await host.api('POST', route(id) + '/message', { text: 'LOGICAL-CWD:' + key })).status, 202)
    const state = await until(async () => {
      assert.equal(failures.length, 0, failures.join('\n'))
      const state = await saved(id)
      return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) && state
    }, key).catch(async error => {
      const state = await saved(id)
      console.error('Owned Session at failure:', JSON.stringify({ id, busy: state.busy, history: state.history }))
      console.error('Owned Main output:', host.output)
      throw error
    })
    const result = state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === key)?.functionResponse?.response
    assert(result && !result.error, JSON.stringify(result))
    return { state, output: result.output }
  }
  try {
    await mkdir(join(host.work, 'memory'), { recursive: true })
    await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
    await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'] } } }))
    await host.start()
    for (const id of ['ts-cwd', 'managed-cwd']) {
      const root = join(host.root, id); await mkdir(root)
      const credential = await host.api('POST', '/api/nodes/onboarding/create', { nodeId: id, fallbackUrl: host.origin })
      assert.equal(credential.status, 200)
      const managed = id === 'managed-cwd'
      const executable = managed ? join(process.env.DOTNET_ROOT, 'dotnet') : process.execPath
      const entry = resolve(managed ? 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll' : 'packages/cli-node/dist/client.js')
      const child = spawn(executable, [entry, '--host', host.origin, '--id', id, '--auth-token', credential.body.authToken, '--credentials-file', join(root, 'credentials.json'), '--no-local-trigger'], {
        cwd: root, env: { ...testEnvironment.isolatedApplicationEnv(root), PWD: root, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const handle = { child, output: '' }; children.push(handle)
      child.stdout.on('data', bytes => { handle.output += bytes }); child.stderr.on('data', bytes => { handle.output += bytes })
      await until(async () => (await host.api('GET', '/api/nodes')).body.nodes.some(node => node.id === id && node.online && node.executable), id + ' authenticated')
    }
    for (const node of ['master', 'ts-cwd', 'managed-cwd']) {
      await t.test(node, async () => {
        const root = join(host.root, 'paths-' + node), physical = join(root, 'physical'), logical = join(root, 'linked')
        await mkdir(join(physical, 'child'), { recursive: true }); await symlink(physical, logical, 'dir')
        const created = await host.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'cwd-' + node })
        assert.equal(created.status, 200)
        const id = created.body.sessionId
        const execDirectory = join(node === 'master' ? host.work : join(host.root, node, 'agents/main'), '.temp/exec')
        assert.equal((await host.api('POST', route(id) + '/node', { nodeId: node })).status, 200)
        assert.equal((await host.api('POST', route(id) + '/cwd', { cwd: logical })).status, 200)
        const unchanged = await turn(id, node + '-unchanged', 'printf "%s\\n" "$PWD"; pwd')
        assert(unchanged.output.startsWith(logical + '\n' + logical + '\n'), unchanged.output)
        const firstSidecars = (await readdir(execDirectory, { recursive: true })).filter(file => file.endsWith('.cwd.txt'))
        assert.equal(firstSidecars.length, 1)
        assert.equal((await readFile(join(execDirectory, firstSidecars[0]), 'utf8')).trim(), logical)
        if (node === 'master') {
          assert.equal(unchanged.state.cwd, logical)
          assert.doesNotMatch(unchanged.output, /SESSION CWD CHANGED/)
        }
        const moved = await turn(id, node + '-moved', 'cd child; printf "%s\\n" "$PWD"; pwd')
        const expected = join(logical, 'child')
        assert(moved.output.startsWith(expected + '\n' + expected + '\n'), moved.output)
        const sidecars = (await readdir(execDirectory, { recursive: true })).filter(file => file.endsWith('.cwd.txt'))
        const finalCwds = await Promise.all(sidecars.map(file => readFile(join(execDirectory, file), 'utf8').then(value => value.trim())))
        assert.deepEqual(finalCwds.sort(), [logical, expected].sort())
        if (node === 'master') {
          assert.equal(moved.state.cwd, expected)
          assert.match(moved.output, /SESSION CWD CHANGED/)
          assert.equal((await host.api('GET', route(id) + '/state')).body.session.cwd, expected)
        }
      })
    }
    await host.stop()
  } catch (error) {
    console.error('Owned Main output:', host.output)
    console.error('Owned CLI outputs:', children.map(handle => handle.output))
    throw error
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM'); await exited }
    await host.cleanup(); await new Promise(done => peer.close(done))
  }
})
