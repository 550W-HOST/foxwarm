import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(testDir, '..')
const repoRoot = path.resolve(packageRoot, '../..')

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

test('root exposes optional Code build and download commands outside normal build', async () => {
  const rootPackage = await readJson(path.join(repoRoot, 'package.json'))
  const codePackage = await readJson(path.join(packageRoot, 'package.json'))

  assert.equal(rootPackage.scripts['build:code'], 'npm --prefix packages/vscode-web run build:code --')
  assert.equal(rootPackage.scripts['download:code'], 'npm --prefix packages/vscode-web run download:code --')
  assert.doesNotMatch(rootPackage.scripts.build, /build:code|download:code|vscode-web/)
  assert.equal(codePackage.scripts['build:code'], 'node scripts/build-code-docker.mjs')
  assert.equal(codePackage.scripts['build:code:local'], 'node scripts/build-code-oss.mjs')
  assert.equal(codePackage.scripts['download:code'], 'node scripts/prepare-assets.mjs')
  assert.equal(codePackage.scripts['prepare:yaml-extension'], 'node scripts/prepare-yaml-extension.mjs')
})

test('Red Hat YAML Web extension has a stable Open VSX digest and reviewed MIT notices', async () => {
  const pin = await readJson(path.join(packageRoot, 'yaml-extension-version.json'))
  assert.equal(pin.extensionId, 'redhat.vscode-yaml')
  assert.equal(pin.version, '1.24.0')
  assert.equal(pin.license, 'MIT')
  assert.match(pin.artifact, /^https:\/\/open-vsx\.org\/api\/redhat\/vscode-yaml\/1\.24\.0\/file\//)
  assert.match(pin.sha256, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(pin.artifact, /marketplace\.visualstudio\.com/)
  assert.match(await readFile(path.join(packageRoot, pin.licenseFile), 'utf8'), /MIT License/)
  assert.match(await readFile(path.join(packageRoot, pin.noticesFile), 'utf8'), /THIRD-PARTY SOFTWARE NOTICES/)

  const help = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/prepare-yaml-extension.mjs'), '--help'])
  assert.match(help.stdout, /SHA-256 verifies/)
  assert.match(help.stdout, /redhat\.vscode-yaml@1\.24\.0/)
})

test('Code preparation commands document pinned, explicit behavior', async () => {
  const version = await readJson(path.join(packageRoot, 'code-oss-version.json'))
  assert.match(version.commit, /^[0-9a-f]{40}$/)
  assert.equal(version.repository, 'https://github.com/microsoft/vscode.git')
  assert.match(version.nodeVersion, /^\d+\.\d+\.\d+$/)

  const buildHelp = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/build-code-oss.mjs'), '--help'])
  assert.match(buildHelp.stdout, /MIT-licensed Code - OSS/)
  assert.match(buildHelp.stdout, new RegExp(version.commit))
  assert.match(buildHelp.stdout, /several GB/)

  const downloadHelp = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/prepare-assets.mjs'), '--help'])
  assert.match(downloadHelp.stdout, /Microsoft's prebuilt VS Code web-standalone product/)
  assert.match(downloadHelp.stdout, new RegExp(version.commit))
  assert.match(downloadHelp.stdout, /--latest/)
})

test('Docker Code build forwards optional GitHub credentials by name only', { skip: process.platform === 'win32' }, async t => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'code-docker-'))
  t.after(() => rm(bin, { recursive: true, force: true }))
  const token = 'code-build-test-token'
  const credential = `x-access-token:${token}`
  const logFile = path.join(bin, 'docker-calls.jsonl')
  await writeFile(path.join(bin, 'docker'), String.raw`#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args: process.argv.slice(2),
  credentialMatches: process.env.GITHUB_TOKEN === ${JSON.stringify(credential)},
  credentialAbsent: process.env.GITHUB_TOKEN === undefined }) + '\n');
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  delete env.GITHUB_TOKEN
  for (const authenticated of [false, true]) {
    await writeFile(logFile, '')
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/build-code-docker.mjs')], {
      env: authenticated ? { ...env, GITHUB_TOKEN: credential } : env,
    })
    const calls = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls.map(call => call.args[0]), ['version', 'build', 'run'])
    const [, build, run] = calls
    assert.ok(!build.args.some(arg => arg.includes('GITHUB_TOKEN')))
    assert.equal(run.credentialMatches, authenticated)
    assert.equal(run.credentialAbsent, !authenticated)
    assert.deepEqual(run.args.flatMap((arg, i) => arg === '--env' && run.args[i + 1]?.startsWith('GITHUB_TOKEN')
      ? [run.args[i + 1]] : []), authenticated ? ['GITHUB_TOKEN'] : [])
    assert.ok(!calls.some(call => call.args.some(arg => arg.includes(token))))
    assert.ok(!stdout.includes(token) && !stderr.includes(token))
  }
})

test('source build uses the official standalone web packaging task and verifies its output', async () => {
  const source = await readFile(path.join(packageRoot, 'scripts/build-code-oss.mjs'), 'utf8')
  const downloadSource = await readFile(path.join(packageRoot, 'scripts/prepare-assets.mjs'), 'utf8')
  const yamlSource = await readFile(path.join(packageRoot, 'scripts/yaml-extension-assets.mjs'), 'utf8')
  const dockerWrapper = await readFile(path.join(packageRoot, 'scripts/build-code-docker.mjs'), 'utf8')
  const builderDockerfile = await readFile(path.join(packageRoot, 'Dockerfile.code-oss'), 'utf8')
  const runtimeDockerfile = await readFile(path.join(repoRoot, 'Dockerfile'), 'utf8')
  const nodeDockerfile = await readFile(path.join(repoRoot, 'Dockerfile.node'), 'utf8')
  const dockerignore = await readFile(path.join(repoRoot, '.dockerignore'), 'utf8')
  assert.match(source, /download-builtin-extensions/)
  assert.match(source, /vscode-web-min-ci/)
  assert.match(source, /workbench\.web\.main\.internal\.js/)
  assert.match(source, /product\.licenseName !== 'MIT'/)
  assert.match(source, /prepareYamlExtension/)
  assert.match(downloadSource, /prepareYamlExtension/)
  assert.match(yamlSource, /createHash\('sha256'\)/)
  assert.match(yamlSource, /manifest\.browser !== '\.\/dist\/extension-web'/)
  assert.match(yamlSource, /honor-effective-telemetry-default-without-opt-in-prompt/)
  assert.match(yamlSource, /expected one match/)
  assert.match(dockerWrapper, /Dockerfile\.code-oss/)
  assert.match(dockerWrapper, /process\.getuid/)
  const version = await readJson(path.join(packageRoot, 'code-oss-version.json'))
  assert.equal(builderDockerfile.split('\n')[0], `FROM node:${version.nodeVersion}-bookworm`)
  assert.ok(dockerWrapper.includes(`foxwarm-code-oss-builder:node-${version.nodeVersion}`))
  assert.match(builderDockerfile, /libxkbfile-dev/)
  assert.equal((runtimeDockerfile.match(/^FROM node:24\.17\.0-trixie(?:-slim)?/gm) || []).length, 2)
  assert.match(nodeDockerfile, /^FROM node:24\.17\.0-bookworm-slim/m)
  assert.match(nodeDockerfile, /packages\/cli-node-runtime ci --omit=dev/)
  assert.match(dockerignore, /^packages\/vscode-web\/\.cache\/$/m)
  assert.doesNotMatch(dockerignore, /^skills\/$/m)
})
