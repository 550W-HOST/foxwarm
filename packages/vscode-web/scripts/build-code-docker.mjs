#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(packageRoot, '../..')
const builderImage = 'foxwarm-code-oss-builder:node-24.17.0'
const dockerfile = path.join(packageRoot, 'Dockerfile.code-oss')

function works(command, prefixArgs = []) {
  const result = spawnSync(command, [...prefixArgs, 'docker', 'version'], { stdio: 'ignore' })
  return result.status === 0
}

function resolveDockerCommand() {
  const direct = spawnSync('docker', ['version'], { stdio: 'ignore' })
  if (direct.status === 0) return { command: 'docker', dockerArgs: [] }
  if (works('sudo', ['-n'])) return { command: 'sudo', dockerArgs: ['-n', 'docker'] }
  throw new Error('Docker is required for `npm run build:code`. Start Docker or run the local builder directly with Node 24: `npm --prefix packages/vscode-web run build:code:local`.')
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${command} ${args.join(' ')}`)
    const child = spawn(command, args, { cwd: options.cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

async function main() {
  const { command, dockerArgs } = resolveDockerCommand()
  await run(command, [...dockerArgs, 'build', '--tag', builderImage, '--file', dockerfile, packageRoot])

  const runArgs = [...dockerArgs, 'run', '--rm']
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    runArgs.push('--user', `${process.getuid()}:${process.getgid()}`)
  }
  runArgs.push(
    '--env', 'HOME=/tmp/foxwarm-code-home',
    '--env', 'npm_config_cache=/workspace/packages/vscode-web/.cache/npm',
  )
  for (const name of ['FOXWARM_CODE_OSS_COMMIT', 'FOXWARM_CODE_OSS_REPOSITORY', 'FOXWARM_CODE_OSS_CACHE_DIR', 'FOXWARM_VSCODE_WEB_ASSET_DIR', 'FOXWARM_VSCODE_YAML_EXTENSION_DIR']) {
    if (process.env[name]) runArgs.push('--env', name)
  }
  runArgs.push(
    '--volume', `${repoRoot}:/workspace`,
    '--workdir', '/workspace',
    builderImage,
    'node',
    'packages/vscode-web/scripts/build-code-oss.mjs',
    ...process.argv.slice(2),
  )
  await run(command, runArgs)
}

main().catch((error) => {
  console.error(`\nDocker Code - OSS build failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
