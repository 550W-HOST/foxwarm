import testEnvironment from './test-process-env.cjs'
testEnvironment.initializeTestEnvironment()

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const unix = { skip: process.platform === 'win32' && 'Unix executable fixture' }

// Exercise the real CLI and inventory against a small tracked checkout. Test
// programs record which component ran; no production application is started.
async function fixture(t, { pendingPreparation = false, browsers = ['example.e2e.mjs'], timer = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-test-routing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const journal = path.join(root, 'calls.jsonl')
  async function write(file, content) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  for (const file of ['run-tests.mjs', 'test-inventory.mjs', 'test-result-counts.mjs', 'test-process-env.mjs', 'test-process-env.cjs']) {
    await write(`scripts/test/${file}`, await fs.readFile(path.join(repo, 'scripts/test', file)))
  }
  function program(label, title = label) {
    return `const fs = require('node:fs'), assert = require('node:assert/strict');
require('node:test')(${JSON.stringify(title)}, () => {
  assert.equal(process.env.OPENAI_API_KEY, '');
  assert.equal(process.env.CONFIG_PATH, '');
  assert(process.env.FOXWARM_DATA_DIR.includes('artifacts'));
  fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(${JSON.stringify(label)}) + '\\n');
});\n`
  }
  const sources = {
    'src/nodes/runSh.test.ts': ['lib/nodes/runSh.test.js', 'node-bootstrap'],
    'src/artifacts/runtimeHelpers.test.ts': ['lib/artifacts/runtimeHelpers.test.js', 'runtime-helpers'],
    'src/legacy.test.ts': ['lib/legacy.test.js', 'reference-backend'],
    'src/vector.indexFailure.test.ts': ['lib/vector.indexFailure.test.js', 'reference-vector'],
    'packages/shared/src/example.test.ts': ['packages/shared/dist/example.test.js', 'shared'],
    'packages/cli-node/src/example.test.ts': ['packages/cli-node/dist/example.test.js', 'cli-node'],
  }
  for (const [source, [compiled, label]] of Object.entries(sources)) {
    await write(source, '// tracked source fixture\n')
    await write(compiled, program(label))
  }
  for (const [file, label] of [
    ['packages/browser-node/test/example.test.mjs', 'browser-node'],
    ['scripts/example.test.js', 'scripts'],
    ['scripts/test/reference-isolation.test.mjs', 'reference-isolation'],
    ['skills/example/example.test.js', 'skill-node'],
    ['packages/webui/test/example.test.mjs', 'webui-unit'],
    ...browsers.map(name => [`packages/webui/test/${name}`, name === 'example.e2e.mjs' ? 'webui-browser' : name]),
    ['packages/webui/test/publishedCore.e2e.mjs', 'published-app'],
    ['test/app-e2e/run-app-e2e.mjs', 'app-browser'],
    ['lib/selftest/queueDrainSelfTest.js', 'queue-selftest'],
    ['lib/selftest/toolLoopStallSelfTest.js', 'loop-selftest'],
  ]) {
    // mjs fixtures use createRequire solely to reuse the tiny CJS test program.
    await write(file, (file.endsWith('.mjs') ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" : '') + program(label))
  }
  await write('scripts/test/prepare-browser.mjs', `
import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.env.HTTPS_PROXY, 'http://toolchain-proxy.invalid:8123');
assert.equal(process.env.OPENAI_API_KEY, 'synthetic-caller-key');
assert.equal(process.env.CONFIG_PATH, ${JSON.stringify(path.join(root, 'caller.yaml'))});
const record = label => fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(label) + '\\n');
record('browser-prepare');
if (${pendingPreparation}) {
  process.on('SIGTERM', () => { record('browser-stopped-with-zero'); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  record('browser-ready');
}
`)
  if (pendingPreparation) {
    // Reach the real preparation timeout without waiting for the full build budget.
    await write('timer.cjs', `const original = global.setTimeout;
global.setTimeout = (callback, delay, ...args) => original(callback, delay === 900_000 ? 1000 : delay, ...args);
`)
  }

  if (timer) await write('timer.cjs', timer)

  await write('scripts/multicaBridge.test.js', program('published-bin', 'public package bin fixture'))
  await write('packages/vscode-web/test/example.test.mjs', '// owned by the npm group\n')
  await write('dotnet/Foxwarm.Tests/Example.cs', '// owned by dotnet test\n')
  await write('skills/example/tests/test_example.py', `import json\nwith open(${JSON.stringify(journal)}, 'a') as f: f.write(json.dumps('python') + '\\n')\n`)
  for (const name of ['dotnet', 'npm']) {
    await write(`bin/${name}`, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(${JSON.stringify(name)} + ':' + args.join(' ')) + '\\n');
if (${JSON.stringify(name)} === 'dotnet' && args[0] === 'test' && process.env.FIXTURE_MANAGED_FAIL === '1') process.exit(23);
`)
    await fs.chmod(path.join(root, 'bin', name), 0o755)
  }
  await write('chromium', 'fixture executable path only\n')
  await execute('git', ['init', '-q'], { cwd: root })
  // Keep compiled artifacts outside discovery, like the real checkout.
  await execute('git', ['add', 'src', 'scripts', 'packages', 'skills', 'dotnet', 'test'], { cwd: root })
  await execute('git', ['rm', '-q', '--cached', '-r', 'packages/shared/dist', 'packages/cli-node/dist'], { cwd: root })
  return {
    root, journal, write,
    async run(target, managedFail = false, args = []) {
      try {
        const result = await execute(process.execPath, ['scripts/test/run-tests.mjs', target, ...args], {
          cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: pendingPreparation || timer ? `--require=${path.join(root, 'timer.cjs')}` : '', NODE_TEST_CONTEXT: undefined, FOXWARM_TEST_RUN_ROOT: '',
            FOXWARM_TEST_ARTIFACT_DIR: path.join(root, 'artifacts'),
            FOXWARM_E2E_CHROMIUM: path.join(root, 'chromium'),
            PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
            HTTPS_PROXY: 'http://toolchain-proxy.invalid:8123',
            OPENAI_API_KEY: 'synthetic-caller-key', CONFIG_PATH: path.join(root, 'caller.yaml'),
            FIXTURE_MANAGED_FAIL: managedFail ? '1' : '' },
        })
        return { code: 0, ...result }
      } catch (error) { return error }
    },
    async calls() { return (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse) },
    async inventory() {
      const [run] = await fs.readdir(path.join(root, 'artifacts'))
      return JSON.parse(await fs.readFile(path.join(root, 'artifacts', run, 'inventory.json'), 'utf8'))
    },
    async summary() {
      const [run] = await fs.readdir(path.join(root, 'artifacts'))
      return JSON.parse(await fs.readFile(path.join(root, 'artifacts', run, 'summary.json'), 'utf8'))
    },
  }
}

for (const target of ['unit', 'all']) {
  test(`${target} executes maintained components without requiring retired Main artifacts`, unix, async t => {
    const f = await fixture(t)
    for (const file of ['lib/legacy.test.js', 'lib/vector.indexFailure.test.js', 'lib/selftest']) {
      await fs.rm(path.join(f.root, file), { recursive: true, force: true })
    }
    const result = await f.run(target)
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const calls = await f.calls()
    t.diagnostic(`${target} child execution: ${calls.join(', ')}`)
    for (const component of ['node-bootstrap', 'runtime-helpers', 'shared', 'cli-node', 'browser-node', 'scripts', 'skill-node', 'webui-unit', 'python']) {
      assert.ok(calls.includes(component), component)
    }
    assert.ok(calls.some(call => call.startsWith('dotnet:test ')))
    assert.ok(calls.some(call => call.startsWith('npm:--prefix packages/vscode-web test')))
    assert.equal(calls.some(call => /reference|selftest/.test(call)), false)
    if (target === 'all') {
      for (const component of ['published-bin', 'published-app', 'browser-prepare', 'webui-browser', 'app-browser']) assert.ok(calls.includes(component), component)
    }
  })
}

test('reference runs only retired Main, nested isolation and both selftests without maintained builds', unix, async t => {
  const f = await fixture(t)
  await fs.rm(path.join(f.root, 'lib/nodes'), { recursive: true })
  await fs.rm(path.join(f.root, 'lib/artifacts'), { recursive: true })
  await fs.rm(path.join(f.root, 'packages/shared/dist'), { recursive: true })
  const result = await f.run('reference')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const calls = await f.calls()
  t.diagnostic(`reference child execution: ${calls.join(', ')}`)
  assert.deepEqual(calls.sort(), ['reference-backend', 'reference-vector', 'reference-isolation', 'queue-selftest', 'loop-selftest'].sort())
})

test('default unit routing still propagates managed failures', unix, async t => {
  const f = await fixture(t)
  const result = await f.run('unit', true)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  const calls = await f.calls()
  assert.ok(calls.some(call => call.startsWith('dotnet:test ')))
  assert.ok(calls.includes('runtime-helpers'))
  assert.equal(calls.some(call => /reference|selftest/.test(call)), false)
})

test('browser preparation completes before isolated fixtures start', unix, async t => {
  const f = await fixture(t)
  const result = await f.run('browser')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.deepEqual(await f.calls(), ['browser-prepare', 'browser-ready', 'webui-browser'])
  const summary = await f.summary()
  assert.deepEqual(summary.map(step => step.step), ['prepare', 'example.e2e.mjs'])
  assert.equal(summary[0].timedOut, false)
})

test('browser preparation deadline fences fixtures even when the terminated producer exits zero', unix, async t => {
  const f = await fixture(t, { pendingPreparation: true })
  const result = await f.run('browser')
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.deepEqual(await f.calls(), ['browser-prepare', 'browser-stopped-with-zero'])
  const summary = await f.summary()
  assert.equal(summary.length, 1)
  assert.equal(summary[0].step, 'prepare')
  assert.equal(summary[0].timedOut, true)
  assert.equal(summary[0].code, 1)
})

test('browser shards are disjoint, complete and ordered, while the unsharded command keeps every file', unix, async t => {
  const files = ['setupModels.e2e.mjs', ...Array.from({ length: 16 }, (_, index) => `case-${String(index).padStart(2, '0')}.e2e.mjs`)].sort()
  const selected = []
  for (let index = 1; index <= 8; index++) {
    const f = await fixture(t, { browsers: files })
    const result = await f.run('browser', false, [`--shard=${index}/8`, '--workers=2'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const expected = files.filter((_, position) => position % 8 === index - 1)
    const selection = (await f.inventory()).browserSelection
    assert.deepEqual(selection, { shard: { index, total: 8 }, workers: 2, files: expected.map(file => `packages/webui/test/${file}`) })
    const calls = await f.calls()
    assert.deepEqual(calls.slice(0, 2), ['browser-prepare', 'browser-ready'])
    assert.deepEqual(calls.slice(2).sort(), expected)
    assert.deepEqual((await f.summary()).map(step => step.step), ['prepare', ...expected])
    selected.push(...expected)
  }
  assert.deepEqual(selected.sort(), files)
  const f = await fixture(t, { browsers: files })
  const result = await f.run('browser')
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.deepEqual(await f.calls(), ['browser-prepare', 'browser-ready', ...files])
  assert.equal((await f.inventory()).browserSelection.shard, null)
})

test('browser options reject malformed or misplaced selections before creating artifacts or starting children', unix, async t => {
  const f = await fixture(t)
  for (const [target, args] of [
    ['browser', ['--shard=0/8']], ['browser', ['--shard=9/8']], ['browser', ['--shard=1/0']],
    ['browser', ['--shard=1.5/8']], ['browser', ['--shard=1/9007199254740992']],
    ['browser', ['--shard=1/8', '--shard=2/8']], ['browser', ['--workers=0']],
    ['browser', ['--workers=-1']], ['browser', ['--workers=2', '--workers=2']],
    ['browser', ['--unknown=1']], ['unit', ['--shard=1/8']], ['all', ['--workers=2']],
  ]) {
    const result = await f.run(target, false, args)
    assert.equal(result.code, 2, `${target} ${args}: ${result.stdout}${result.stderr}`)
  }
  await assert.rejects(fs.access(path.join(f.root, 'artifacts')), { code: 'ENOENT' })
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' })
})

test('browser workers stay bounded, retain sibling results and drain around a shared-output writer', unix, async t => {
  const files = ['a.e2e.mjs', 'b.e2e.mjs', 'c.e2e.mjs', 'setupModels.e2e.mjs', 'z.e2e.mjs']
  const f = await fixture(t, { browsers: files })
  const events = path.join(f.root, 'events.jsonl')
  for (const file of files) {
    const peer = file === 'a.e2e.mjs' ? 'b.e2e.mjs' : file === 'b.e2e.mjs' ? 'a.e2e.mjs' : null
    await f.write(`packages/webui/test/${file}`, `
import fs from 'node:fs'; import assert from 'node:assert/strict';
const name = ${JSON.stringify(file)}, events = ${JSON.stringify(events)}, root = ${JSON.stringify(f.root)};
const mark = event => fs.appendFileSync(events, JSON.stringify({name, event, data: process.env.FOXWARM_DATA_DIR, screenshots: process.env.FOXWARM_E2E_SCREENSHOT_DIR}) + '\\n');
mark('start'); console.log('OUTPUT:' + name);
fs.writeFileSync(process.env.FOXWARM_E2E_SCREENSHOT_DIR + '/same-name.png', name);
const peer = ${JSON.stringify(peer)};
if (peer) {
  const end = Date.now() + 4000;
  while (!fs.readFileSync(events, 'utf8').includes('"name":"' + peer + '"')) {
    assert(Date.now() < end, 'the second worker must start before the first finishes');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
mark('end');
if (name === 'c.e2e.mjs') process.exit(7);
`)
  }
  const result = await f.run('browser', false, ['--workers=2'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  const rows = (await fs.readFile(events, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.slice(0, 2).map(row => row.event), ['start', 'start'])
  const active = new Set()
  for (const row of rows) {
    if (row.event === 'start') {
      if (row.name === 'setupModels.e2e.mjs') assert.equal(active.size, 0)
      active.add(row.name)
      assert(active.size <= 2)
    } else active.delete(row.name)
  }
  const summary = await f.summary()
  assert.notEqual(summary.find(step => step.step === 'c.e2e.mjs').code, 0)
  assert(summary.filter(step => step.step !== 'c.e2e.mjs').every(step => step.code === 0))
  assert.deepEqual(rows.slice(6).map(row => [row.name, row.event]), [
    ['setupModels.e2e.mjs', 'start'], ['setupModels.e2e.mjs', 'end'], ['z.e2e.mjs', 'start'], ['z.e2e.mjs', 'end'],
  ])
  const starts = rows.filter(row => row.event === 'start')
  assert.equal(new Set(starts.map(row => row.data)).size, files.length)
  assert.equal(new Set(starts.map(row => row.screenshots)).size, files.length)
  const [run] = await fs.readdir(path.join(f.root, 'artifacts'))
  for (const row of starts) {
    assert.equal(await fs.readFile(path.join(row.screenshots, 'same-name.png'), 'utf8'), row.name)
    const log = await fs.readFile(path.join(f.root, 'artifacts', run, 'logs', 'webui-browser', row.name + '.log'), 'utf8')
    assert(log.includes('OUTPUT:' + row.name))
    for (const other of files.filter(file => file !== row.name)) assert(!log.includes('OUTPUT:' + other))
  }
})

for (const interrupted of [false, true]) {
  test(`browser ${interrupted ? 'interruption stops both active workers and queued files' : 'file deadline fails even with zero-exit termination handlers'}`, unix, async t => {
    const timer = `const original = global.setTimeout;
global.setTimeout = (callback, delay, ...args) => original(delay === 240_000 && ${interrupted} ? () => process.kill(process.pid, 'SIGTERM') : callback, delay === 240_000 ? 1000 : delay, ...args);
`
    const files = ['a.e2e.mjs', 'b.e2e.mjs', 'queued.e2e.mjs']
    const f = await fixture(t, { browsers: files, timer })
    for (const file of files.slice(0, 2)) await f.write(`packages/webui/test/${file}`, `
import fs from 'node:fs';
const journal = ${JSON.stringify(f.journal)}, name = ${JSON.stringify(file)};
fs.appendFileSync(journal, JSON.stringify('started:' + name) + '\\n');
process.on('SIGTERM', () => { fs.appendFileSync(journal, JSON.stringify('stopped:' + name) + '\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`)
    const result = await f.run('browser', false, ['--workers=2'])
    assert.equal(result.code, 1, result.stdout + result.stderr)
    const calls = await f.calls(), summary = await f.summary()
    for (const file of files.slice(0, 2)) {
      assert(calls.includes('started:' + file))
      assert(calls.includes('stopped:' + file))
      const step = summary.find(step => step.step === file)
      assert.equal(step.code, 1)
      assert.equal(step.timedOut, !interrupted)
      assert.equal(step.interrupted, interrupted)
    }
    assert.equal(calls.includes('queued.e2e.mjs'), !interrupted)
  })
}

test('sharded browser preparation failure fences the entire worker pool', unix, async t => {
  const f = await fixture(t, { pendingPreparation: true, browsers: ['a.e2e.mjs', 'b.e2e.mjs', 'c.e2e.mjs'] })
  const result = await f.run('browser', false, ['--shard=1/2', '--workers=2'])
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.deepEqual(await f.calls(), ['browser-prepare', 'browser-stopped-with-zero'])
  assert.deepEqual((await f.summary()).map(step => step.step), ['prepare'])
})
