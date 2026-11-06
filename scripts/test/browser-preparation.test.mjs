import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import testEnvironment from './test-process-env.cjs'

testEnvironment.initializeTestEnvironment()
const script = new URL('./prepare-browser.mjs', import.meta.url)
const required = ['out/nls.messages.js', 'out/vs/workbench/workbench.web.main.internal.css', 'out/vs/workbench/workbench.web.main.internal.js']

async function fixture({ prepared = false, fail = '', incomplete = false, damage = '', args = [] } = {}, check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-preparation-'))
  const entry = path.join(root, 'scripts/test/prepare-browser.mjs')
  const assets = path.join(root, 'packages/vscode-web/assets/vscode-web')
  const bin = path.join(root, 'bin'), journal = path.join(root, 'calls.jsonl')
  try {
    await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.copyFile(script, entry)
    await fs.mkdir(bin)
    const sdk = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(root)},name=path.basename(process.argv[1]),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({name,args})+'\\n');if(name===${JSON.stringify(fail)})process.exit(19);if(name==='npm'){for(const file of ${JSON.stringify(incomplete ? required.slice(0, -1) : required)}){const p=path.join(${JSON.stringify(assets)},file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'prepared '+file);}}else{const project=path.basename(args[1],'.csproj');const p=path.join(root,'dotnet',project,'bin/Debug/net10.0',project+'.dll');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'owned managed build');}\n`
    for (const name of ['npm', 'dotnet']) await fs.writeFile(path.join(bin, name), sdk, { mode: 0o755 })
    if (prepared) for (const file of required) {
      const target = path.join(assets, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'retained caller resource')
    }
    if (damage) {
      const target = path.join(assets, required[0])
      await fs.rm(target)
      if (damage === 'empty') await fs.writeFile(target, '')
      if (damage === 'directory') await fs.mkdir(target)
    }
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 })
    if (result.error) throw result.error
    const text = await fs.readFile(journal, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    const calls = text.trim() ? text.trim().split('\n').map(JSON.parse) : []
    await check({ root, result, calls })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

const unix = { skip: process.platform === 'win32' }
test('browser preparation produces cold Code/Main/CLI/catalog fixture resources and installs them before fixture execution', unix, async () => {
  await fixture({}, async ({ root, result, calls }) => {
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls.map(call => call.name), ['npm', 'dotnet', 'dotnet', 'dotnet'])
    assert.deepEqual(calls[0].args, ['run', 'build:code'])
    for (const project of ['Foxwarm', 'Foxwarm.CliNode', 'Foxwarm.DevTools']) await fs.access(path.join(root, `dotnet/${project}/bin/Debug/net10.0/${project}.dll`))
    assert.equal(await fs.readFile(path.join(root, 'dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web', required[2]), 'utf8'), 'prepared ' + required[2])
  })
})
test('browser preparation reuses caller Code resources and fences failed managed preparation', unix, async () => {
  await fixture({ prepared: true }, async ({ root, result, calls }) => {
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(calls.map(call => call.name), ['dotnet', 'dotnet', 'dotnet'])
    assert.equal(await fs.readFile(path.join(root, 'dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web', required[2]), 'utf8'), 'retained caller resource')
  })
  await fixture({ prepared: true, fail: 'dotnet' }, ({ result, calls }) => {
    assert.equal(result.status, 1); assert.equal(calls.length, 1)
  })
})
test('browser preparation rejects failed or incomplete optional-asset production before managed builds', unix, async () => {
  for (const options of [{ fail: 'npm' }, { incomplete: true }]) await fixture(options, ({ result, calls }) => {
    assert.equal(result.status, 1); assert.deepEqual(calls.map(call => call.name), ['npm'])
  })
})

test('shared Code producer builds only assets on a cold checkout and reuses a warm restore', unix, async () => {
  await fixture({ args: ['--code-only'] }, ({ result, calls }) => {
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [{ name: 'npm', args: ['run', 'build:code'] }])
  })
  for (const mode of ['--code-only', '--check-code']) {
    await fixture({ prepared: true, args: [mode] }, ({ result, calls }) => {
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(calls, [])
    })
  }
})

test('cache consumption rejects absent, partial, empty and non-file assets without downloading', unix, async () => {
  for (const options of [{}, ...['missing', 'empty', 'directory'].map(damage => ({ prepared: true, damage }))]) {
    await fixture({ ...options, args: ['--check-code'] }, ({ result, calls }) => {
      assert.equal(result.status, 1)
      assert.match(result.stderr, /required browser assets/)
      assert.deepEqual(calls, [])
    })
  }
})

test('Code-only producer failures and invalid modes cannot proceed to managed builds', unix, async () => {
  for (const options of [{ fail: 'npm' }, { incomplete: true }]) {
    await fixture({ ...options, args: ['--code-only'] }, ({ result, calls }) => {
      assert.equal(result.status, 1)
      assert.deepEqual(calls.map(call => call.name), ['npm'])
    })
  }
  await fixture({ args: ['--check-code', '--code-only'] }, ({ result, calls }) => {
    assert.equal(result.status, 1)
    assert.deepEqual(calls, [])
  })
})
