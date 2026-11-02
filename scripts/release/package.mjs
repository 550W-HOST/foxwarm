#!/usr/bin/env node
// Publish prebuilt release packages from built delivery assets.
// Prerequisites: root and WebUI npm dependencies, `npm run build:assets` (or --build-assets),
// the .NET 10 SDK and Python 3. Linux hosts can produce every target.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

export const TARGETS = {
  'linux-x64': { kind: 'server', rid: 'linux-x64', selfContained: false, archive: 'tar.gz' },
  'linux-x64-self-contained': { kind: 'server', rid: 'linux-x64', selfContained: true, archive: 'tar.gz' },
  'win-x64': { kind: 'server', rid: 'win-x64', selfContained: false, archive: 'zip' },
  'win-x64-self-contained': { kind: 'server', rid: 'win-x64', selfContained: true, archive: 'zip' },
  'desktop-win-x64': { kind: 'desktop', rid: 'win-x64', selfContained: true, archive: 'zip' },
}

// Collected artifact-runtime packages that npm installs only for the build host.
const TARGET_NATIVES = {
  'linux-x64': ['@esbuild/linux-x64', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
  'win-x64': ['@esbuild/win32-x64', '@img/sharp-win32-x64'],
}

export function assetName(name) {
  return `foxwarm-${name}.${TARGETS[name].archive}`
}

function usage(message) {
  if (message) console.error(message)
  console.error(`Usage: node scripts/release/package.mjs --output DIR [--target NAME]... [--build-assets] [--directory-only]
Targets: ${Object.keys(TARGETS).join(', ')} (default: all)`)
  process.exit(2)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// Install the locked target-native packages beside the host ones, verified against the lockfile.
function ensureTargetNatives(rid, scratch) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages
  for (const name of TARGET_NATIVES[rid]) {
    const entry = lock[`node_modules/${name}`]
    if (!entry?.version || !entry.integrity) throw new Error(`${name} is not locked in package-lock.json`)
    const directory = path.join(root, 'node_modules', name)
    const installed = path.join(directory, 'package.json')
    if (fs.existsSync(installed) && JSON.parse(fs.readFileSync(installed, 'utf8')).version === entry.version) continue
    fs.mkdirSync(scratch, { recursive: true })
    const file = capture('npm', ['pack', '--silent', `${name}@${entry.version}`], { cwd: scratch }).split('\n').pop()
    const tarball = path.join(scratch, file)
    const [algorithm, expected] = entry.integrity.split('-', 2)
    const actual = createHash(algorithm).update(fs.readFileSync(tarball)).digest('base64')
    if (actual !== expected) throw new Error(`${name}@${entry.version} does not match its locked integrity`)
    fs.rmSync(directory, { recursive: true, force: true })
    fs.mkdirSync(directory, { recursive: true })
    run('tar', ['-xzf', tarball, '-C', directory, '--strip-components=1'])
    console.log(`Installed target-native ${name}@${entry.version}`)
  }
}

function removeDebugFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(pdb|xml)$/i.test(entry.name)) fs.rmSync(path.join(entry.parentPath, entry.name))
  }
}

function publish(name, directory) {
  const target = TARGETS[name]
  const common = ['-c', 'Release', '-r', target.rid, '--self-contained', String(target.selfContained),
    '-p:DebugType=None', '-p:DebugSymbols=false', '-o', directory]
  if (target.kind === 'desktop') {
    // SDK-added transitive references must use the same global properties as the
    // Desktop -> Core reference, or MSBuild compiles shared outputs twice in parallel.
    run('dotnet', ['publish', 'dotnet/Foxwarm.Desktop', ...common, '-p:FoxwarmConsoleEntry=false',
      `-p:ArtifactTargetRid=${target.rid}`, '-p:EnableWindowsTargeting=true'])
    // Desktop references the host assembly; it does not launch the console apphost.
    fs.rmSync(path.join(directory, 'Foxwarm.exe'), { force: true })
    fs.rmSync(path.join(directory, 'Foxwarm.runtimeconfig.json'), { force: true })
  } else {
    run('dotnet', ['publish', 'dotnet/Foxwarm/Foxwarm.csproj', ...common])
    const control = path.join(root, 'scripts/release')
    if (target.rid.startsWith('win-')) {
      for (const file of ['foxwarmctl.ps1', 'foxwarmctl.cmd']) fs.copyFileSync(path.join(control, file), path.join(directory, file))
    } else {
      fs.copyFileSync(path.join(control, 'foxwarmctl'), path.join(directory, 'foxwarmctl'))
      fs.chmodSync(path.join(directory, 'foxwarmctl'), 0o755)
    }
  }
  removeDebugFiles(directory)
  const commit = capture('git', ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({
    version, target: name, kind: target.kind, rid: target.rid, selfContained: target.selfContained,
    asset: assetName(name), commit,
  }, null, 2) + '\n')
}

function archive(name, staging, output) {
  const file = path.join(output, assetName(name))
  fs.rmSync(file, { force: true })
  const top = path.basename(staging)
  if (TARGETS[name].archive === 'zip') {
    run('python3', ['-c', `
import os, sys, zipfile
base, top, out = sys.argv[1:4]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for directory, folders, files in os.walk(os.path.join(base, top)):
        folders.sort()
        for name in sorted(files):
            full = os.path.join(directory, name)
            archive.write(full, os.path.relpath(full, base))
`, path.dirname(staging), top, file])
  } else {
    const epoch = capture('git', ['show', '-s', '--format=%ct', 'HEAD'])
    run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner',
      '-czf', file, '-C', path.dirname(staging), top])
  }
  return file
}

function writeChecksums(output) {
  const lines = fs.readdirSync(output).filter(file => /\.(zip|tar\.gz)$/.test(file)).sort().map(file =>
    `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`)
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), lines.join('\n') + '\n')
}

function main(argv) {
  let output
  const targets = []
  let buildAssets = false
  let directoryOnly = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--output') output = argv[++i]
    else if (arg === '--target') targets.push(argv[++i])
    else if (arg === '--build-assets') buildAssets = true
    else if (arg === '--directory-only') directoryOnly = true
    else usage(`Unknown argument: ${arg}`)
  }
  if (!output) usage('--output is required')
  for (const name of targets) if (!TARGETS[name]) usage(`Unknown target: ${name}`)
  output = path.resolve(output)
  const selected = targets.length ? targets : Object.keys(TARGETS)
  if (buildAssets) run('npm', ['run', 'build:assets'], { shell: process.platform === 'win32' })
  fs.mkdirSync(output, { recursive: true })
  const work = path.join(output, '.work')
  for (const name of selected) {
    ensureTargetNatives(TARGETS[name].rid, path.join(work, 'natives'))
    const prefix = TARGETS[name].kind === 'desktop' ? 'foxwarm-desktop' : 'foxwarm'
    const staging = path.join(work, name, `${prefix}-${version}-${TARGETS[name].rid}`)
    fs.rmSync(path.dirname(staging), { recursive: true, force: true })
    publish(name, staging)
    if (directoryOnly) {
      console.log(`Prepared ${staging}`)
      continue
    }
    console.log(`Packaged ${archive(name, staging, output)}`)
    fs.rmSync(path.dirname(staging), { recursive: true, force: true })
  }
  if (!directoryOnly) {
    fs.rmSync(work, { recursive: true, force: true })
    writeChecksums(output)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
