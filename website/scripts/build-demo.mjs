// Builds the static WebUI demo into public/demo so the site serves it at /demo/.
// Website builds run `npm ci && npm run check` in this directory only, so the
// WebUI dependencies are installed here when the checkout does not have them.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webui = resolve(website, '../packages/webui')
const outDir = join(website, 'public/demo')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`)
}

const started = Date.now()
if (!existsSync(join(webui, 'node_modules/.package-lock.json'))) {
  console.log('Installing WebUI dependencies for the demo build')
  run(npm, ['ci', '--no-audit', '--no-fund'], webui)
}
const vite = join(webui, 'node_modules/vite/bin/vite.js')
// The runner loader avoids writing a bundled config into node_modules.
run(process.execPath, [vite, 'build', '--config', 'vite.demo.config.ts', '--configLoader', 'runner', '--logLevel', 'warn'], webui, { FOXWARM_DEMO_OUT_DIR: outDir })
const html = readFileSync(join(outDir, 'index.html'), 'utf8')
if (!html.includes('noindex')) throw new Error('Demo index.html is missing its noindex marker')
console.log(`Built WebUI demo in ${Math.round((Date.now() - started) / 1000)}s`)
