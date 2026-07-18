#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const versionConfig = JSON.parse(await fs.readFile(path.join(packageRoot, 'code-oss-version.json'), 'utf8'))
const defaultOutDir = path.join(packageRoot, 'assets', 'vscode-web')
const defaultCacheRoot = path.join(packageRoot, '.cache', 'code-oss')
const requiredAssets = [
  'out/nls.messages.js',
  'out/vs/workbench/workbench.web.main.internal.css',
  'out/vs/workbench/workbench.web.main.internal.js',
]

function parseArgs(argv) {
  const result = {
    commit: process.env.FOXWARM_CODE_OSS_COMMIT || versionConfig.commit,
    repository: process.env.FOXWARM_CODE_OSS_REPOSITORY || versionConfig.repository,
    outDir: process.env.FOXWARM_VSCODE_WEB_ASSET_DIR
      ? path.resolve(process.env.FOXWARM_VSCODE_WEB_ASSET_DIR)
      : defaultOutDir,
    cacheRoot: process.env.FOXWARM_CODE_OSS_CACHE_DIR
      ? path.resolve(process.env.FOXWARM_CODE_OSS_CACHE_DIR)
      : defaultCacheRoot,
    forceInstall: false,
  }

  for (const arg of argv) {
    if (arg.startsWith('--commit=')) result.commit = arg.slice('--commit='.length)
    else if (arg.startsWith('--repository=')) result.repository = arg.slice('--repository='.length)
    else if (arg.startsWith('--out=')) result.outDir = path.resolve(arg.slice('--out='.length))
    else if (arg.startsWith('--cache=')) result.cacheRoot = path.resolve(arg.slice('--cache='.length))
    else if (arg === '--force-install') result.forceInstall = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run build:code -- [options]

Builds the pinned MIT-licensed Code - OSS web workbench from source.
This is intentionally separate from the normal Foxwarm build and may use several GB of disk space.

Options:
  --commit=<sha>       Code - OSS commit (default: ${versionConfig.commit})
  --repository=<url>   Source repository (default: ${versionConfig.repository})
  --out=<dir>          Prepared asset output (default: ${defaultOutDir})
  --cache=<dir>        Source/dependency cache (default: ${defaultCacheRoot})
  --force-install      Re-run npm ci even when the dependency cache is ready

Environment equivalents:
  FOXWARM_CODE_OSS_COMMIT
  FOXWARM_CODE_OSS_REPOSITORY
  FOXWARM_CODE_OSS_CACHE_DIR
  FOXWARM_VSCODE_WEB_ASSET_DIR`)
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!/^[0-9a-f]{40}$/i.test(result.commit)) {
    throw new Error(`--commit must be a full 40-character Git SHA (received ${JSON.stringify(result.commit)})`)
  }
  if (result.outDir === path.parse(result.outDir).root || result.outDir === packageRoot) {
    throw new Error(`Refusing unsafe asset output directory: ${result.outDir}`)
  }
  return result
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${command} ${args.join(' ')}`)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

async function readText(filePath) {
  return (await fs.readFile(filePath, 'utf8')).trim()
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function prepareSource({ repository, commit, cacheRoot }) {
  const sourceDir = path.join(cacheRoot, commit, 'source')
  if (!await pathExists(path.join(sourceDir, '.git'))) {
    await fs.rm(sourceDir, { recursive: true, force: true })
    await fs.mkdir(sourceDir, { recursive: true })
    await run('git', ['init', '--quiet'], { cwd: sourceDir })
    await run('git', ['remote', 'add', 'origin', repository], { cwd: sourceDir })
    await run('git', ['fetch', '--depth=1', '--filter=blob:none', 'origin', commit], { cwd: sourceDir })
    await run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], { cwd: sourceDir })
  }

  const actualCommit = await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error('git rev-parse failed')))
  })
  if (actualCommit !== commit) {
    throw new Error(`Cached Code - OSS checkout is ${actualCommit}, expected ${commit}. Remove ${sourceDir} and retry.`)
  }
  return sourceDir
}

async function assertNodeVersion(sourceDir) {
  const requested = await readText(path.join(sourceDir, '.nvmrc'))
  const requestedMajor = requested.replace(/^v/, '').split('.')[0]
  const actualMajor = process.versions.node.split('.')[0]
  if (requestedMajor !== actualMajor) {
    throw new Error(`Code - OSS requires Node ${requested} (current: ${process.versions.node}).\nRun \`nvm install ${requested} && nvm use ${requested}\`, then retry \`npm run build:code\`.`)
  }
  return requested
}

async function installDependencies(sourceDir, commit, nodeVersion, forceInstall) {
  const markerPath = path.join(sourceDir, 'node_modules', '.foxwarm-code-oss-install.json')
  let marker
  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
  } catch {}

  if (!forceInstall && marker?.commit === commit && marker?.nodeMajor === nodeVersion.split('.')[0]) {
    console.log('\nCode - OSS dependency cache is ready; skipping npm ci. Use --force-install to refresh it.')
    return
  }

  await run('npm', ['ci'], {
    cwd: sourceDir,
    env: {
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  })
  await fs.writeFile(markerPath, JSON.stringify({ commit, nodeMajor: nodeVersion.split('.')[0] }, null, 2))
}

async function publishAssets(sourceDir, outDir, metadata) {
  const packageOutputDir = path.join(path.dirname(sourceDir), 'vscode-web')
  for (const relativePath of requiredAssets) {
    if (!await pathExists(path.join(packageOutputDir, relativePath))) {
      throw new Error(`Code - OSS build did not produce required asset: ${relativePath}`)
    }
  }

  const tmpOutDir = `${outDir}.tmp-${process.pid}`
  await fs.rm(tmpOutDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(tmpOutDir), { recursive: true })
  await fs.cp(packageOutputDir, tmpOutDir, { recursive: true })
  await fs.writeFile(path.join(tmpOutDir, 'foxwarm-vscode-web-assets.json'), JSON.stringify(metadata, null, 2))
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.rename(tmpOutDir, outDir)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  console.log(`Building Code - OSS ${options.commit}`)
  console.log(`Source cache: ${options.cacheRoot}`)
  console.log(`Asset output: ${options.outDir}`)
  console.log('This optional build is large and may require several GB of disk space.')

  if (options.commit === versionConfig.commit && versionConfig.nodeVersion) {
    const requestedMajor = versionConfig.nodeVersion.split('.')[0]
    const actualMajor = process.versions.node.split('.')[0]
    if (requestedMajor !== actualMajor) {
      throw new Error(`Code - OSS requires Node ${versionConfig.nodeVersion} (current: ${process.versions.node}).\nRun \`nvm install ${versionConfig.nodeVersion} && nvm use ${versionConfig.nodeVersion}\`, then retry \`npm run build:code\`.`)
    }
  }

  const sourceDir = await prepareSource(options)
  if (options.outDir === sourceDir || options.outDir.startsWith(`${sourceDir}${path.sep}`) || sourceDir.startsWith(`${options.outDir}${path.sep}`)) {
    throw new Error('Asset output and Code - OSS source checkout must not contain one another.')
  }
  const product = JSON.parse(await fs.readFile(path.join(sourceDir, 'product.json'), 'utf8'))
  if (product.licenseName !== 'MIT' || product.nameShort !== 'Code - OSS') {
    throw new Error(`Refusing to build an unexpected product configuration (${product.nameShort || 'unknown'}, ${product.licenseName || 'unknown license'}). Expected the MIT-licensed Code - OSS defaults.`)
  }
  const nodeVersion = await assertNodeVersion(sourceDir)
  await installDependencies(sourceDir, options.commit, nodeVersion, options.forceInstall)
  await run('npm', ['run', 'download-builtin-extensions'], { cwd: sourceDir })
  // The current standalone CI packager bundles directly from TypeScript source
  // with esbuild. Avoid the all-in-one task's unrelated desktop/server
  // declaration build and symbol mangler, which consume substantially more RAM.
  await run('npm', ['run', 'gulp', 'vscode-web-min-ci'], { cwd: sourceDir })

  const packageJson = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'))
  await publishAssets(sourceDir, options.outDir, {
    kind: 'code-oss-source-build',
    repository: options.repository,
    commit: options.commit,
    version: packageJson.version,
    nodeVersion,
    builtAt: new Date().toISOString(),
  })
  // Preserve the expensive source/dependency cache, but discard reproducible
  // intermediate trees after validated assets have been published.
  await Promise.all([
    fs.rm(path.resolve(sourceDir, '..', 'vscode-web'), { recursive: true, force: true }),
    fs.rm(path.join(sourceDir, 'out-build'), { recursive: true, force: true }),
    fs.rm(path.join(sourceDir, 'out-vscode-web-min'), { recursive: true, force: true }),
  ])
  console.log(`\nCode - OSS web assets are ready at ${options.outDir}`)
}

main().catch((error) => {
  console.error(`\nCode - OSS build failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
