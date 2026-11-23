import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'


const execFileAsync = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('direct test processes keep a held upload spool private during concurrent initialization and cleanup', { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-spool-canary-'))
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const env = { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined,
    FOXWARM_TEST_RUN_ROOT: '', FOXWARM_TEST_PROCESS_ROOT: '', FOXWARM_TEST_KEEP_SYSTEM_TMP: '',
    FOXWARM_TEST_TEMP_ROOT: path.join(root, 'short'), FOXWARM_DATA_DIR: path.join(root, 'unused-data'),
    TMPDIR: root, TMP: root, TEMP: root }
  const code = `
    require('./scripts/test/test-process-env.cjs').initializeTestEnvironment();
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const spool = path.join(os.tmpdir(), 'foxwarm-uploads');
    fs.mkdirSync(spool, { recursive: true });
    if (process.argv[1] === 'owner') fs.writeFileSync(path.join(spool, 'held-upload'), 'owned pending upload');
    process.on('message', () => process.exit(0));
    process.send({ spool, files: fs.readdirSync(spool), processRoot: process.env.FOXWARM_TEST_PROCESS_ROOT });
  `
  async function start(role) {
    const child = spawn(process.execPath, ['-e', code, role], { cwd: repo, env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    children.push(child)
    const [ready] = await once(child, 'message')
    return { child, ...ready }
  }
  const owner = await start('owner')
  const peer = await start('peer')
  // IPC keeps the owner alive with its file present throughout the peer's import.
  assert.deepEqual(owner.files, ['held-upload'])
  assert.deepEqual(peer.files, [], 'A concurrent test must not observe another process\'s pending upload')
  assert.notEqual(peer.spool, owner.spool)
  assert.notEqual(peer.processRoot, owner.processRoot)
  const peerExit = once(peer.child, 'exit')
  peer.child.send('stop')
  assert.deepEqual(await peerExit, [0, null])
  assert.equal(await fs.readFile(path.join(owner.spool, 'held-upload'), 'utf8'), 'owned pending upload')
  await assert.rejects(fs.stat(peer.processRoot), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.dirname(peer.spool)), { code: 'ENOENT' })
  const ownerExit = once(owner.child, 'exit')
  owner.child.send('stop')
  assert.deepEqual(await ownerExit, [0, null])
})

test('runtime browser files refuse raw invocation even when a URL and installation token are supplied', { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-e2e-canary-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tokenFile = path.join(root, 'token')
  await fs.writeFile(tokenFile, 'synthetic-do-not-read')
  let requests = 0
  const server = http.createServer((_request, response) => { requests++; response.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { appRuntimeE2e } = await import('./test-inventory.mjs')
  for (const file of appRuntimeE2e) {
    await assert.rejects(execFileAsync(process.execPath, ['--test', file], {
      cwd: repo, env: { ...process.env, NODE_TEST_CONTEXT: undefined, FOXWARM_APP_E2E_OWNED: '', FOXWARM_E2E_DATA_DIR: '',
        FOXWARM_E2E_URL: `http://127.0.0.1:${server.address().port}`, FOXWARM_E2E_TOKEN_FILE: tokenFile },
      timeout: 5000,
    }), error => error.code === 1 && /requires an owned disposable application/.test(error.stdout + error.stderr))
  }
  assert.equal(requests, 0)
  assert.equal(await fs.readFile(tokenFile, 'utf8'), 'synthetic-do-not-read')
})
