#!/usr/bin/env node
// Publish prebuilt release packages from built delivery assets.
// Prerequisites: root and WebUI npm dependencies, `npm run build:assets` (or --build-assets),
// the .NET 10 SDK and Python 3. macOS packages must be built on macOS arm64.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const python = process.platform === 'win32' ? 'python' : 'python3'

// Native targets are NativeAOT publications: self-contained, with no .NET runtime or Foxwarm.dll.
// They can only be compiled on their own platform. Qualification targets are built and
// smoke-tested by the release workflow but not published.
export const TARGETS = {
  'linux-x64': { kind: 'server', rid: 'linux-x64', selfContained: false, archive: 'tar.gz' },
  'linux-x64-native': { kind: 'server', rid: 'linux-x64', selfContained: true, native: true, archive: 'tar.gz' },
  'osx-arm64': { kind: 'server', rid: 'osx-arm64', selfContained: false, archive: 'tar.gz' },
  'osx-arm64-self-contained': { kind: 'server', rid: 'osx-arm64', selfContained: true, archive: 'tar.gz' },
  'osx-arm64-native': { kind: 'server', rid: 'osx-arm64', selfContained: true, native: true, qualification: true, archive: 'tar.gz' },
  'win-x64': { kind: 'server', rid: 'win-x64', selfContained: false, archive: 'zip' },
  'win-x64-self-contained': { kind: 'server', rid: 'win-x64', selfContained: true, archive: 'zip' },
  'win-x64-native': { kind: 'server', rid: 'win-x64', selfContained: true, native: true, qualification: true, archive: 'zip' },
  'desktop-win-x64': { kind: 'desktop', rid: 'win-x64', selfContained: true, archive: 'zip' },
}

// The RID of this build host, for targets that cannot be cross-compiled.
export function hostRid(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'osx', win32: 'win' }[platform]
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch]
  return os && cpu ? `${os}-${cpu}` : ''
}

// Collected artifact-runtime packages that npm installs only for the build host.
const TARGET_NATIVES = {
  'linux-x64': ['@esbuild/linux-x64', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
  'osx-arm64': ['@esbuild/darwin-arm64', '@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
  'win-x64': ['@esbuild/win32-x64', '@img/sharp-win32-x64'],
}

export function assetName(name) {
  return `foxwarm-${name}.${TARGETS[name].archive}`
}

export const codeAssetName = `foxwarm-code-${version}.tar.gz`
const codeAssets = path.join(root, 'packages/vscode-web/assets')

export function validateCodeAssets(source = codeAssets) {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'packages/vscode-web/code-oss-version.json'), 'utf8'))
  const yaml = JSON.parse(fs.readFileSync(path.join(root, 'packages/vscode-web/yaml-extension-version.json'), 'utf8'))
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'vscode-web/foxwarm-vscode-web-assets.json'), 'utf8'))
  const extension = JSON.parse(fs.readFileSync(path.join(source, 'extensions/redhat.vscode-yaml/foxwarm-extension-assets.json'), 'utf8'))
  if (metadata.kind !== 'code-oss-source-build' || metadata.commit !== pin.commit
      || extension.version !== yaml.version || extension.sha256 !== yaml.sha256) {
    throw new Error('Release Code assets must match the pinned Code OSS and YAML source builds.')
  }
  for (const file of [
    'vscode-web/out/nls.messages.js',
    'vscode-web/out/vs/workbench/workbench.web.main.internal.css',
    'vscode-web/out/vs/workbench/workbench.web.main.internal.js',
    'vscode-web/LICENSE.txt', 'vscode-web/ThirdPartyNotices.txt',
    'extensions/redhat.vscode-yaml/package.json',
    'extensions/redhat.vscode-yaml/LICENSE.txt', 'extensions/redhat.vscode-yaml/thirdpartynotices.txt',
  ]) {
    const stat = fs.statSync(path.join(source, file))
    if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty Code resource: ${file}`)
  }
}

export function installCodeAssets(directory, source = codeAssets) {
  validateCodeAssets(source)
  const destination = path.join(directory, 'packages/vscode-web/assets')
  for (const entry of ['vscode-web', 'extensions/redhat.vscode-yaml']) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true })
  }
}

export function archiveCode(output, source = codeAssets) {
  validateCodeAssets(source)
  fs.mkdirSync(output, { recursive: true })
  const file = path.join(output, codeAssetName)
  tarArchive(source, ['extensions/redhat.vscode-yaml', 'vscode-web'], file)
  return file
}

function usage(message) {
  if (message) console.error(message)
  console.error(`Usage: node scripts/release/package.mjs --output DIR [--target NAME]... [--build-assets] [--directory-only] [--lancedb-library FILE] [--checksums-only | --code-only]
Targets: ${Object.keys(TARGETS).join(', ')}
(default: the published targets this host can build; native targets build only on their own platform)
--lancedb-library: Linux x64 liblancedb_ffi.so to package instead of the LanceDB package's (scripts/release/build-lancedb-linux.sh)`)
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

// Managed PDB/XML files and NativeAOT symbol files (.dbg on Linux, .dSYM bundles on macOS).
function removeDebugFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name)
    if (entry.isDirectory() && /\.dSYM$/i.test(entry.name)) fs.rmSync(file, { recursive: true, force: true })
    else if (entry.isFile() && /\.(pdb|xml|dbg)$/i.test(entry.name)) fs.rmSync(file, { force: true })
  }
}

function publish(name, directory, lancedbLibrary) {
  const target = TARGETS[name]
  const common = ['-c', 'Release', '-r', target.rid, '--self-contained', String(target.selfContained),
    '-p:DebugType=None', '-p:DebugSymbols=false', '-o', directory]
  // The LanceDB package's Linux library needs glibc 2.39; release builds supply one built on 2.34.
  if (lancedbLibrary && target.rid === 'linux-x64') common.push(`-p:LanceDbNativeLibrary=${lancedbLibrary}`)
  if (target.native) common.push('-p:PublishAot=true', '-p:StripSymbols=true')
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
  if (target.kind === 'desktop') installCodeAssets(directory)
  const commit = capture('git', ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({
    version, target: name, kind: target.kind, rid: target.rid, selfContained: target.selfContained,
    native: target.native === true, asset: assetName(name), commit,
  }, null, 2) + '\n')
}

export function archive(name, staging, output) {
  const file = path.join(output, assetName(name))
  fs.rmSync(file, { force: true })
  const top = path.basename(staging)
  if (TARGETS[name].archive === 'zip') {
    run(python, ['-c', `
import os, sys, zipfile
base, top, out = sys.argv[1:4]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for directory, folders, files in os.walk(os.path.join(base, top)):
        folders.sort()
        for name in sorted(files):
            full = os.path.join(directory, name)
            archive.write(full, os.path.relpath(full, base))
`, path.toNamespacedPath(path.dirname(staging)), top, path.toNamespacedPath(file)])
  } else {
    tarArchive(path.dirname(staging), [top], file)
  }
  return file
}

function tarArchive(base, entries, file) {
  const epoch = capture('git', ['show', '-s', '--format=%ct', 'HEAD'])
  // Normalize metadata on both GNU and BSD hosts, retaining all shipped resources.
  run(python, ['-c', `
import gzip, os, sys, tarfile
base, out, epoch, *entries = sys.argv[1:]
epoch = int(epoch)
def normalized(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = epoch
    info.pax_headers = {}
    return info
with open(out, 'wb') as raw:
    with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for entry in entries:
                archive.add(os.path.join(base, entry), arcname=entry, filter=normalized)
`, base, file, epoch, ...entries])
}

export function writeChecksums(output) {
  const lines = fs.readdirSync(output).filter(file => /\.(zip|tar\.gz)$/.test(file)).sort().map(file =>
    `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`)
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), lines.join('\n') + '\n')
}

function main(argv) {
  let output
  const targets = []
  let buildAssets = false
  let directoryOnly = false
  let checksumsOnly = false
  let codeOnly = false
  let lancedbLibrary
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--output') output = argv[++i]
    else if (arg === '--target') targets.push(argv[++i])
    else if (arg === '--build-assets') buildAssets = true
    else if (arg === '--directory-only') directoryOnly = true
    else if (arg === '--checksums-only') checksumsOnly = true
    else if (arg === '--code-only') codeOnly = true
    else if (arg === '--lancedb-library') lancedbLibrary = path.resolve(argv[++i] || usage('--lancedb-library requires a file'))
    else usage(`Unknown argument: ${arg}`)
  }
  if (!output) usage('--output is required')
  if (lancedbLibrary && !fs.statSync(lancedbLibrary, { throwIfNoEntry: false })?.isFile()) usage(`No such file: ${lancedbLibrary}`)
  for (const name of targets) if (!TARGETS[name]) usage(`Unknown target: ${name}`)
  output = path.resolve(output)
  if (codeOnly) {
    if (targets.length || buildAssets || directoryOnly || checksumsOnly) usage('--code-only cannot be combined with other build options')
    console.log(`Packaged ${archiveCode(output)}`)
    writeChecksums(output)
    return
  }
  if (checksumsOnly) {
    if (targets.length || buildAssets || directoryOnly) usage('--checksums-only cannot be combined with build options')
    writeChecksums(output)
    return
  }
  // By default, every published target this host can build.
  const selected = targets.length ? targets : Object.keys(TARGETS).filter(name => !TARGETS[name].qualification
    && (TARGETS[name].native ? TARGETS[name].rid === hostRid()
      : process.platform === 'darwin' ? name.startsWith('osx-') : !name.startsWith('osx-')))
  if (selected.some(name => name.startsWith('osx-')) && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
    throw new Error('macOS packages require an arm64 macOS build host for the native PTY library and helper.')
  }
  for (const name of selected) {
    if (TARGETS[name].native && TARGETS[name].rid !== hostRid()) throw new Error(`${name} is a NativeAOT package and must be built on ${TARGETS[name].rid}.`)
  }
  if (selected.some(name => TARGETS[name].kind === 'desktop')) validateCodeAssets()
  if (buildAssets) run('npm', ['run', 'build:assets'], { shell: process.platform === 'win32' })
  fs.mkdirSync(output, { recursive: true })
  const work = path.join(output, '.work')
  for (const name of selected) {
    ensureTargetNatives(TARGETS[name].rid, path.join(work, 'natives'))
    const prefix = TARGETS[name].kind === 'desktop' ? 'foxwarm-desktop' : 'foxwarm'
    const staging = path.join(work, name, `${prefix}-${version}-${TARGETS[name].rid}`)
    fs.rmSync(path.dirname(staging), { recursive: true, force: true })
    publish(name, staging, lancedbLibrary)
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
