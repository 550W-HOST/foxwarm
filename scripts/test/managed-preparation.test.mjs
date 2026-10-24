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

const execFileAsync = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const unix = { skip: process.platform === 'win32' && 'Unix executable fixture' }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-managed-preparation-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'), journal = path.join(root, 'calls.jsonl')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'dotnet'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const args = process.argv.slice(2), root = ${JSON.stringify(root)};
fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify({args, proxy:process.env.HTTPS_PROXY, data:process.env.FOXWARM_DATA_DIR}) + '\\n');
if (args[0] === 'restore') {
  assert.equal(process.env.HTTPS_PROXY, 'http://toolchain-proxy.invalid:8123');
  if (process.env.FIXTURE_RESTORE_FAIL) process.exit(19);
  fs.writeFileSync(path.join(root, 'prepared'), 'dependencies acquired');
} else {
  assert.equal(args[0], 'test');
  assert(args.includes('--no-restore'));
  assert.equal(fs.readFileSync(path.join(root, 'prepared'), 'utf8'), 'dependencies acquired');
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:9');
  assert.equal(process.env.ALL_PROXY, 'http://127.0.0.1:9');
  assert.equal(process.env.OPENAI_API_KEY, '');
  assert.equal(process.env.CONFIG_PATH, '');
  assert(process.env.FOXWARM_DATA_DIR.startsWith(path.join(root, 'artifacts') + path.sep));
  console.log('Passed! - Failed: 0, Passed: 1, Skipped: 0, Total: 1, Duration: 1 ms - Fixture.Tests.dll (net10.0)');
}
`, { mode: 0o755 })
  async function run(fail = false) {
    try {
      const result = await execFileAsync(process.execPath, ['scripts/test/run-tests.mjs', 'managed'], {
        cwd: repo, timeout: 20_000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NODE_OPTIONS: '',
          FOXWARM_TEST_ARTIFACT_DIR: path.join(root, 'artifacts'), FIXTURE_RESTORE_FAIL: fail ? '1' : '',
          HTTPS_PROXY: 'http://toolchain-proxy.invalid:8123', HTTP_PROXY: 'http://toolchain-proxy.invalid:8123',
          OPENAI_API_KEY: 'synthetic-must-not-reach-test', CONFIG_PATH: path.join(root, 'unused-config.yaml') },
      })
      return { code: 0, ...result }
    } catch (error) { return error }
  }
  return { run, async calls() { return (await fs.readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse) } }
}

test('managed dependency preparation uses the caller toolchain before isolated no-restore execution', unix, async t => {
  const f = await fixture(t)
  const result = await f.run()
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const calls = await f.calls()
  assert.deepEqual(calls.map(call => call.args[0]), ['restore', 'test'])
  assert.equal(calls[0].args[1], 'dotnet/Foxwarm.sln')
  assert.equal(calls[1].args[1], 'dotnet/Foxwarm.sln')
})

test('a failed managed dependency preparation does not start managed tests', unix, async t => {
  const f = await fixture(t)
  assert.equal((await f.run(true)).code, 1)
  assert.deepEqual((await f.calls()).map(call => call.args[0]), ['restore'])
})
