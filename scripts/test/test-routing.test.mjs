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
async function fixture(t) {
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
    ['packages/webui/test/example.e2e.mjs', 'webui-browser'],
    ['packages/webui/test/publishedCore.e2e.mjs', 'published-app'],
    ['test/app-e2e/run-app-e2e.mjs', 'app-browser'],
    ['lib/selftest/queueDrainSelfTest.js', 'queue-selftest'],
    ['lib/selftest/toolLoopStallSelfTest.js', 'loop-selftest'],
  ]) {
    // mjs fixtures use createRequire solely to reuse the tiny CJS test program.
    await write(file, (file.endsWith('.mjs') ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" : '') + program(label))
  }
  await write('scripts/test/prepare-browser.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify('browser-prepare') + '\\n');\n`)
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
    root,
    async run(target, managedFail = false) {
      try {
        const result = await execute(process.execPath, ['scripts/test/run-tests.mjs', target], {
          cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined, FOXWARM_TEST_RUN_ROOT: '',
            FOXWARM_TEST_ARTIFACT_DIR: path.join(root, 'artifacts'),
            FOXWARM_E2E_CHROMIUM: path.join(root, 'chromium'),
            PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
            OPENAI_API_KEY: 'synthetic-caller-key', CONFIG_PATH: path.join(root, 'caller.yaml'),
            FIXTURE_MANAGED_FAIL: managedFail ? '1' : '' },
        })
        return { code: 0, ...result }
      } catch (error) { return error }
    },
    async calls() { return (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse) },
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
