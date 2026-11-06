// Real PowerShell template and native package; synthetic source bundle for fallback cases.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')
const { isolatedApplicationEnv } = require('../../test/test-process-env.cjs')

for (const scenario of ['native', 'unpublished', 'unsupported', 'server-error']) {
  test(`Windows bootstrap: ${scenario}`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    assert(process.env.FOXWARM_TEST_NATIVE_ARCHIVE, 'Supply the complete qualified Windows archive')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fw-bootstrap-')))
    const source = join(root, 'source'), state = join(root, 'state'), capture = join(root, 'fallback.json')
    const requests = [], sockets = new Set()
    let registration, registrationUrl, child, output = ''
    const server = createServer(async (request, response) => {
      requests.push(request.url)
      if (request.url === '/native.zip') {
        if (scenario === 'unpublished') { response.writeHead(404).end(); return }
        if (scenario === 'server-error') { response.writeHead(503).end(); return }
        response.end(await readFile(process.env.FOXWARM_TEST_NATIVE_ARCHIVE)); return
      }
      if (request.url === '/node/source.tar.gz') { response.end(await readFile(join(root, 'source.tar.gz'))); return }
      response.writeHead(404).end()
    })
    const peer = new WebSocketServer({ server })
    peer.on('connection', (socket, request) => {
      registrationUrl = new URL(request.url, 'http://127.0.0.1')
      sockets.add(socket)
      socket.on('message', bytes => {
        const value = JSON.parse(bytes)
        if (value.type === 'node_register') {
          registration = value
          socket.send(JSON.stringify({ type: 'registered', nodeId: 'bootstrap-windows', nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
        }
      })
    })
    try {
      const bundle = join(root, 'bundle/packages/cli-node/dist')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, 'client.bundle.js'), 'require("fs").writeFileSync(process.env.CAPTURE, JSON.stringify({argv:process.argv,cwd:process.cwd(),agents:process.env.FOXWARM_AGENTS_DIR,agent:process.env.FOXWARM_AGENT_DIR}));\n')
      execFileSync('tar', ['-czf', join(root, 'source.tar.gz'), '-C', join(root, 'bundle'), 'packages'])
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const origin = `http://127.0.0.1:${server.address().port}`
      const script = join(root, 'run.ps1')
      await writeFile(script, (await readFile(resolve('templates/node/run.ps1'), 'utf8')).replace('__FOXWARM_NATIVE_CLI_WIN_URL__', origin + '/native.zip'))
      const env = { ...isolatedApplicationEnv(join(root, 'data')), CAPTURE: capture, PROCESSOR_ARCHITECTURE: scenario === 'unsupported' ? 'ARM64' : 'AMD64', FOXWARM_AGENT_DIR: 'wrong-parent' }
      delete env.PROCESSOR_ARCHITEW6432
      if (scenario === 'native') {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
        env.Path = join(process.env.SystemRoot, 'System32')
      }
      const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
      child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-HostUrl', origin, '-AuthToken', 'synthetic-native-auth', '-NodeId', 'bootstrap-windows', '-StateDir', state, '-SourceDir', source], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = once(child, 'exit')
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
      if (scenario === 'native') {
        const deadline = Date.now() + 20000
        let credentials
        while (Date.now() < deadline && !credentials) {
          try { credentials = JSON.parse(await readFile(join(state, 'state/node_credentials.json'), 'utf8')) } catch {}
          if (!credentials) await new Promise(done => setTimeout(done, 50))
        }
        assert(registration, output)
        assert.equal(registrationUrl.searchParams.get('auth'), 'synthetic-native-auth')
        assert.equal(registrationUrl.searchParams.get('id'), 'bootstrap-windows')
        assert.equal(credentials?.authToken, 'synthetic-native-auth')
        assert.equal(credentials?.nodeId, 'bootstrap-windows', output)
        assert.equal(registration.capabilities.services['vscode-pty'], 1)
        assert.deepEqual(requests, ['/native.zip'])
      } else {
        const [code] = await exited
        if (scenario === 'server-error') {
          assert.notEqual(code, 0)
          assert.deepEqual(requests, ['/native.zip'])
        } else {
          assert.equal(code, 0, output)
          const result = JSON.parse(await readFile(capture, 'utf8'))
          assert(result.argv.includes('synthetic-native-auth'))
          assert.equal(result.cwd.toLowerCase(), root.toLowerCase())
          assert.equal(result.agents.toLowerCase(), join(state, 'agents').toLowerCase())
          assert(!result.agent)
          assert.deepEqual(requests, scenario === 'unsupported' ? ['/node/source.tar.gz'] : ['/native.zip', '/node/source.tar.gz'])
        }
      }
    } finally {
      if (child && child.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
      for (const socket of sockets) socket.terminate()
      await new Promise(done => peer.close(done)); await new Promise(done => server.close(done))
      await rm(root, { recursive: true, force: true })
    }
  })
}
