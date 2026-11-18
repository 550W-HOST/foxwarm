import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TARGETS, archive, assetName, packCode, codeAssetName, hostRid, includesCode, installerAssetName, installerScript, installerTarget, validateCodeAssets, writeChecksums } from './package.mjs'

import { codePrefix, extractPack, readPack } from '../asset-pack.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const unix = { skip: process.platform === 'win32' }
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-package-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function executable(file, content) {
  fs.writeFileSync(file, '#!/bin/bash\nset -eu\n' + content + '\n', { mode: 0o755 })
}

test('Windows ZIP archives preserve deeply nested Code resource paths', { skip: process.platform !== 'win32' }, t => {
  const work = scratch(t), payload = path.join(work, 'payload'), output = path.join(work, 'out')
  const relative = Array(12).fill('nested-code-resource').join('/') + '/asset.txt'
  const resource = path.join(payload, relative)
  assert(resource.length > 260)
  fs.mkdirSync(path.dirname(resource), { recursive: true })
  fs.mkdirSync(output)
  fs.writeFileSync(resource, 'deep Code resource')
  const file = archive('desktop-win-x64', payload, output)
  const read = spawnSync('python', ['-c',
    'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())',
    file, 'payload/' + relative], { encoding: 'utf8' })
  assert.equal(read.status, 0, read.stderr)
  assert.equal(read.stdout.trim(), 'deep Code resource')
})

test('portable tar archives normalize timestamps and ownership and preserve executable files and symlinks', unix, t => {
  const work = scratch(t), payload = path.join(work, 'payload'), output = path.join(work, 'out')
  fs.mkdirSync(payload); fs.mkdirSync(output)
  executable(path.join(payload, 'Foxwarm'), 'exit 0')
  fs.writeFileSync(path.join(payload, 'z-last.txt'), 'release data')
  fs.symlinkSync('Foxwarm', path.join(payload, 'current'))
  const file = archive('osx-arm64', payload, output), first = fs.readFileSync(file)
  for (const entry of ['Foxwarm', 'z-last.txt']) fs.utimesSync(path.join(payload, entry), 900, 1000)
  assert.deepEqual(fs.readFileSync(archive('osx-arm64', payload, output)), first)
  const metadata = spawnSync('python3', ['-c', `
import json, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    print(json.dumps([{'name': x.name, 'uid': x.uid, 'gid': x.gid, 'time': x.mtime,
                      'mode': x.mode, 'link': x.linkname} for x in archive.getmembers()]))
`, file], { encoding: 'utf8' })
  assert.equal(metadata.status, 0, metadata.stderr)
  const entries = JSON.parse(metadata.stdout)
  assert.deepEqual(entries.map(entry => entry.name), ['payload', 'payload/Foxwarm', 'payload/current', 'payload/z-last.txt'])
  assert(entries.every(entry => entry.uid === 0 && entry.gid === 0 && entry.time === entries[0].time))
  assert(entries[1].mode & 0o111)
  assert.equal(entries[2].link, 'Foxwarm')
})

test('checksum aggregation replaces partial lists and covers all platform assets', unix, t => {
  const work = scratch(t)
  const files = ['foxwarm-linux-x64.tar.gz', 'foxwarm-win-x64.zip', 'foxwarm-osx-arm64.tar.gz', 'foxwarm-osx-arm64-native.tar.gz', 'foxwarm-android-node.apk', installerAssetName, codeAssetName]
  for (const name of files) fs.writeFileSync(path.join(work, name), name)
  fs.writeFileSync(path.join(work, 'SHA256SUMS'), 'partial build list\n')
  writeChecksums(work)
  assert.equal(fs.readFileSync(path.join(work, 'SHA256SUMS'), 'utf8'), files.sort().map(name =>
    `${createHash('sha256').update(name).digest('hex')}  ${name}\n`).join(''))
})

// framework: the package is framework-dependent and an ASP.NET Core 10 runtime is installed.
function installer(t, framework = false) {
  const work = scratch(t), bin = path.join(work, 'bin'), assets = path.join(work, 'assets'), payload = path.join(work, 'payload')
  fs.mkdirSync(bin); fs.mkdirSync(assets); fs.mkdirSync(payload)
  // Model the stock macOS tool selection: shasum, no sha256sum, no ldconfig or tmux.
  for (const command of ['tar', 'gzip', 'shasum', 'cat', 'dirname', 'mkdir', 'mktemp', 'rm', 'grep', 'sed', 'find', 'mv', 'ln', 'cp']) {
    const found = spawnSync('/bin/bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim()
    assert(found, `${command} is required for the installer fixture`)
    fs.symlinkSync(found, path.join(bin, command))
  }
  executable(path.join(bin, 'uname'), 'if [ "$1" = -s ]; then echo Darwin; else echo "${TEST_ARCH:-arm64}"; fi')
  executable(path.join(bin, 'curl'), `while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; --retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
printf '%s\\n' "\${url##*/}" >> "$TEST_WORK/downloads"
cp "$TEST_WORK/assets/\${url##*/}" "$out"`)
  if (framework) executable(path.join(bin, 'dotnet'), 'if [ "$1" = --list-runtimes ]; then echo "Microsoft.AspNetCore.App 10.0.0 [/owned]"; else printf inspected > "$TEST_WORK/inspected"; fi')
  executable(path.join(payload, 'Foxwarm'), 'printf inspected > "$TEST_WORK/inspected"')
  executable(path.join(payload, 'foxwarmctl'), 'exit 0')
  const target = framework ? 'osx-arm64' : 'osx-arm64-native'
  fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify({ version: '0.9.0', rid: 'osx-arm64', target, selfContained: !framework,
    ...(framework ? {} : { native: true }), asset: assetName(target) }, null, 2) + '\n')
  const packagePath = archive(target, payload, assets)
  writeChecksums(assets)
  const env = { PATH: bin, HOME: work, TEST_WORK: work, TMPDIR: work }
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(root, 'install-foxwarm.sh'), '--no-start', ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' })
  return { work, packagePath, run, target }
}

// Like Linux, macOS uses the native package unless the framework-dependent one is chosen,
// also when an ASP.NET Core runtime is installed.
for (const framework of [false, true]) test(`Darwin installer ${framework ? 'installs the chosen framework-dependent' : 'defaults to the native'} asset and verifies it with shasum`, unix, t => {
  const f = installer(t, framework), result = f.run(framework ? ['--framework-dependent'] : [])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  if (!framework) assert.match(result.stdout, /native package/)
  assert.equal(fs.readFileSync(path.join(f.work, 'downloads'), 'utf8'), assetName(f.target) + '\nSHA256SUMS\n')
  assert.equal(fs.readFileSync(path.join(f.work, 'inspected'), 'utf8'), 'inspected')
  assert.equal(fs.realpathSync(path.join(f.work, 'foxwarm/runtime/current')), path.join(f.work, 'foxwarm/runtime/0.9.0'))
})

test('every server platform publishes a native package instead of a self-contained one', () => {
  const published = Object.keys(TARGETS).filter(name => !TARGETS[name].qualification).map(assetName).sort()
  assert.deepEqual(published, ['foxwarm-desktop-osx-arm64.zip', 'foxwarm-desktop-win-x64.zip', 'foxwarm-linux-x64-native.tar.gz', 'foxwarm-linux-x64.tar.gz',
    'foxwarm-osx-arm64-native.tar.gz', 'foxwarm-osx-arm64.tar.gz', 'foxwarm-win-x64-native.zip', 'foxwarm-win-x64.zip'])
  for (const name of ['linux-x64-native', 'win-x64-native', 'osx-arm64-native']) {
    assert.equal(TARGETS[name].native, true)
    assert.equal(TARGETS[name].selfContained, true, 'Older control scripts launch self-contained packages through their executable')
  }
  assert.equal(hostRid('linux', 'x64'), 'linux-x64')
  assert.equal(hostRid('darwin', 'arm64'), 'osx-arm64')
  assert.equal(hostRid('win32', 'x64'), 'win-x64')
})

test('only the two Desktop packages bundle the workbench', () => {
  assert.deepEqual(Object.keys(TARGETS).filter(includesCode).sort(), ['desktop-osx-arm64', 'desktop-win-x64'])
})

test('the Windows Desktop is a NativeAOT package built only on Windows x64', t => {
  assert.deepEqual(TARGETS['desktop-win-x64'], { kind: 'desktop', rid: 'win-x64', selfContained: true, native: true, archive: 'zip' })
  if (hostRid() === 'win-x64') return t.skip('this host can build the package')
  const output = scratch(t)
  const script = path.join(root, 'scripts/release/package.mjs')
  const elsewhere = spawnSync(process.execPath, [script, '--output', output, '--native-libraries', output, '--target', 'desktop-win-x64'], { encoding: 'utf8' })
  assert.equal(elsewhere.status, 1)
  assert.match(elsewhere.stderr, /desktop-win-x64 is a NativeAOT package and must be built on win-x64/)
  assert.deepEqual(fs.readdirSync(output), [])
})

test('the Windows Desktop installer keeps its name and installation identity', () => {
  assert.equal(installerTarget, 'desktop-win-x64')
  const script = fs.readFileSync(installerScript, 'utf8')
  assert.match(script, new RegExp(`^OutputBaseFilename=${installerAssetName.replace(/\.exe$/, '')}$`, 'm'))
  // Upgrades and uninstallation find an installation by this AppId.
  assert.match(script, /^#define AppGuid "6BE01B0C-EDFF-4777-A5DE-FB2F3BB5167D"$/m)
  assert.match(script, /^AppId=\{\{\{#AppGuid\}\}$/m)
  assert.match(script, /^PrivilegesRequired=lowest$/m)
})

test('the installer is built only with the Windows Desktop archive', t => {
  const output = scratch(t)
  const iscc = path.join(output, 'ISCC.exe')
  fs.writeFileSync(iscc, '')
  const script = path.join(root, 'scripts/release/package.mjs')
  const without = spawnSync(process.execPath, [script, '--output', output, '--target', 'linux-x64', '--inno-setup', iscc], { encoding: 'utf8' })
  assert.equal(without.status, 2)
  assert.match(without.stderr, /--inno-setup needs the desktop-win-x64 target and an archive/)
  const missing = spawnSync(process.execPath, [script, '--output', output, '--target', 'desktop-win-x64', '--inno-setup', path.join(output, 'missing.exe')], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /No such file/)
  assert.deepEqual(fs.readdirSync(output), ['ISCC.exe'])
})

test('the macOS Desktop is a NativeAOT application bundle built only on macOS arm64', t => {
  assert.deepEqual(TARGETS['desktop-osx-arm64'], { kind: 'desktop', rid: 'osx-arm64', selfContained: true, native: true, bundle: 'Foxwarm.app', archive: 'zip' })
  if (hostRid() === 'osx-arm64') return t.skip('this host can build the bundle')
  const output = scratch(t)
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/release/package.mjs'), '--output', output, '--target', 'desktop-osx-arm64'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /macOS packages require an arm64 macOS build host/)
  assert.deepEqual(fs.readdirSync(output), [])
})

test('Darwin installer accepts --native and maps the retired --self-contained option to it', unix, t => {
  const f = installer(t)
  assert.equal(f.run(['--native']).status, 0)
  const legacy = f.run(['--self-contained', '--dir', 'other'])
  assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr)
  assert.match(legacy.stdout, /replaced by the native package/)
  assert.equal(fs.readFileSync(path.join(f.work, 'downloads'), 'utf8'), `${assetName(f.target)}\nSHA256SUMS\n`.repeat(2))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.work, 'other/runtime/current/release.json'), 'utf8')).asset, 'foxwarm-osx-arm64-native.tar.gz')
})

test('Darwin installer rejects Intel and corrupt downloads before executing a package', unix, t => {
  const f = installer(t)
  const intel = f.run([], { TEST_ARCH: 'x86_64' })
  assert.notEqual(intel.status, 0)
  assert.match(intel.stderr, /Apple Silicon/)
  assert(!fs.existsSync(path.join(f.work, 'downloads')))
  fs.appendFileSync(f.packagePath, 'corruption')
  const corrupt = f.run()
  assert.notEqual(corrupt.status, 0)
  assert.match(corrupt.stderr, /Checksum verification failed/)
  assert(!fs.existsSync(path.join(f.work, 'inspected')))
})

test('Darwin --package install rejects another RID before upgrade inspection', unix, t => {
  const f = installer(t)
  const manifest = path.join(f.work, 'payload/release.json')
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replaceAll('osx-arm64', 'linux-x64'))
  archive(f.target, path.join(f.work, 'payload'), path.join(f.work, 'assets'))
  const result = f.run(['--package', f.packagePath])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /for linux-x64, not osx-arm64/)
  assert(!fs.existsSync(path.join(f.work, 'inspected')))
})

function preparedCode(t) {
  const directory = scratch(t)
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'packages/vscode-web/code-oss-version.json')))
  const yaml = JSON.parse(fs.readFileSync(path.join(root, 'packages/vscode-web/yaml-extension-version.json')))
  const files = {
    'vscode-web/foxwarm-vscode-web-assets.json': JSON.stringify({ kind: 'code-oss-source-build', commit: pin.commit }),
    'extensions/redhat.vscode-yaml/foxwarm-extension-assets.json': JSON.stringify(yaml),
    'vscode-web/out/nls.messages.js': 'messages',
    'vscode-web/out/vs/workbench/workbench.web.main.internal.js': 'workbench',
    'vscode-web/out/vs/workbench/workbench.web.main.internal.css': 'styles',
    'vscode-web/LICENSE.txt': 'Code license',
    'vscode-web/ThirdPartyNotices.txt': 'Code notices',
    'vscode-web/extensions/language-one/package.json': '{"name":"language-one"}',
    'vscode-web/extensions/language-two/syntax.xml': '<grammar/>',
    'extensions/redhat.vscode-yaml/package.json': '{"name":"vscode-yaml"}',
    'extensions/redhat.vscode-yaml/LICENSE.txt': 'YAML license',
    'extensions/redhat.vscode-yaml/thirdpartynotices.txt': 'YAML notices',
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.writeFileSync(path.join(directory, file), text)
  }
  return { directory, files }
}

test('Code pack preserves every resource and notice and supports debugging extraction', t => {
  const { directory, files } = preparedCode(t)
  const output = scratch(t), extracted = scratch(t)
  const file = packCode(output, directory)
  assert.equal(path.basename(file), codeAssetName)
  extractPack(file, extracted)
  const pack = readPack(file)
  try {
    assert.deepEqual(Object.keys(pack.entries).sort(), Object.keys(files).map(file => `${codePrefix}/${file}`).sort())
    for (const [name, text] of Object.entries(files)) {
      assert.equal(pack.read(`${codePrefix}/${name}`).toString(), text)
      assert.equal(fs.readFileSync(path.join(extracted, codePrefix, name), 'utf8'), text)
    }
  } finally { pack.close() }
  writeChecksums(output)
  assert.match(fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8'), new RegExp('  ' + codeAssetName.replaceAll('.', '\\.') + '\n$'))
})

test('release Code validation rejects another pin and missing redistribution notices', t => {
  const { directory } = preparedCode(t)
  validateCodeAssets(directory)
  fs.rmSync(path.join(directory, 'vscode-web/ThirdPartyNotices.txt'))
  assert.throws(() => validateCodeAssets(directory), /ENOENT/)
  fs.writeFileSync(path.join(directory, 'vscode-web/ThirdPartyNotices.txt'), 'notices')
  fs.writeFileSync(path.join(directory, 'vscode-web/foxwarm-vscode-web-assets.json'), JSON.stringify({ kind: 'code-oss-source-build', commit: 'wrong' }))
  assert.throws(() => validateCodeAssets(directory), /pinned/)
})
