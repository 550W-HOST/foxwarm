import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../../..', import.meta.url))

// These real browser entries load the backend in-process and in an ordinary
// OAuth child respectively. Exercise direct invocation without the batch preload.
for (const file of ['orderedResponsesDraft.e2e.mjs', 'authorizations.e2e.mjs']) {
  test(`${file} owns direct-entry backend state, including its children`, { timeout: 180_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-browser-install-canary-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    for (const validConfig of [false, true]) {
      const installation = path.join(root, validConfig ? 'valid-config' : 'invalid-config')
      const state = path.join(installation, 'state')
      await fs.mkdir(state, { recursive: true })
      const canaries = {
        'config.yaml': validConfig ? 'bot:\n  name: installation-canary\nvector: false\ndbWorkers: false\n' : 'bot: [\n',
        'models.yaml': 'default: synthetic/model\nproviders:\n  synthetic:\n    providerType: openai-completions\n    baseUrl: http://127.0.0.1:9/v1\n    models: [model]\n',
        'mcp.json': '{}\n',
      }
      for (const [name, text] of Object.entries(canaries)) await fs.writeFile(path.join(state, name), text)
      const before = (await fs.readdir(installation, { recursive: true })).sort()
      const { stdout } = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', `packages/webui/test/${file}`], {
        cwd: repo,
        env: {
          ...process.env,
          NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined,
          FOXWARM_TEST_RUN_ROOT: '', FOXWARM_TEST_PROCESS_ROOT: '', FOXWARM_TEST_TEMP_ROOT: '',
          FOXWARM_E2E_BROWSER: 'chromium',
          FOXWARM_DATA_DIR: installation,
          MCP_CONFIG_PATH: path.join(state, 'mcp.json'),
          FOXWARM_AGENT_DIR: path.join(installation, 'agent'), FOXWARM_AGENTS_DIR: path.join(installation, 'agents'),
        },
        timeout: 80_000, maxBuffer: 2 * 1024 * 1024,
      }).catch(error => {
        t.diagnostic(`${error.stdout || ''}${error.stderr || ''}`)
        throw error
      })
      assert.match(stdout, /^# pass 1$/m, 'the actual browser scenario must run rather than skip')
      assert.match(stdout, /^# skipped 0$/m)
      for (const [name, text] of Object.entries(canaries)) assert.equal(await fs.readFile(path.join(state, name), 'utf8'), text)
      assert.deepEqual((await fs.readdir(installation, { recursive: true })).sort(), before,
        'a passing direct invocation must not create installation logs or other files')
    }
  })
}
