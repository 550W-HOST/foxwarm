import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { installation } from './test-installation-fixture.mjs'

const execFileAsync = promisify(execFile)

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
})
