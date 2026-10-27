// Actual Source and managed/native CLI Code services, owned files and real Git repositories.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access, symlink, chmod, truncate, lstat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { until, sleep } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const http = createServer(), peer = new WebSocketServer({ server: http, maxPayload: 80 * 1024 * 1024 })
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `http://127.0.0.1:${http.address().port}`, frames = [], clients = [], sockets = new Set(), connected = new Map(), registrations = new Map(), generations = new Map()
let serial = 0
peer.on('connection', (socket, request) => {
  const id = new URL(request.url, origin).searchParams.get('id')
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  socket.on('message', bytes => {
    const value = JSON.parse(bytes); frames.push({ socket, id, value })
    if (value.type === 'node_register') {
      registrations.set(id, value); connected.set(id, socket); generations.set(id, (generations.get(id) || 0) + 1)
      socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    }
  })
})
async function launch(name, source = false, env = {}) {
  const cwd = join(root, name); await mkdir(cwd, { recursive: true })
  const executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
  const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', origin + '/code', '--id', name, '--auth-token', 'synthetic-code-token', '--no-local-trigger', '--credentials-file', join(cwd, 'credentials.json')], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents'), ...env } })
  const handle = { child, cwd, id: name, output: '' }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-20000) })
  await until(() => connected.get(name), 'CLI register ' + name)
  handle.socket = connected.get(name); return handle
}
async function stop(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { handle.child.kill('SIGKILL'); reject(new Error(handle.output)) }, 6000) })]) }
  finally { clearTimeout(timer) }
}
async function request(handle, service, operation, args = {}, extra = {}) {
  const requestId = 'code-' + ++serial, socket = handle.socket
  socket.send(JSON.stringify({ type: 'node_service_request', requestId, service, operation, args, ...extra }))
  return until(() => frames.find(row => row.socket === socket && row.value.requestId === requestId)?.value, operation + ':' + JSON.stringify(args).slice(0, 500), 25000)
}
const good = reply => { assert.equal(reply.type, 'node_service_response', JSON.stringify(reply)); assert.equal(reply.service, undefined); return reply.result }
const exists = path => access(path).then(() => true, () => false)
function normalized(value, cwd) {
  if (Array.isArray(value)) return value.map(item => normalized(item, cwd))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['requestId', 'ctime', 'mtime'].includes(key)).map(([key, item]) => [key, normalized(item, cwd)]))
  return typeof value === 'string' ? value.replaceAll(cwd, '<root>') : value
}
async function gitContentBoundary(handle) {
  const workspace = join(handle.cwd, 'git-content-boundary'); await mkdir(workspace)
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Code Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(workspace, '..literal'), 'committed literal\n'); await writeFile(join(workspace, 'ordinary'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'content boundary'); const oid = git('rev-parse', 'HEAD')
  await writeFile(join(workspace, 'ordinary'), 'working\n'); await mkdir(join(workspace, 'directory'))
  const denied = join(workspace, 'denied'); await mkdir(denied); await writeFile(join(denied, 'file'), 'not readable'); await chmod(denied, 0)
  const rows = []
  const cases = [
    { path: '..literal', side: 'base' },
    { path: './..literal', side: 'base', ref: oid },
    { path: '..literal', side: 'working' },
    { path: '..literal', side: 'base', ref: 'invalid' },
    { path: '..literal', side: 'invalid', ref: 'invalid' },
    { path: '../escape', side: 'base', ref: 'invalid' },
    { path: 'denied/file', side: 'working' },
    { path: 'ordinary/child', side: 'working' },
    { path: 'missing', side: 'working' },
    { path: 'directory', side: 'working' },
    { path: 'ordinary', side: 'working', ref: 'ignored-invalid-ref' },
    { path: 'ordinary', side: 'base', ref: oid },
  ]
  try {
    for (const args of cases) {
      const reply = await request(handle, 'vscode-git', 'content', { workspace, ...args })
      rows.push(reply.error ? { code: reply.error.code, statusCode: reply.error.statusCode } : good(reply))
    }
    const fs = await request(handle, 'vscode-fs', 'stat', { path: join(denied, 'file') })
    rows.push({ code: fs.error.code, statusCode: fs.error.statusCode })
  } finally { await chmod(denied, 0o755) }
  assert.equal(git('rev-parse', 'HEAD'), oid)
  return rows
}
async function corpus(handle) {
  const { cwd } = handle, rows = [], workspace = join(cwd, 'repo')
  const fs = (operation, args = {}) => take('vscode-fs', operation, args)
  async function take(service, operation, args = {}, extra = {}) {
    const reply = await request(handle, service, operation, args, extra)
    // Native OS and git executable diagnostics differ; service codes/status and all success data do not.
    if (reply.error && ['Unknown', 'GitError'].includes(reply.error.code)) { assert(reply.error.message); rows.push({ type: reply.type, code: reply.error.code, statusCode: reply.error.statusCode }) }
    else rows.push(normalized(reply, cwd))
    return reply
  }
  for (const path of [undefined, '', 'relative', '$fw_agentdir/file', '~/file', 'nul\0path']) await fs('stat', { path })
  const dir = join(cwd, 'files'), file = join(dir, ' literal%20 雪.bin ')
  good(await fs('create-directory', { path: dir }))
  await fs('create-directory', { path: dir }); await fs('create-directory', { path: join(cwd, 'absent/child') })
  await fs('write-file', { path: file, contentBase64: 'AAH/gA==' })
  good(await fs('write-file', { path: file, contentBase64: 'AAH_gA!?', create: 'true' }))
  assert.deepEqual(await readFile(file), Buffer.from([0, 1, 255, 128]))
  for (const create of [true, 1, '1', 'true']) await fs('write-file', { path: file, contentBase64: 'eA==', create })
  for (const create of [false, 0, 2, 'TRUE', 'yes']) { good(await fs('write-file', { path: file, contentBase64: 'YWJj', create })); assert.equal(await readFile(file, 'utf8'), 'abc') }
  good(await fs('write-file', { path: file, create: true, overwrite: true, contentBase64: null }))
  assert.equal((await readFile(file)).length, 0)
  good(await fs('write-file', { path: file, contentBase64: 'AAH/gA==', overwrite: true }))
  good(await fs('read-file', { path: file })); await fs('read-file', { path: dir }); await fs('read-directory', { path: file })
  await fs('stat', { path: file + '/child' }); await fs('write-file', { path: file + '/child', create: true })
  const link = join(dir, 'link'), dangling = join(dir, 'dangling'), dirlink = join(dir, 'directory-link')
  await symlink(file, link); await symlink(join(dir, 'not-present'), dangling); await symlink(dir, dirlink)
  good(await fs('stat', { path: link })); good(await fs('stat', { path: dirlink })); await fs('stat', { path: dangling })
  await chmod(file, 0o444); const readonly = good(await fs('stat', { path: file })); assert.equal(readonly.permissions, 1); await chmod(file, 0o644)
  const listing = good(await fs('read-directory', { path: dir })); listing.entries.sort((a, b) => a.name.localeCompare(b.name)); rows[rows.length - 1] = normalized({ result: listing }, cwd)
  good(await fs('write-file', { path: link, contentBase64: 'bGlua2Vk', overwrite: true })); assert.equal(await readFile(file, 'utf8'), 'linked'); assert((await lstat(link)).isSymbolicLink())
  await fs('write-file', { path: dangling, contentBase64: 'eA==', create: true })
  good(await fs('write-file', { path: dangling, contentBase64: 'eA==', create: true, overwrite: true })); assert.equal(await readFile(join(dir, 'not-present'), 'utf8'), 'x')
  const denied = join(cwd, 'denied'); await mkdir(denied); await writeFile(join(denied, 'file'), 'private'); await chmod(denied, 0)
  try { await fs('stat', { path: join(denied, 'file') }); await fs('read-directory', { path: denied }); await fs('write-file', { path: join(denied, 'new'), create: true }) }
  finally { await chmod(denied, 0o755) }
  const empty = join(cwd, 'empty'); await mkdir(empty); await fs('delete', { path: empty, recursive: false }); assert(await exists(empty))
  const emptyLink = join(cwd, 'empty-link'); await symlink(empty, emptyLink); good(await fs('delete', { path: emptyLink })); assert(await exists(empty))
  const destination = join(cwd, 'destination'); await writeFile(destination, 'destination')
  await fs('rename', { path: file, newPath: destination }); assert.equal(await readFile(destination, 'utf8'), 'destination')
  good(await fs('rename', { path: file, newPath: destination, overwrite: true })); assert.equal(await readFile(destination, 'utf8'), 'linked')
  // Source removes an overwrite destination before rename; self-renames expose that partial effect.
  await fs('rename', { path: destination, newPath: destination, overwrite: true }); assert(!await exists(destination))
  // The actual filesystem cross-device error must not restore the already removed destination.
  if (process.platform === 'linux' && await exists('/dev/shm')) {
    const cross = '/dev/shm/foxwarm-code-' + process.pid + '-' + handle.id
    await writeFile(cross, 'old'); const source = join(cwd, 'cross-source'); await writeFile(source, 'kept')
    try { await fs('rename', { path: source, newPath: cross, overwrite: true }); assert(!await exists(cross)); assert.equal(await readFile(source, 'utf8'), 'kept') }
    finally { await rm(cross, { force: true }) }
  }
  good(await fs('delete', { path: dir, recursive: true })); await fs('delete', { path: dir })
  // Inclusive limits travel through the real service's JSON/base64 envelope.
  const boundary = join(cwd, 'boundary'), bytes = Buffer.alloc(50 * 1024 * 1024, 0x91)
  const written = good(await request(handle, 'vscode-fs', 'write-file', { path: boundary, create: true, contentBase64: bytes.toString('base64') })); assert.equal(written.stat.size, bytes.length)
  assert.deepEqual(Buffer.from(good(await request(handle, 'vscode-fs', 'read-file', { path: boundary })).contentBase64, 'base64'), bytes)
  const tooLarge = await request(handle, 'vscode-fs', 'write-file', { path: boundary, overwrite: true, contentBase64: Buffer.alloc(bytes.length + 1).toString('base64') }); assert.equal(tooLarge.error.code, 'PayloadTooLarge'); assert.equal(tooLarge.error.statusCode, 413); assert.deepEqual(await readFile(boundary), bytes)
  await truncate(boundary, bytes.length + 1); await fs('read-file', { path: boundary }); await rm(boundary)
  await fs('unknown', { path: cwd }); await take('vscode-git', 'unknown', { workspace: cwd }); await take('not-advertised', 'unknown')
  await mkdir(workspace)
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Code Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  const gitEnv = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
  const commit = message => execFileSync('git', ['-C', workspace, 'commit', '-qm', message], { env: { ...process.env, ...gitEnv } })
  await writeFile(join(workspace, 'old.txt'), 'base\n'); git('add', '.'); commit('root'); const rootCommit = git('rev-parse', 'HEAD')
  git('mv', 'old.txt', 'renamed.txt'); await writeFile(join(workspace, 'binary'), Buffer.from([0, 255])); git('add', '.'); commit('rename and binary'); const oid = git('rev-parse', 'HEAD')
  await writeFile(join(workspace, 'renamed.txt'), 'working\n'); await writeFile(join(workspace, 'untracked 雪'), 'new'); await mkdir(join(workspace, 'subdir'))
  const gitCall = (operation, args = {}) => take('vscode-git', operation, { workspace, ...args })
  const status = good(await gitCall('status', { workspace: join(workspace, 'subdir') })); assert.equal(status.topLevel, workspace); assert(status.changes.some(row => row.path === 'untracked 雪'))
  for (const id of [rootCommit, oid, oid.slice(0, 9), oid.toUpperCase()]) good(await gitCall('commit', { id }))
  for (const id of [undefined, 'HEAD', 'v1', '-x', 'abcdef', git('rev-parse', 'HEAD:binary')]) await gitCall('commit', { id })
  for (const side of ['base', 'working']) for (const path of ['renamed.txt', 'binary', 'absent', 'subdir', 'subdir/absent', './', 'subdir/../']) good(await gitCall('content', { path, side }))
  good(await gitCall('content', { path: 'renamed.txt', side: 'base', ref: oid }))
  for (const ref of ['HEAD~1', oid.slice(0, 9), '-x', 1]) await gitCall('content', { path: 'renamed.txt', side: 'base', ref })
  good(await gitCall('content', { path: 'renamed.txt', side: 'working', ref: 'ignored-nonimmutable-ref' }))
  for (const path of ['../escape', '/absolute', '.', 'a/../../escape', '..literal', 'nul\0path']) await gitCall('content', { path, side: 'working' })
  await gitCall('content', { path: '../escape', side: 'base', ref: 1 }); await gitCall('content', { path: 'renamed.txt', side: 'invalid', ref: 1 })
  for (const side of [undefined, '', 'invalid']) await gitCall('content', { path: 'renamed.txt', side })
  await take('vscode-git', 'status', { workspace: cwd }); await take('vscode-git', 'status', { workspace: 'relative' })
  const large = join(workspace, 'large'); await writeFile(large, Buffer.alloc(10 * 1024 * 1024, 0x32)); assert.equal(Buffer.from(good(await request(handle, 'vscode-git', 'content', { workspace, path: 'large', side: 'working' })).contentBase64, 'base64').length, 10 * 1024 * 1024)
  await truncate(large, 10 * 1024 * 1024 + 1); await gitCall('content', { path: 'large', side: 'working' })
  git('add', 'large'); commit('large'); await gitCall('content', { path: 'large', side: 'base' })
  assert.equal(git('rev-parse', 'HEAD^'), oid, 'read-only service must not mutate refs/index/worktree')
  // Real submodule worktree OIDs, including a packed-ref lookup, do not borrow git status helpers.
  const child = join(cwd, 'child'); await mkdir(child)
  const childGit = (...args) => execFileSync('git', ['-C', child, ...args], { encoding: 'utf8', env: { ...process.env, ...gitEnv } }).trim()
  childGit('init', '-q'); childGit('config', 'user.name', 'Code Fixture'); childGit('config', 'user.email', 'fixture@example.invalid'); await writeFile(join(child, 'child.txt'), 'first'); childGit('add', '.'); childGit('commit', '-qm', 'child root')
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../child', 'module'); git('add', '.'); commit('submodule')
  const module = join(workspace, 'module'), moduleGit = (...args) => execFileSync('git', ['-C', module, ...args], { encoding: 'utf8', env: { ...process.env, ...gitEnv } }).trim()
  moduleGit('config', 'user.name', 'Code Fixture'); moduleGit('config', 'user.email', 'fixture@example.invalid'); await writeFile(join(module, 'child.txt'), 'second'); moduleGit('add', '.'); moduleGit('commit', '-qm', 'child next'); moduleGit('pack-refs', '--all')
  const subStatus = good(await gitCall('status')); assert.equal(subStatus.changes.find(row => row.path === 'module').submodule.worktreeOid, moduleGit('rev-parse', 'HEAD'))
  await writeFile(join(module, 'dirty'), 'untracked'); assert(good(await gitCall('status')).changes.find(row => row.path === 'module').submodule.dirty)
  // The current Source parser ignores porcelain-v2 unmerged records; preserve that observed contract.
  await writeFile(join(workspace, 'conflict.txt'), 'base\n'); git('add', 'conflict.txt'); commit('conflict base'); const branch = git('branch', '--show-current')
  git('checkout', '-qb', 'other'); await writeFile(join(workspace, 'conflict.txt'), 'other\n'); git('add', 'conflict.txt'); commit('other')
  git('checkout', '-q', branch); await writeFile(join(workspace, 'conflict.txt'), 'current\n'); git('add', 'conflict.txt'); commit('current')
  assert.throws(() => git('merge', 'other')); assert(!good(await gitCall('status')).changes.some(row => row.path === 'conflict.txt')); git('merge', '--abort')
  // Commit details reject the existing 5000-file cap after reading the actual immutable diff.
  const many = join(workspace, 'many'); await mkdir(many); for (let i = 0; i < 5001; i++) await writeFile(join(many, String(i)), '')
  git('add', 'many'); commit('file limit'); await gitCall('commit', { id: git('rev-parse', 'HEAD') })
  assert(!await exists(join(cwd, 'agents')), 'Code services must not manufacture an Agent root')
  return rows
}
try {
  const source = await launch('source', true), cli = await launch('cli')
  assert.deepEqual(registrations.get('cli').capabilities.services, { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1 })
  assert.equal(registrations.get('source').capabilities.services['vscode-fs'], 1); assert.equal(registrations.get('source').capabilities.services['vscode-git'], 2)
  const expectedBoundary = await gitContentBoundary(source), actualBoundary = await gitContentBoundary(cli)
  console.log(JSON.stringify({ gitContentBoundary: { source: expectedBoundary, cli: actualBoundary } }))
  assert.deepEqual(expectedBoundary, [
    { contentBase64: Buffer.from('committed literal\n').toString('base64') },
    { contentBase64: Buffer.from('committed literal\n').toString('base64') },
    { code: 'InvalidPath', statusCode: 400 },
    { code: 'InvalidCommit', statusCode: 422 },
    { code: 'InvalidPath', statusCode: 400 },
    { code: 'InvalidPath', statusCode: 400 },
    { code: 'Unknown', statusCode: 500 },
    { contentBase64: '' }, { contentBase64: '' }, { contentBase64: '' },
    { contentBase64: Buffer.from('working\n').toString('base64') },
    { contentBase64: Buffer.from('base\n').toString('base64') },
    { code: 'NoPermissions', statusCode: 403 },
  ])
  assert.deepEqual(actualBoundary, expectedBoundary)
  if (process.argv.includes('--git-content-only')) {
    console.log('PASS 13 actual Source/CLI Git content boundary and filesystem permission controls')
  } else {
    const expected = await corpus(source), actual = await corpus(cli)
    assert.deepEqual(actual, expected);
    const sameFile = join(cli.cwd, 'exact-stat'); await writeFile(sameFile, 'stat'); await chmod(sameFile, 0o444)
    const sourceStat = good(await request(source, 'vscode-fs', 'stat', { path: sameFile })), cliStat = good(await request(cli, 'vscode-fs', 'stat', { path: sameFile }))
    for (const field of ['type', 'size', 'permissions']) assert.equal(cliStat[field], sourceStat[field]); for (const field of ['ctime', 'mtime']) assert(Math.abs(cliStat[field] - sourceStat[field]) < 0.002)
    await chmod(sameFile, 0o644); console.log(JSON.stringify({ serviceParityRows: actual.length, fiftyMiBAndGitLimits: true, linksFlagsAndPartialRename: true }))
    // One-way commands preserve the fixed framing and emit only a correlated service error event.
    cli.socket.send(JSON.stringify({ type: 'node_service_command', service: 'vscode-fs', operation: 'stat', args: { path: 'relative', terminalId: 'echo-only' } }))
    const event = await until(() => frames.find(row => row.id === 'cli' && row.value.type === 'node_service_event')?.value, 'command error event')
    assert.equal(event.service, 'vscode-fs'); assert.equal(event.event.operation, 'stat'); assert.equal(event.event.terminalId, 'echo-only'); assert.equal(event.event.error.code, 'InvalidPath')
    // A blocked service effect completes once; a replacement connection never receives its old reply.
    if (process.platform === 'linux') {
      const fifo = join(cli.cwd, 'blocked'); execFileSync('mkfifo', [fifo]); const old = cli.socket, before = generations.get('cli')
      old.send(JSON.stringify({ type: 'node_service_request', requestId: 'old-code-effect', service: 'vscode-fs', operation: 'write-file', args: { path: fifo, overwrite: true, contentBase64: 'b25jZQ==' } }))
      await sleep(200); old.terminate(); await until(() => generations.get('cli') > before, 'service replacement connection', 12000)
      assert.equal(await readFile(fifo, 'utf8'), 'once'); await sleep(200); assert(!frames.some(row => row.value.requestId === 'old-code-effect')); cli.socket = connected.get('cli')
    }
    // Missing optional Git is the actual executable error, not a shell fallback.
    const noGit = await launch('no-git', false, { PATH: '/definitely-no-git' })
    const missing = await request(noGit, 'vscode-git', 'status', { workspace: noGit.cwd }); assert.equal(missing.error.code, 'GitError'); assert.equal(missing.error.statusCode, 422)
    assert.deepEqual(good(await request(noGit, 'vscode-git', 'content', { workspace: noGit.cwd, path: 'missing', side: 'base' })), { contentBase64: '' })
    console.log('PASS actual Source/CLI fixed service boundary, limits/effects, command framing, original connection and optional Git')
  }
} catch (error) { console.error(clients.map(client => client.id + ': ' + client.output).join('\n')); throw error }
finally {
  for (const client of clients) await stop(client)
  for (const socket of sockets) socket.terminate()
  peer.close(); await new Promise(done => http.close(done))
}
