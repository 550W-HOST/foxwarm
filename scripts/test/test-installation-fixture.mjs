import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export async function installation(t) {
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
