#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const assets = path.join(root, 'packages/vscode-web/assets')
const required = [
  'vscode-web/out/nls.messages.js',
  'vscode-web/out/vs/workbench/workbench.web.main.internal.css',
  'vscode-web/out/vs/workbench/workbench.web.main.internal.js',
]

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Browser fixture preparation failed: ${command} (${result.signal || result.status}).`)
}

async function missingAssets() {
  const missing = []
  for (const file of required) {
    try { await fs.access(path.join(assets, file)) }
    catch { missing.push(file) }
  }
  return missing
}

try {
  if ((await missingAssets()).length) {
    console.log('Preparing the optional Code workbench with npm run build:code.')
    run('npm', ['run', 'build:code'])
  }
  const missing = await missingAssets()
  if (missing.length) throw new Error(`Code preparation did not produce required browser assets:\n${missing.join('\n')}`)
  for (const project of ['Foxwarm', 'Foxwarm.CliNode', 'Foxwarm.DevTools']) {
    const args = ['build', `dotnet/${project}/${project}.csproj`, '-c', 'Debug']
    if (project === 'Foxwarm') args.push('-p:FoxwarmDelivery=true')
    run('dotnet', args)
  }
  // Optional workbench assets are installed separately from ordinary managed delivery.
  const installed = path.join(root, 'dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets')
  await fs.rm(installed, { recursive: true, force: true })
  await fs.cp(assets, installed, { recursive: true })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
