import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-model-catalog-test-'))

async function load(entry, name) {
  const outfile = path.join(tempDir, `${name}.cjs`)
  await esbuild.build({
    entryPoints: [path.join(webuiRoot, entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}

const { addCatalogRow, moveCatalogRow, readModelCatalog, writeModelCatalog } = await load('src/modelCatalog.ts', 'catalog')
const { selectableModelKeys } = await load('src/modelsYamlCompletions.ts', 'completions')
const { buildModelSetupYaml, readModelSetupForm, removeModel, renameCatalogProvider, validateModelSetupForm } = await load('src/setupModels.ts', 'setup')

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const MULTI = `# Providers
default: strong/a
providers:
  strong:
    providerType: openai-responses
    models: [a, b]
  fast:
    providerType: openai-responses
    models: [f1]
  quick: fast
catalog:
  quick: Fast exploration
  strong/a: Deep work
`

test('catalog rows are read in document order', () => {
  assert.deepEqual(readModelCatalog(MULTI), {
    ok: true,
    rows: [
      { key: 'quick', description: 'Fast exploration' },
      { key: 'strong/a', description: 'Deep work' },
    ],
  })
  assert.deepEqual(readModelCatalog('providers: {}\n'), { ok: true, rows: [] })
  assert.deepEqual(readModelCatalog(''), { ok: true, rows: [] })
  assert.equal(readModelCatalog('providers: [').ok, false)
  assert.equal(readModelCatalog('catalog: [a]\n').ok, false)
  assert.equal(readModelCatalog('catalog:\n  a: 3\n').ok, false)
})

test('writing the catalog keeps comments and other content and round-trips order and punctuation', () => {
  const rows = [
    { key: 'strong/b', description: 'Needs "quotes": colons, and a very long description '.repeat(4).trim() },
    { key: 'quick', description: 'Fast exploration' },
  ]
  const written = writeModelCatalog(MULTI, rows)
  assert.match(written, /# Providers/)
  assert.match(written, /models: \[ ?a, b ?\]/)
  assert.deepEqual(readModelCatalog(written), { ok: true, rows })
  assert.equal(written.split('\n').filter((line) => line.includes('Needs')).length, 1)
})

test('writing an empty list removes the catalog and adds one to a document without it', () => {
  const removed = writeModelCatalog(MULTI, [])
  assert.doesNotMatch(removed, /catalog/)
  assert.match(removed, /# Providers/)
  const added = writeModelCatalog(removed, [{ key: 'quick', description: 'Fast' }])
  assert.deepEqual(readModelCatalog(added), { ok: true, rows: [{ key: 'quick', description: 'Fast' }] })
  assert.equal(writeModelCatalog('providers: [', [{ key: 'a', description: 'b' }]), 'providers: [')
  assert.equal(writeModelCatalog(MULTI, [{ key: 'a', description: 'x' }, { key: 'a', description: 'y' }]), MULTI)
})

test('selectable keys are stable qualified keys followed by aliases and virtual routes', () => {
  assert.deepEqual(selectableModelKeys(MULTI), ['strong/a', 'strong/b', 'fast/f1', 'quick'])
})

test('rows can be added with unused keys and reordered', () => {
  const rows = [{ key: 'a', description: 'one' }, { key: 'b', description: 'two' }]
  assert.deepEqual(addCatalogRow(rows, ['a', 'b', 'c']), [...rows, { key: 'c', description: '' }])
  assert.deepEqual(addCatalogRow(rows, ['a', 'b']), rows)
  assert.deepEqual(moveCatalogRow(rows, 0, 1).map((row) => row.key), ['b', 'a'])
  assert.deepEqual(moveCatalogRow(rows, 0, -1).map((row) => row.key), ['a', 'b'])
  assert.deepEqual(moveCatalogRow(rows, 1, 1).map((row) => row.key), ['a', 'b'])
})

const SINGLE = `default: "leaf/model-a"
providers:
  leaf:
    providerType: "openai-completions"
    baseUrl: "https://gateway.example.test/v1"
    apiKey: "secret"
    models:
      - "model-a"
      - "model-b"
catalog:
  "leaf/model-b": "Cheap exploration"
`

test('the single-provider form carries the catalog through reads and rewrites', () => {
  const reading = readModelSetupForm(SINGLE)
  assert.equal(reading.ok, true)
  assert.deepEqual(reading.form.catalog, [{ key: 'leaf/model-b', description: 'Cheap exploration' }])
  assert.equal(buildModelSetupYaml(reading.form), SINGLE)
  assert.equal(validateModelSetupForm(reading.form), null)
  const renamed = { ...reading.form, providerId: 'other', catalog: renameCatalogProvider(reading.form.catalog, 'leaf', 'other') }
  assert.deepEqual(renamed.catalog, [{ key: 'other/model-b', description: 'Cheap exploration' }])
  assert.equal(readModelSetupForm(buildModelSetupYaml(renamed)).ok, true)
})

test('removing a model drops its recommendation and a dangling one blocks the form save', () => {
  const { form } = readModelSetupForm(SINGLE)
  const removed = removeModel(form, 'model-b')
  assert.equal(removed.catalog, undefined)
  assert.doesNotMatch(buildModelSetupYaml(removed), /catalog/)
  const dangling = { ...form, catalog: [{ key: 'leaf/gone', description: 'x' }] }
  assert.match(validateModelSetupForm(dangling), /no longer configured/)
  const empty = { ...form, catalog: [{ key: 'leaf/model-a', description: ' ' }] }
  assert.match(validateModelSetupForm(empty), /Add a description/)
})
