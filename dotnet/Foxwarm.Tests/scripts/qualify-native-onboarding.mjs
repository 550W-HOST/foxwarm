#!/usr/bin/env node
// Run with --archive <qualified full static Linux x64 release.tar.gz>.
// Only the curl fixture redirects the public asset URL to an owned HTTP server.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, readlink, stat, symlink, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from '../../../packages/webui/test/mainHostFixture.mjs'
import { consoleClient } from '../../../packages/webui/test/cliNodeConsoleFixture.mjs'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'

const run = promisify(execFile)
const archive = process.argv[process.argv.indexOf('--archive') + 1]
assert(process.argv.includes('--archive') && archive, 'Supply the qualified complete native archive with --archive')
assert.equal(process.platform + '/' + process.arch, 'linux/x64')
await stat(archive)
const quote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'"
const canonical = 'https://foxwarm.net/downloads/native-cli-node-latest-v3.tar.gz'
const env = {}, f = await createHostFixture('native-onboarding', { env })
const prefix = '/native-prefix', host = f.origin + prefix
const bin = join(f.root, 'bin'), clients = [], pids = new Set(), results = [], downloads = [], failures = []
let consoleHandle
const api = (method, path, body) => f.api(method, prefix + path, body)
const post = async (path, body) => { const response = await api('POST', path, body); assert.equal(response.status, 200, JSON.stringify(response)); return response.body }
const nodes = async () => (await api('GET', '/api/nodes')).body.nodes
const online = id => until(async () => (await nodes()).find(node => node.id === id && node.online && node.executable), id + ' registered')
const plans = new Map(), rounds = new Map()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/BOOTSTRAP:([\w-]+)/g)].at(-1)?.[1]
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const output = plans.get(key)?.[round] || [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end('fixture error') }
})
const assets = createServer((request, response) => {
  downloads.push(request.url)
  if (request.url !== '/downloads/native-cli-node-latest-v3.tar.gz') { response.writeHead(404); response.end(); return }
  response.setHeader('content-type', 'application/gzip'); createReadStream(archive).pipe(response)
})
async function launch(command, cwd = f.root, extra = {}) {
  const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...clientEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = { child, output: '', exited: once(child, 'exit') }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output += bytes })
  return handle
}
async function completed(handle) {
  const result = await Promise.race([handle.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(handle.output)), 20000); timer.unref() })])
  assert.deepEqual(result, [0, null], handle.output)
}
async function identity(executable) {
  const pid = await until(async () => {
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      if (await readlink('/proc/' + name + '/exe').catch(() => '') === executable) return Number(name)
    }
  }, 'native process ' + executable)
  pids.add(pid)
  const maps = await readFile('/proc/' + pid + '/maps', 'utf8')
  assert(!maps.includes('libcoreclr')); assert(!maps.includes('/libnode'))
  return pid
}
async function stop(pid) {
  try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await until(async () => !(await readlink('/proc/' + pid + '/exe').catch(() => '')), 'native stopped')
  pids.delete(pid)
}
async function execute(id, key, cwd) {
  const session = (await post('/api/sessions', { agentId: 'main', sessionId: key })).sessionId
  plans.set(key, [[call(key + '-select', 'node', { action: 'select', nodeId: id })], [call(key + '-exec', 'exec', { command: 'printf native > ' + quote(key + '.txt') + '; pwd', timeout: 5 })]])
  const response = await api('POST', '/api/sessions/' + encodeURIComponent(session) + '/message', { text: 'BOOTSTRAP:' + key })
  assert.equal(response.status, 202)
  const state = await until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const value = JSON.parse(await readFile(join(f.data, 'state/sessions', session + '.json'), 'utf8'))
    return value.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) ? value : null
  }, 'ordinary exec through Main ' + key, 45000)
  const pair = state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === key + '-exec')?.functionResponse?.response
  assert(pair && !pair.error, JSON.stringify(pair))
  assert.equal(await readFile(join(cwd, key + '.txt'), 'utf8'), 'native')
  assert(JSON.stringify(pair).includes(cwd), JSON.stringify(pair))
}
let clientEnv
try {
  for (const server of [model, assets]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  await mkdir(bin)
  // A native client must not need node, npm, python or a dotnet host on PATH.
  for (const name of ['bash', 'sh', 'tar', 'gzip', 'uname', 'hostname', 'mkdir', 'rm', 'sed', 'awk', 'cksum', 'cat', 'chmod', 'cp', 'sleep', 'nohup', 'env', 'pwd', 'stty']) {
    const { stdout } = await run('/bin/sh', ['-c', 'command -v ' + name])
    await symlink(stdout.trim(), join(bin, name))
  }
  await writeFile(join(bin, 'curl'), `#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  if [ "$arg" = ${quote(canonical)} ]; then arg=${quote('http://127.0.0.1:' + assets.address().port + '/downloads/native-cli-node-latest-v3.tar.gz')}; fi\n  args+=("$arg")\ndone\nexec /usr/bin/curl "\${args[@]}"\n`, { mode: 0o755 })
  clientEnv = { ...testEnvironment.isolatedApplicationEnv(join(f.root, 'client-data')), PATH: bin, HOME: join(f.root, 'home') }
  delete clientEnv.FOXWARM_AGENTS_DIR; delete clientEnv.FOXWARM_AGENT_DIR
  await mkdir(clientEnv.HOME)
  Object.assign(env, testEnvironment.isolatedApplicationEnv(f.data), { FOXWARM_AGENTS_DIR: join(f.data, 'agents') })
  await writeFile(join(f.data, 'state/config.yaml'), `url: ${host}\nbot: {httpPort: ${f.port}, enableWebUI: true, enableTrigger: false}\nvector: false\ndbWorkers: false\nchannels: {}\n`)
  await writeFile(f.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + model.address().port, models: ['wire'] } } }))
  await f.start()
  assert.equal((await fetch(host + '/login.html')).status, 200, 'Build and stage the real WebUI assets in the Main output before this qualification')
  for (const name of ['run.sh', 'run-interactive.sh', 'run-cli-node.sh', 'docker-compose.yaml']) {
    const response = await fetch(host + '/node/' + name); assert.equal(response.status, 200)
    const text = await response.text(); assert(text.includes(canonical)); assert(!text.includes('__FOXWARM_'))
  }
  const install = join(f.root, "install root's"), source = join(install, 'foxwarm-node')
  const direct = await post('/api/nodes/onboarding/create', { nodeId: 'native-direct', installDir: install })
  assert.equal(direct.baseUrl, host)
  const foreground = await launch(direct.commands.bareMetal)
  await online(direct.nodeId)
  let pid = await identity(join(source, 'native-cli-node-linux-x64/Foxwarm.CliNode'))
  const credentials = join(install, 'data/state/node_credentials.json')
  const saved = await until(() => readFile(credentials, 'utf8').then(JSON.parse).catch(() => null), 'native direct credentials persisted')
  assert.equal(saved.authToken, direct.authToken)
  assert.equal((await stat(credentials)).mode & 0o077, 0)
  await execute(direct.nodeId, 'direct', source)
  assert.equal(await readlink('/proc/' + pid + '/cwd'), source)
  await stop(pid); await completed(foreground)
  results.push('Generated precreated-token foreground command: native identity, private credentials, prefix, original install cwd and ordinary exec')

  const background = await launch(direct.commands.bareMetalBackground)
  await completed(background); await online(direct.nodeId)
  pid = Number(await readFile(join(install, 'data/node.pid'), 'utf8'))
  assert.equal(await identity(join(source, 'native-cli-node-linux-x64/Foxwarm.CliNode')), pid)
  assert.equal((await readFile(join(install, 'data/node.mode'), 'utf8')).trim(), 'nohup')
  await execute(direct.nodeId, 'background', source)
  await stop(pid)
  // Follow the generated nohup stop guidance before reinstalling a service.
  await rm(join(install, 'data/node.pid')); await rm(join(install, 'data/node.mode'))
  const stored = await launch(`curl -fsSL ${quote(host + '/node/run.sh')} | bash -s -- --dir=${quote(install)} --host=${quote(host)}`)
  await online(direct.nodeId); pid = await identity(join(source, 'native-cli-node-linux-x64/Foxwarm.CliNode'))
  assert.equal(JSON.parse(await readFile(credentials, 'utf8')).authToken, saved.authToken)
  await f.stop(); await f.start(); await online(direct.nodeId)
  await execute(direct.nodeId, 'stored-reconnect', source)
  await stop(pid); await completed(stored)
  results.push('Generated background command, saved credential bootstrap and cold Main reconnect retain identity/auth and ordinary exec')

  const pairedInstall = join(f.root, 'paired')
  const pairing = await post('/api/nodes/onboarding/commands', { nodeId: 'native-paired', installDir: pairedInstall })
  const paired = await launch(pairing.commands.bareMetal)
  const pending = await until(async () => (await api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'native-paired'), 'pending native pairing')
  await post('/api/nodes/onboarding/approve', { pendingId: pending.id })
  await online('native-paired')
  pid = await identity(join(pairedInstall, 'foxwarm-node/native-cli-node-linux-x64/Foxwarm.CliNode'))
  await execute('native-paired', 'pairing', join(pairedInstall, 'foxwarm-node'))
  await stop(pid); await completed(paired)
  results.push('Generated shared-pairing command, administrator approval, saved credential and native exec')

  const interactive = await post('/api/nodes/onboarding/create', { nodeId: 'native-interactive' })
  const consoleRoot = join(f.root, 'console'), consoleSource = join(consoleRoot, 'source'), consoleState = join(consoleRoot, 'state')
  consoleHandle = await consoleClient(consoleRoot, [], { command: ['/bin/bash', '-c', interactive.commands.interactive + ' --source-dir=' + quote(consoleSource) + ' --state-dir=' + quote(consoleState) + ' --auto-approve=exec'], environment: clientEnv })
  await online(interactive.nodeId)
  pid = await identity(join(consoleSource, 'native-cli-node-linux-x64/Foxwarm.CliNode'))
  const interactiveTurn = execute(interactive.nodeId, 'interactive', consoleRoot)
  await consoleHandle.wait(handle => handle.screen().includes('get_default_cwd {}'), 'manual selection approval')
  consoleHandle.write('y')
  await interactiveTurn
  await consoleHandle.wait(handle => handle.screen().includes('Bound sessions (1)') && handle.screen().includes('DONE-interactive'), 'native bound Session list and history')
  consoleHandle.write('q'); await consoleHandle.stopped(); pids.delete(pid)
  results.push('Generated interactive curl pipeline attaches its TTY, native auto-approval executes a Main call, quit restores terminal state')

  // Compose rendering is real; no Docker daemon is needed or claimed here.
  const composeRoot = join(f.root, 'compose'); await mkdir(composeRoot)
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/docker-calls"\n', { mode: 0o755 })
  const docker = await post('/api/nodes/onboarding/create', { nodeId: 'native-docker' })
  await completed(await launch(docker.commands.manualCompose, composeRoot))
  const parsed = JSON.parse((await run('/usr/bin/docker', ['compose', '--env-file', '.env', 'config', '--format', 'json'], { cwd: composeRoot, timeout: 15000 })).stdout)
  const service = parsed.services['foxwarm-node']
  assert.equal(service.build.args.NODE_HOST, host)
  assert.equal(service.environment.NODE_AUTH_TOKEN, docker.authToken)
  assert.equal(service.environment.NODE_TOKEN, '')
  assert.equal(service.environment.FOXWARM_AGENTS_DIR, undefined)
  assert(service.volumes.some(volume => volume.target === '/app/agents' && volume.source === join(composeRoot, 'data/agents')))
  assert(service.build.dockerfile_inline.includes(canonical))
  assert(service.build.dockerfile_inline.includes('uname -m'))
  const composePairRoot = join(f.root, 'compose-pairing'); await mkdir(composePairRoot)
  await completed(await launch(pairing.commands.docker + ' -d', composePairRoot))
  const pairConfig = JSON.parse((await run('/usr/bin/docker', ['compose', '--env-file', '.env', 'config', '--format', 'json'], { cwd: composePairRoot, timeout: 15000 })).stdout)
  assert.equal(pairConfig.services['foxwarm-node'].environment.NODE_TOKEN, (await readFile(join(f.data, 'state/node_token'), 'utf8')).trim())
  assert.equal(pairConfig.services['foxwarm-node'].environment.NODE_AUTH_TOKEN, '')
  const dockerRoot = join(f.root, 'docker-app'); await mkdir(dockerRoot)
  await run('tar', ['-xzf', archive, '-C', dockerRoot])
  const startup = await (await fetch(host + '/node/start-sandbox-node.sh')).text()
  await writeFile(join(dockerRoot, 'start.sh'), startup)
  const dockerState = join(f.root, 'docker-data'); await mkdir(join(dockerState, 'state'), { recursive: true })
  const containerStartup = await launch('/bin/sh ./start.sh', dockerRoot, { NODE_URL: host, NODE_ID: docker.nodeId, NODE_AUTH_TOKEN: docker.authToken, NODE_CREDENTIALS_FILE: join(dockerState, 'state/node_credentials.json') })
  await online(docker.nodeId); pid = await identity(join(dockerRoot, 'native-cli-node-linux-x64/Foxwarm.CliNode'))
  await execute(docker.nodeId, 'docker-startup', dockerRoot)
  assert((await readdir(join(dockerRoot, 'agents/main/.temp/exec'))).length > 0)
  await stop(pid); await completed(containerStartup)
  results.push('Real offline Compose parser and exact public Docker startup script with native auth/exec and original Agent paths; not a container build/run')

  await writeFile(join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo 1000;; *) echo tester;; esac\n', { mode: 0o755 })
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/systemctl-calls"\n', { mode: 0o755 })
  const serviceEnv = { XDG_CONFIG_HOME: join(f.root, 'service-config') }
  await completed(await launch(direct.commands.bareMetalInstall, f.root, serviceEnv))
  const unit = await readFile(join(serviceEnv.XDG_CONFIG_HOME, 'systemd/user/foxwarm-node-native-direct.service'), 'utf8')
  const serviceRuntime = join(f.root, 'service-runtime'); await mkdir(serviceRuntime, { mode: 0o700 })
  await run('/usr/bin/systemd-analyze', ['--user', 'verify', join(install, 'systemd/foxwarm-node-native-direct.service')], { env: { ...clientEnv, ...serviceEnv, XDG_RUNTIME_DIR: serviceRuntime } })
  assert(unit.includes('Type=simple')); assert(unit.includes('run-node-client.sh')); assert(!unit.includes('nohup'))
  const serviceCalls = await readFile(join(clientEnv.HOME, 'systemctl-calls'), 'utf8')
  assert(serviceCalls.includes('--user enable foxwarm-node-native-direct.service')); assert(serviceCalls.includes('--user restart foxwarm-node-native-direct.service'))
  results.push('Generated service command retains user-systemd foreground launcher and enable/restart calls (systemctl effects mocked)')

  const disk = await readFile(join(f.data, 'state/nodes.json'), 'utf8')
  assert(!disk.includes(direct.authToken)); assert(!f.output.includes(direct.authToken))
  assert(downloads.length >= 6); assert(downloads.every(path => path === '/downloads/native-cli-node-latest-v3.tar.gz'))
  assert.deepEqual(failures, [])
  await f.stop()
  console.log(JSON.stringify({ results, nativeDownloads: downloads.length, domainValidation: 'owned fixture only; foxwarm.net not contacted' }, null, 2))
} catch (error) {
  console.error(f.output)
  for (const client of clients) console.error(client.output)
  if (consoleHandle) console.error(consoleHandle.output)
  throw error
} finally {
  await consoleHandle?.dispose()
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  for (const { child } of clients) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  for (const server of [model, assets]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await f.cleanup()
}
