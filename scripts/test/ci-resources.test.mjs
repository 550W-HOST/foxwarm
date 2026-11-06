import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
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

test('resource cache keys change with pins, build inputs and runner/toolchain configuration', async () => {
  const code = await keyInputs(codeProducer)
  const heif = await keyInputs(jobs['native-test-resources'])
  for (const [inputs, required] of [[code, [
    'packages/vscode-web/code-oss-version.json',
    'packages/vscode-web/yaml-extension-version.json',
    'packages/vscode-web/scripts/build-code-oss.mjs',
    'packages/vscode-web/scripts/build-code-docker.mjs',
    'packages/vscode-web/scripts/yaml-extension-assets.mjs',
    'packages/vscode-web/Dockerfile.code-oss',
    'packages/vscode-web/package.json',
    'package.json',
    'package-lock.json',
    'scripts/test/prepare-browser.mjs',
    'scripts/release/package.mjs',
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
})

test('only resource producers build pins; consumers require the exact validated cache', () => {
  for (const [producerId, consumerIds] of [
    ['native-test-resources', ['core', 'chromium']],
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

test('Tests and Release reuse one cache-backed Code producer and consume its per-run archive', () => {
  assert.equal(jobs['code-resources'].uses, './.github/workflows/code-resources.yml')
  assert.equal(release.jobs['code-resources'].uses, jobs['code-resources'].uses)
  assert.ok(jobs.chromium.needs.includes('code-resources'))
  assert.equal(release.jobs.packages.needs, 'code-resources')
  const cache = restore(codeProducer)[0]
  assert.equal(cache.with['restore-keys'], undefined)
  assert.equal(cache.with['fail-on-cache-miss'], undefined)
  const build = codeProducer.steps.find(step => step.run?.includes('--code-only') && step.run.includes('prepare-browser'))
  assert.equal(build.if, "${{ steps.cache.outputs.cache-hit != 'true' }}")
  const uploaded = codeProducer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(uploaded.with.name, 'code-resources')
  const packaged = codeProducer.steps.findIndex(step => step.run?.includes('package.mjs --code-only'))
  assert.ok(packaged > codeProducer.steps.indexOf(build))
  assert.ok(packaged < codeProducer.steps.indexOf(uploaded))
  for (const job of [jobs.chromium, release.jobs.packages]) {
    const download = job.steps.find(step => step.uses?.startsWith('actions/download-artifact@') && step.with.name === uploaded.with.name)
    assert.ok(download)
    const extraction = job.steps.find(step => step.run?.includes('tar -xzf') && step.run.includes('foxwarm-code-'))
    assert.ok(job.steps.indexOf(download) < job.steps.indexOf(extraction))
    assert.ok(!job.steps.some(step => /build:code|prepare-browser.mjs --code-only/.test(step.run || '')))
  }
})
