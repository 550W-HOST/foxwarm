import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { assetName, codeAssetName, TARGETS } from '../release/package.mjs'
import testEnvironment from './test-process-env.cjs'

testEnvironment.initializeTestEnvironment()
const root = fileURLToPath(new URL('../../', import.meta.url))
const workflow = yaml.load(await fs.readFile(path.join(root, '.github/workflows/tests.yml'), 'utf8'))
const { jobs } = workflow
const shared = yaml.load(await fs.readFile(path.join(root, '.github/workflows/code-resources.yml'), 'utf8'))
const release = yaml.load(await fs.readFile(path.join(root, '.github/workflows/release.yml'), 'utf8'))
const codeProducer = shared.jobs['code-resources']
const restore = job => job.steps.filter(step => step.uses?.startsWith('actions/cache/restore@'))

// Exercise the workflow's actual hashFiles inputs, not a second hand-maintained key list.
async function keyInputs(job) {
  const key = restore(job)[0].with.key
  const expression = key.match(/hashFiles\((.*?)\)/)?.[1]
  assert.ok(expression, key)
  const patterns = [...expression.matchAll(/'([^']+)'/g)].map(match => match[1])
  const files = new Set()
  for (const pattern of patterns) for await (const file of fs.glob(pattern, { cwd: root })) {
    if ((await fs.stat(path.join(root, file))).isFile()) files.add(file)
  }
  return new Map(await Promise.all([...files].sort().map(async file => [file, await fs.readFile(path.join(root, file))])))
}

function digest(inputs) {
  const hash = createHash('sha256')
  for (const content of inputs.values()) hash.update(createHash('sha256').update(content).digest())
  return hash.digest('hex')
}

test('Android Tests and Release caches cannot restore or save each other’s entries', () => {
  const cache = job => job.steps.find(step => step.name === 'Cache Gradle dependencies and wrapper')
  const testCache = cache(jobs.android)
  const releaseCache = cache(release.jobs.android)
  for (const step of [testCache, releaseCache]) {
    assert.match(step.uses, /^actions\/cache@/)
    assert.ok(step.with.key.startsWith(step.with['restore-keys'].trim()))
  }
  for (const [source, other] of [[testCache, releaseCache], [releaseCache, testCache]]) {
    assert.ok(!source.with.key.startsWith(other.with['restore-keys'].trim()))
  }
})

test('resource cache keys change with pins, build inputs and runner/toolchain configuration', async () => {
  const code = await keyInputs(codeProducer)
  const heif = await keyInputs(jobs['native-test-resources'])
  for (const [inputs, required] of [[code, [
    'packages/vscode-web/code-oss-version.json',
    'packages/vscode-web/yaml-extension-version.json',
    'packages/vscode-web/scripts/build-code-oss.mjs',
    'packages/vscode-web/scripts/build-code-docker.mjs',
    'packages/vscode-web/scripts/yaml-extension-assets.mjs',
    'packages/vscode-web/third-party/redhat-vscode-yaml/LICENSE.txt',
    'packages/vscode-web/third-party/redhat-vscode-yaml/thirdpartynotices.txt',
    'packages/vscode-web/Dockerfile.code-oss',
    'packages/vscode-web/package.json',
    'package.json',
    'scripts/test/prepare-browser.mjs',
    '.github/workflows/code-resources.yml',
  ]], [heif, ['dotnet/scripts/build-image-decoder.sh', '.github/workflows/tests.yml']]]) {
    const original = digest(inputs)
    for (const file of required) {
      assert.ok(inputs.has(file), `Cache key omits ${file}`)
      const changed = new Map(inputs)
      changed.set(file, Buffer.concat([inputs.get(file), Buffer.from('\nchanged input')]))
      assert.notEqual(digest(changed), original, file)
    }
  }
  for (const file of ['scripts/release/package.mjs', 'scripts/asset-pack.mjs', 'package-lock.json',
    'packages/vscode-web/scripts/prepare-assets.mjs', 'packages/vscode-web/scripts/prepare-yaml-extension.mjs']) {
    assert.ok(!code.has(file), `Code cache key should not depend on ${file}`)
  }
})

test('only resource producers build pins; consumers require the exact validated cache', () => {
  for (const [producerId, consumerIds] of [
    ['native-test-resources', ['core', 'managed', 'chromium']],
  ]) {
    const producer = jobs[producerId]
    const cache = restore(producer)[0]
    assert.equal(cache.with['restore-keys'], undefined)
    const buildIndex = producer.steps.findIndex(step => step.if && step.run)
    const saveIndex = producer.steps.findIndex(step => step.uses?.startsWith('actions/cache/save@'))
    assert.ok(buildIndex >= 0 && saveIndex > buildIndex + 1)
    assert.equal(producer.steps[buildIndex].if, "${{ steps.cache.outputs.cache-hit != 'true' }}")
    assert.equal(producer.steps[saveIndex].if, producer.steps[buildIndex].if)
    assert.equal(producer.steps[saveIndex].with.key, '${{ steps.cache.outputs.cache-primary-key }}')
    assert.equal(producer.outputs['cache-key'], '${{ steps.cache.outputs.cache-primary-key }}')
    for (const consumerId of consumerIds) {
      const consumer = jobs[consumerId]
      assert.ok([consumer.needs].flat().includes(producerId))
      const restored = restore(consumer).find(step => step.with.key === `\${{ needs.${producerId}.outputs.cache-key }}`)
      assert.ok(restored, `${consumerId} must consume ${producerId}`)
      assert.equal(restored.with.path, cache.with.path)
      assert.equal(restored.with['fail-on-cache-miss'], true)
      assert.equal(restored.with['restore-keys'], undefined)
      assert.ok(!consumer.steps.some(step => /build:code|--code-only|build-image-decoder/.test(step.run || '')))
      const index = consumer.steps.indexOf(restored)
      assert.match(consumer.steps[index + 1].run, producerId === 'code-resources' ? /--check-code/ : /test -s/)
      assert.ok(index < consumer.steps.findIndex(step => /npm run test:/.test(step.run || '')))
    }
  }
  assert.equal(jobs.chromium.strategy['fail-fast'], false)
  assert.deepEqual(jobs.chromium.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8])
  const browser = jobs.chromium.steps.find(step => step.run?.includes('test:webui:e2e'))
  assert.equal(browser.run, 'npm run test:webui:e2e -- --shard=${{ matrix.shard }}/8 --workers=2')
  const published = jobs.chromium.steps.filter(step => step.run === 'npm run test:published')
  assert.equal(published.length, 1)
  assert.equal(published[0].if, '${{ matrix.shard == 1 }}')
})

const nativeInputs = [
  'dotnet/Foxwarm.LanceDb/source.json', 'dotnet/Foxwarm.LanceDb/native-build.patch',
  'dotnet/Foxwarm/ToolScript/monty-source.json', 'dotnet/Foxwarm/ToolScript/monty-no-type-check.patch',
  'scripts/release/build-lancedb.sh', 'scripts/release/build-monty.sh', 'scripts/release/rust-native-common.sh',
  'scripts/release/native-source.py', 'scripts/release/crate-licenses.py',
]

for (const [rid, extra] of [
  ['linux-x64', ['scripts/release/rust-native-linux.Dockerfile']],
  ['win-x64', ['scripts/release/install-protoc.py']],
  ['osx-arm64', ['scripts/release/install-protoc.py']],
]) {
  test(`${rid} packages ship the cached LanceDB library and ToolScript worker built from pinned source`, () => {
    const name = `native-${rid}`
    const producer = release.jobs[name]
    const cache = restore(producer)[0]
    for (const input of [...nativeInputs, ...extra]) assert.ok(cache.with.key.includes(`'${input}'`), input)
    const builds = producer.steps.filter(step => /build-lancedb|build-monty/.test(step.run || ''))
    assert.ok(builds.length > 0)
    for (const step of builds) assert.equal(step.if, "${{ steps.cache.outputs.cache-hit != 'true' }}")
    const uploaded = producer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
    assert.equal(uploaded.with.name, name)
    const consumers = Object.entries(release.jobs).filter(([, job]) => job.steps?.some(step =>
      step.uses?.startsWith('actions/download-artifact@') && step.with.name === name))
    assert.ok(consumers.length > 0)
    for (const [consumer, job] of consumers) {
      assert.ok([job.needs].flat().includes(name), `${consumer} must wait for ${name}`)
      // Every package build of this RID passes the directory; no job packages the NuGet or npm binaries.
      for (const step of job.steps.filter(step => /package\.mjs[\s\S]*--target (linux-x64|osx-arm64|win-x64|desktop-)/.test(step.run || ''))) {
        assert.match(step.run, /--native-libraries/, `${consumer}: ${step.name}`)
      }
    }
  })
}

test('The Linux native libraries are checked against glibc 2.34 and every package against the build output', () => {
  const producer = release.jobs['native-linux-x64']
  assert.ok(producer.steps.some(step => step.run?.includes('check-linux-libraries.sh native-linux-x64')))
  const packages = release.jobs.packages
  const linuxBuilds = packages.steps.filter(step => /package\.mjs[\s\S]*--target linux-x64(-native)?\b/.test(step.run || ''))
  assert.equal(linuxBuilds.length, 2)
  assert.ok(packages.steps.some(step => step.run?.includes('check-native-libraries.mjs')))
  assert.ok(release.jobs.windows.steps.some(step => step.run?.includes('check-native-libraries.mjs')))
  assert.ok(release.jobs.macos.steps.some(step => step.run?.includes('check-native-libraries.mjs')))
  assert.ok(release.jobs['macos-desktop'].steps.some(step => step.run?.includes('check-native-libraries.mjs')))
})

test('Tests and Release reuse one cache-backed Code producer and consume its per-run archive', () => {
  assert.equal(jobs['code-resources'].uses, './.github/workflows/code-resources.yml')
  assert.equal(release.jobs['code-resources'].uses, jobs['code-resources'].uses)
  assert.ok(jobs.chromium.needs.includes('code-resources'))
  assert.ok([release.jobs.packages.needs].flat().includes('code-resources'))
  const cache = restore(codeProducer)[0]
  assert.equal(cache.with['restore-keys'], undefined)
  assert.equal(cache.with['fail-on-cache-miss'], undefined)
  const build = codeProducer.steps.find(step => step.run?.includes('--code-only') && step.run.includes('prepare-browser'))
  assert.equal(build.if, "${{ steps.cache.outputs.cache-hit != 'true' }}")
  assert.deepEqual(shared.permissions, { contents: 'read' })
  // The build script gives each Code tool the GITHUB_TOKEN format it expects.
  assert.deepEqual(build.env, { FOXWARM_CODE_OSS_GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
  assert.ok(codeProducer.steps.every(step => step === build || !Object.keys(step.env ?? {}).some(name => /TOKEN/.test(name))))
  const uploaded = codeProducer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(uploaded.with.name, 'code-resources')
  const packaged = codeProducer.steps.findIndex(step => step.run?.includes('package.mjs --code-only'))
  assert.ok(packaged > codeProducer.steps.indexOf(build))
  assert.ok(packaged < codeProducer.steps.indexOf(uploaded))
  const downloads = (job, name) => job.steps.find(step => step.uses?.startsWith('actions/download-artifact@') && step.with.name === name)
  const builtCode = job => job.steps.some(step => /build:code|prepare-browser.mjs --code-only/.test(step.run || ''))
  // The Linux producer forwards the Code archive as a standalone file; Windows extracts it for Desktop.
  const forwarded = release.jobs.packages.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')
    && path.matchesGlob(`dist/${codeAssetName}`, step.with.path))
  assert.ok(downloads(release.jobs.packages, uploaded.with.name))
  assert.equal(forwarded.with.archive, false)
  assert.ok(!builtCode(release.jobs.packages))
  const windowsDownload = release.jobs.windows.steps.find(step => step.uses?.startsWith('actions/download-artifact@')
    && step.with.pattern && path.matchesGlob(codeAssetName, step.with.pattern))
  for (const [job, download] of [[jobs.chromium, downloads(jobs.chromium, uploaded.with.name)], [release.jobs.windows, windowsDownload]]) {
    assert.ok(download)
    const extraction = job.steps.find(step => step.run?.includes('asset-pack.mjs extract') && step.run.includes('foxwarm-code-'))
    assert.ok(extraction)
    assert.ok(job.steps.indexOf(download) < job.steps.indexOf(extraction))
    assert.ok(!builtCode(job))
  }
})

test('Release downloads the original package files, without platform bundles or unrelated artifacts', () => {
  const cliPackages = [
    'native-cli-node-latest-v3.tar.gz',
    'native-cli-node-win-x64-latest-v3.zip',
    'native-cli-node-osx-arm64-latest-v3.tar.gz',
  ]
  const mainPackages = [...Object.keys(TARGETS).map(assetName), 'foxwarm-android-node.apk', codeAssetName]
  const packages = [...mainPackages, ...cliPackages]
  const derived = ['SHA256SUMS']
  const uploads = Object.values(release.jobs).flatMap(job => job.steps ?? [])
    .filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  for (const file of [...mainPackages, ...derived]) {
    const producers = uploads.filter(step => step.with.archive === false && path.matchesGlob(`dist/${file}`, step.with.path))
    assert.equal(producers.length, 1, file)
  }
  assert.ok(!uploads.some(step => step.with.name?.startsWith('release-packages')))
  const candidates = [...packages, ...derived, 'code-resources', 'desktop-acceptance', 'desktop-mac-acceptance',
    'native-cli-linux-x64-source-sha', 'native-linux-x64']
  for (const [jobId, expected] of [
    ['linux', ['foxwarm-linux-x64.tar.gz', 'foxwarm-linux-x64-native.tar.gz']],
    ['windows', [codeAssetName]],
    ['image', ['foxwarm-linux-x64-native.tar.gz']],
    ['checksums', packages],
    ['release', [...packages, ...derived]],
  ]) {
    const downloads = release.jobs[jobId].steps.filter(step => step.uses?.startsWith('actions/download-artifact@')
      && step.with.path === 'dist')
    const selected = downloads.flatMap(step => {
      assert.equal(step.with['skip-decompress'], true, jobId)
      const pattern = step.with.pattern === '${{ env.PACKAGE_ARTIFACTS }}'
        ? release.env.PACKAGE_ARTIFACTS
        : step.with.pattern
      const matches = candidates.filter(file => pattern ? path.matchesGlob(file, pattern) : file === step.with.name)
      if (matches.length > 1) assert.equal(step.with['merge-multiple'], true, jobId)
      return matches
    })
    assert.deepEqual(selected.sort(), expected.toSorted(), jobId)
  }
})

test('native Main publishes once, checks its warnings and runs the smoke against that executable', () => {
  const job = jobs['native-main']
  const index = predicate => job.steps.findIndex(predicate)
  const publishes = job.steps.filter(step => /dotnet publish/.test(step.run || ''))
  assert.equal(publishes.length, 1)
  assert.match(publishes[0].run, /-r linux-x64/)
  assert.match(publishes[0].run, /-p:PublishAot=true/)
  assert.match(publishes[0].run, /-o "\$RUNNER_TEMP\/native-main"/)
  const publish = job.steps.indexOf(publishes[0])
  const warnings = index(step => /native-main-warnings\.mjs/.test(step.run || ''))
  const smoke = index(step => step.run === 'npm run test:native')
  assert.ok(publish < warnings && warnings < smoke)
  assert.equal(job.steps[smoke].env.FOXWARM_TEST_MAIN_EXECUTABLE, '${{ runner.temp }}/native-main/Foxwarm')
  assert.ok(!job.steps.some(step => /npm run build(?:$|\s)|test:webui:e2e|test:app:e2e/.test(step.run || '')))
})

test('managed and component jobs preserve the unit environment and diagnostics without serializing each other', () => {
  const core = jobs.core, managed = jobs.managed
  assert.equal(core.needs, 'native-test-resources')
  assert.equal(managed.needs, core.needs)
  const run = (job, command) => job.steps.find(step => step.run === command)
  const components = run(core, 'npm run test:unit:components')
  const tests = run(managed, 'npm run test:managed')
  assert.ok(components)
  assert.ok(tests)
  assert.deepEqual(tests.env, components.env)
  assert.equal(tests.env.LD_LIBRARY_PATH, '${{ runner.temp }}/heif-test/prefix/lib')
  assert.equal(tests.env.FOXWARM_TEST_ARTIFACT_DIR, '${{ runner.temp }}/foxwarm-test-artifacts')
  for (const job of [core, managed]) {
    assert.ok(job.steps.some(step => step.run === 'npm run build'))
    assert.equal(job.steps.some(step => step.run === 'npm run test:unit'), false)
  }
  assert.equal(managed.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0)
  const upload = job => job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload(managed).if, '${{ failure() || cancelled() }}')
  assert.deepEqual({ ...upload(managed).with, name: upload(core).with.name }, upload(core).with)
  assert.notEqual(upload(managed).with.name, upload(core).with.name)
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
})
