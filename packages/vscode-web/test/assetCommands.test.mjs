import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  assert.match(buildHelp.stdout, /FOXWARM_CODE_OSS_GITHUB_TOKEN/)

  const downloadHelp = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/prepare-assets.mjs'), '--help'])
  assert.match(downloadHelp.stdout, /Microsoft's prebuilt VS Code web-standalone product/)
  assert.match(downloadHelp.stdout, new RegExp(version.commit))
  assert.match(downloadHelp.stdout, /--latest/)
})

test('Docker Code build forwards the optional GitHub token by name only', { skip: process.platform === 'win32' }, async t => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'code-docker-'))
  t.after(() => rm(bin, { recursive: true, force: true }))
  const token = 'code-build-test-token'
  const logFile = path.join(bin, 'docker-calls.jsonl')
  await writeFile(path.join(bin, 'docker'), String.raw`#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args: process.argv.slice(2),
  token: process.env.FOXWARM_CODE_OSS_GITHUB_TOKEN ?? null }) + '\n');
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  delete env.FOXWARM_CODE_OSS_GITHUB_TOKEN
  // An unrelated host GITHUB_TOKEN is never handed to the builder container.
  env.GITHUB_TOKEN = 'unrelated-host-token'
  for (const authenticated of [false, true]) {
    await writeFile(logFile, '')
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/build-code-docker.mjs')], {
      env: authenticated ? { ...env, FOXWARM_CODE_OSS_GITHUB_TOKEN: token } : env,
    })
    const calls = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls.map(call => call.args[0]), ['version', 'build', 'run'])
    const [, build, run] = calls
    assert.ok(!build.args.some(arg => arg.includes('TOKEN')))
    assert.equal(run.token, authenticated ? token : null)
    assert.deepEqual(run.args.flatMap((arg, i) => arg === '--env' && /TOKEN/.test(run.args[i + 1]) ? [run.args[i + 1]] : []),
      authenticated ? ['FOXWARM_CODE_OSS_GITHUB_TOKEN'] : [])
    assert.ok(!calls.some(call => call.args.some(arg => arg.includes(token) || arg.includes('unrelated-host-token'))))
    assert.ok(!stdout.includes(token) && !stderr.includes(token))
  }
})

test('Code source build gives each GitHub token consumer its own credential format', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileAsync('git', args, { cwd })
  const upstream = path.join(root, 'upstream')
  await mkdir(path.join(upstream, 'build/npm'), { recursive: true })
  await writeFile(path.join(upstream, 'product.json'), JSON.stringify({ nameShort: 'Code - OSS', licenseName: 'MIT' }))
  await writeFile(path.join(upstream, 'package.json'), JSON.stringify({ name: 'fake-code', version: '0.0.0' }))
  await writeFile(path.join(upstream, '.nvmrc'), `${process.versions.node}\n`)
  await writeFile(path.join(upstream, 'build/npm/preinstall.ts'), '')
  await git(upstream, 'init', '--quiet')
  await git(upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A')
  await git(upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture')
  const commit = (await git(upstream, 'rev-parse', 'HEAD')).stdout.trim()

  // Records each npm invocation and the GITHUB_TOKEN it receives; the build then fails for lack of assets.
  const bin = path.join(root, 'bin')
  const logFile = path.join(root, 'npm-calls.jsonl')
  await mkdir(bin)
  await writeFile(path.join(bin, 'npm'), String.raw`#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args: process.argv.slice(2),
  githubToken: process.env.GITHUB_TOKEN ?? null, foxwarmToken: process.env.FOXWARM_CODE_OSS_GITHUB_TOKEN ?? null }) + '\n');
if (process.argv[2] === 'ci') fs.mkdirSync('node_modules', { recursive: true });
`, { mode: 0o755 })

  const token = 'code-build-test-token'
  const base = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  delete base.GITHUB_TOKEN
  delete base.FOXWARM_CODE_OSS_GITHUB_TOKEN
  const build = async extraEnv => {
    await writeFile(logFile, '')
    await rm(path.join(root, 'cache'), { recursive: true, force: true })
    // The fake build produces no assets, so it fails after the last phase we need to observe.
    const result = await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/build-code-oss.mjs'),
      `--commit=${commit}`, `--repository=${upstream}`, `--cache=${path.join(root, 'cache')}`, `--out=${path.join(root, 'out')}`], {
      env: { ...base, ...extraEnv },
    }).then(value => value, error => error)
    assert.match(result.stderr, /did not produce required asset/)
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
    return (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
  }

  const calls = await build({ FOXWARM_CODE_OSS_GITHUB_TOKEN: token })
  assert.deepEqual(calls.map(call => call.args.join(' ')), ['ci', 'run download-builtin-extensions', 'run gulp vscode-web-min-ci'])
  // @vscode/ripgrep sends the value as `Authorization: token <value>`: the raw token.
  assert.equal(calls[0].githubToken, token)
  // build/lib/fetch.ts base64-encodes the value for HTTP Basic: `<user>:<token>`.
  assert.equal(calls[1].githubToken, `x-access-token:${token}`)
  assert.equal(calls[2].githubToken, `x-access-token:${token}`)
  assert.deepEqual(calls.map(call => call.foxwarmToken), [null, null, null])

  // Without the Foxwarm token the build never invents or forwards credentials.
  assert.deepEqual((await build({})).map(call => call.githubToken), [null, null, null])
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
