import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function installation(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-install-canary-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Copy code, not installation data. Real module-relative path resolution now
  // points at this synthetic installation, including the data_dir fallback.
  for (const dir of ['lib', 'scripts', 'templates', 'packages/shared/dist']) {
    await fs.cp(path.join(repo, dir), path.join(root, dir), { recursive: true })
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const canaries = new Map()
  for (const dir of [root, path.join(root, 'pointer-data'), path.join(root, 'inherited-data')]) {
    for (const name of ['config.yaml', 'models.yaml']) {
      const file = path.join(dir, 'state', name)
      const text = `synthetic-installation-canary: ${name}\nproviders: invalid-do-not-consume\n`
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
      canaries.set(file, text)
    }
  }
  await fs.writeFile(path.join(root, 'data_dir'), 'pointer-data\n')
  const env = { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined, FOXWARM_TEST_RUN_ROOT: '', FOXWARM_TEST_PROCESS_ROOT: '',
    FOXWARM_DATA_DIR: path.join(root, 'inherited-data'),
    FOXWARM_CONFIG_PATH: path.join(root, 'state/config.yaml'), CONFIG_PATH: path.join(root, 'pointer-data/state/config.yaml'),
    MCP_CONFIG_PATH: path.join(root, 'state/config.yaml'), FOXWARM_AGENT_DIR: path.join(root, 'installation-agent'),
    FOXWARM_AGENTS_DIR: path.join(root, 'installation-agents') }
  return { root, env, async unchanged() {
    for (const [file, text] of canaries) assert.equal(await fs.readFile(file, 'utf8'), text, file)
    for (const dir of [root, path.join(root, 'pointer-data'), path.join(root, 'inherited-data')]) {
      assert.deepEqual((await fs.readdir(path.join(dir, 'state'), { recursive: true })).sort(), ['config.yaml', 'models.yaml'],
        'tests must not create logs or other state in a supplied installation')
    }
  } }
}

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
    require('./lib/testEnvironment');
    require('./lib/channels/webuiChannel');
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

test('direct backend tests isolate inherited and module-relative installation configuration before imports', { timeout: 180_000 }, async t => {
  const fixture = await installation(t)
  // Run the actual formerly unsafe writers, including the former backup/restore
  // tests. No repository runner or preload is involved in these entry points.
  const directSelection = await execFileAsync(process.execPath,
    ['--test', '--test-reporter=tap', 'lib/channels/webuiAccess.test.js', 'lib/configHotApply.test.js'], {
      cwd: fixture.root, env: fixture.env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    })
  assert.match(directSelection.stdout, /# fail 0/)
  assert.match(directSelection.stdout, /# tests [1-9]/)
  t.diagnostic(`Two-file direct invocation:\n${directSelection.stdout}${directSelection.stderr}`)
  await fixture.unchanged()
  const files = ['lib/channels/webuiSetup.test.js', 'lib/configSectionSaves.test.js',
    'lib/session/channels.test.js', 'lib/sessionEffectiveSelection.test.js']
  const result = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=2', ...files], {
    cwd: fixture.root, env: fixture.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  assert.match(result.stdout, /# fail 0/);
  assert.match(result.stdout, /# tests [1-9]/);
  // node <file> is also supported.
  await execFileAsync(process.execPath, ['lib/channels/webuiSetup.test.js'], {
    cwd: fixture.root, env: { ...fixture.env, FOXWARM_CONFIG_PATH: '' }, timeout: 30_000,
  })
  await fixture.unchanged()
  // The normal runner preload must also discard caller installation overrides.
  await execFileAsync(process.execPath, ['--test', 'lib/channels/webuiSetup.test.js'], {
    cwd: fixture.root, env: { ...fixture.env, FOXWARM_TEST_RUN_ROOT: path.join(fixture.root, 'run'),
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(fixture.root, 'scripts/test/test-process-env.mjs')).href}` }, timeout: 30_000,
  })
  const fallbackEnv = { ...fixture.env, FOXWARM_DATA_DIR: '', FOXWARM_CONFIG_PATH: '', CONFIG_PATH: '', MCP_CONFIG_PATH: '' }
  for (const pointerPresent of [true, false]) {
    if (!pointerPresent) await fs.rm(path.join(fixture.root, 'data_dir'))
    await execFileAsync(process.execPath, ['lib/channels/webuiSetup.test.js'], {
      cwd: fixture.root, env: fallbackEnv, timeout: 30_000,
    })
    await fixture.unchanged()
  }
  // A normal child inherits the owned root; explicit fixture roots must not be
  // replaced by the runner preload when the application starts in a subprocess.
  const probe = `
    require('./lib/testEnvironment');
    const assert = require('node:assert/strict');
    const c = require('./lib/config');
    assert.notEqual(c.DATA_ROOT_DIR, ${JSON.stringify(fixture.env.FOXWARM_DATA_DIR)});
    assert.equal(c.APP_CONFIG_PATH, require('node:path').join(c.DATA_ROOT_DIR, 'state/config.yaml'));
    assert.equal(c.getActiveModelsConfigPath(), require('node:path').join(c.DATA_ROOT_DIR, 'state/models.yaml'));
    assert.equal(c.AGENTS_DIR, require('node:path').join(c.DATA_ROOT_DIR, 'agents'));
    assert.equal(require('./packages/shared/dist/nodeFileTransfer').getNodeAgentDir('probe'), require('node:path').join(c.DATA_ROOT_DIR, 'agents/probe'));
    const child = require('node:child_process').spawnSync(process.execPath, ['-e',
      "const c=require('./lib/config'); console.log(c.DATA_ROOT_DIR)"], {encoding:'utf8'});
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim().split('\\n').at(-1), c.DATA_ROOT_DIR);
    const selected = require('node:path').join(c.DATA_ROOT_DIR, 'selected-child');
    const selectedChild = require('node:child_process').spawnSync(process.execPath, ['-e',
      "const c=require('./lib/config'); console.log(JSON.stringify({data:c.DATA_ROOT_DIR,tmp:require('node:os').tmpdir()}))"], {
      encoding:'utf8', env: { ...process.env, FOXWARM_DATA_DIR: selected,
        FOXWARM_TEST_RUN_ROOT: require('node:path').join(c.DATA_ROOT_DIR, 'child-run'), NODE_TEST_CONTEXT: 'child-v8',
        NODE_OPTIONS: '--import=' + ${JSON.stringify(pathToFileURL(path.join(fixture.root, 'scripts/test/test-process-env.mjs')).href)} },
    });
    assert.equal(selectedChild.status, 0, selectedChild.stderr);
    assert.deepEqual(JSON.parse(selectedChild.stdout.trim().split('\\n').at(-1)),
      { data: selected, tmp: require('node:os').tmpdir() });
  `
  await execFileAsync(process.execPath, ['-e', probe], { cwd: fixture.root, env: fixture.env, timeout: 20_000 })
  await fixture.unchanged()
})

test('Source lifecycle fixture ignores caller configuration under direct race and cold-reopen entries', { timeout: 60_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-lifecycle-canary-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const caller = path.join(root, 'caller')
  await fs.mkdir(caller)
  const configPath = path.join(caller, 'state/config.yaml')
  await fs.mkdir(path.dirname(configPath))
  const mcpPath = path.join(caller, 'mcp.json')
  const callerConfig = JSON.stringify({ sessionWorkers: true, dbWorkers: true,
    paths: { agentsDir: path.join(caller, 'agents') } })
  await fs.writeFile(configPath, callerConfig)
  await fs.writeFile(mcpPath, 'synthetic invalid MCP configuration')
  const env = { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined,
    FOXWARM_TS_ROOT: repo, FOXWARM_DATA_DIR: caller, FOXWARM_CONFIG_PATH: configPath,
    CONFIG_PATH: configPath, MCP_CONFIG_PATH: mcpPath,
    FOXWARM_AGENT_DIR: path.join(caller, 'agent'), FOXWARM_AGENTS_DIR: path.join(caller, 'agents') }
  // The real Source reader selects the owned sibling when not protected by the fixture.
  const control = await execFileAsync(process.execPath, ['-e', `
    const c = require('./lib/config');
    console.log(JSON.stringify({ config: c.APP_CONFIG_PATH, agents: c.AGENTS_DIR,
      sessionWorkers: c.SESSION_WORKERS_ENABLED, dbWorkers: c.DB_WORKERS_ENABLED }));
  `], { cwd: repo, env, timeout: 10_000 })
  assert.deepEqual(JSON.parse(control.stdout.trim().split('\n').at(-1)), {
    config: configPath, agents: path.join(caller, 'agents'), sessionWorkers: true, dbWorkers: true,
  })
  t.diagnostic(`Unprotected Source config control: ${control.stdout.trim()}`)
  // A successful direct entry cannot have consumed this malformed caller YAML.
  const poison = 'synthetic-caller-config: [unterminated\n'
  await fs.writeFile(configPath, poison)
  const raceRoot = path.join(root, 'race')
  const coldRoot = path.join(root, 'cold')
  for (const [mode, dataRoot, preferredOverride] of [
    ['race', raceRoot, configPath], ['seed', coldRoot, ''], ['reopen', coldRoot, configPath],
  ]) {
    const result = await execFileAsync(process.execPath,
      ['dotnet/lifecycle-transition-fixture-ts.mjs', mode, dataRoot], {
        cwd: repo, env: { ...env, FOXWARM_CONFIG_PATH: preferredOverride }, timeout: 15_000,
      })
    const line = result.stdout.split('\n').find(line => line.startsWith('LIFECYCLE_FIXTURE:'))
    assert.ok(line, `${mode}: ${result.stdout}${result.stderr}`)
    const outcome = JSON.parse(line.slice('LIFECYCLE_FIXTURE:'.length))
    if (mode === 'race') assert.equal(outcome.failedForkRemoved, true)
    if (mode === 'reopen') assert.equal(outcome.completed, true)
    t.diagnostic(`${mode}: ${line}`)
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), poison)
  assert.equal(await fs.readFile(mcpPath, 'utf8'), 'synthetic invalid MCP configuration')
  assert.deepEqual((await fs.readdir(caller)).sort(), ['mcp.json', 'state'])
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
