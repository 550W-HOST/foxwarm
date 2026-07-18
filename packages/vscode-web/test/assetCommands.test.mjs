import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
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

test('source build uses the official standalone web packaging task and verifies its output', async () => {
  const source = await readFile(path.join(packageRoot, 'scripts/build-code-oss.mjs'), 'utf8')
  const dockerWrapper = await readFile(path.join(packageRoot, 'scripts/build-code-docker.mjs'), 'utf8')
  const builderDockerfile = await readFile(path.join(packageRoot, 'Dockerfile.code-oss'), 'utf8')
  const runtimeDockerfile = await readFile(path.join(repoRoot, 'Dockerfile'), 'utf8')
  const nodeDockerfile = await readFile(path.join(repoRoot, 'Dockerfile.node'), 'utf8')
  const testDockerfile = await readFile(path.join(repoRoot, 'test/Dockerfile'), 'utf8')
  const dockerignore = await readFile(path.join(repoRoot, '.dockerignore'), 'utf8')
  assert.match(source, /download-builtin-extensions/)
  assert.match(source, /vscode-web-min-ci/)
  assert.match(source, /workbench\.web\.main\.internal\.js/)
  assert.match(source, /product\.licenseName !== 'MIT'/)
  assert.match(dockerWrapper, /Dockerfile\.code-oss/)
  assert.match(dockerWrapper, /process\.getuid/)
  assert.match(builderDockerfile, /^FROM node:24\.17\.0-bookworm/m)
  assert.match(builderDockerfile, /libxkbfile-dev/)
  assert.equal((runtimeDockerfile.match(/^FROM node:24\.17\.0-bookworm(?:-slim)?/gm) || []).length, 2)
  assert.match(runtimeDockerfile, /packages\/vscode-web\/foxwarm-fs/)
  assert.match(nodeDockerfile, /^FROM node:24\.17\.0-bookworm-slim/m)
  assert.match(nodeDockerfile, /packages\/cli-node-runtime ci --omit=dev/)
  assert.match(testDockerfile, /^FROM node:24\.17\.0-bookworm/m)
  assert.match(dockerignore, /^packages\/vscode-web\/\.cache\/$/m)
  assert.doesNotMatch(dockerignore, /^skills\/$/m)
})
