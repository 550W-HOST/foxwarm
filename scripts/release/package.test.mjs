import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { archive, assetName, writeChecksums } from './package.mjs'

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
  const files = ['foxwarm-linux-x64.tar.gz', 'foxwarm-win-x64.zip', 'foxwarm-osx-arm64.tar.gz', 'foxwarm-osx-arm64-self-contained.tar.gz']
  for (const name of files) fs.writeFileSync(path.join(work, name), name)
  fs.writeFileSync(path.join(work, 'SHA256SUMS'), 'partial build list\n')
  writeChecksums(work)
  assert.equal(fs.readFileSync(path.join(work, 'SHA256SUMS'), 'utf8'), files.sort().map(name =>
    `${createHash('sha256').update(name).digest('hex')}  ${name}\n`).join(''))
})

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
  const target = framework ? 'osx-arm64' : 'osx-arm64-self-contained'
  fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify({ version: '0.9.0', rid: 'osx-arm64', target, selfContained: !framework, asset: assetName(target) }, null, 2) + '\n')
  const packagePath = archive(target, payload, assets)
  writeChecksums(assets)
  const env = { PATH: bin, HOME: work, TEST_WORK: work, TMPDIR: work }
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(root, 'install-foxwarm.sh'), '--no-start', ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' })
  return { work, packagePath, run, target }
}

for (const framework of [false, true]) test(`Darwin installer selects ${framework ? 'framework-dependent' : 'self-contained'} asset and verifies it with shasum`, unix, t => {
  const f = installer(t, framework), result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(path.join(f.work, 'downloads'), 'utf8'), assetName(f.target) + '\nSHA256SUMS\n')
  assert.equal(fs.readFileSync(path.join(f.work, 'inspected'), 'utf8'), 'inspected')
  assert.equal(fs.realpathSync(path.join(f.work, 'foxwarm/runtime/current')), path.join(f.work, 'foxwarm/runtime/0.9.0'))
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
