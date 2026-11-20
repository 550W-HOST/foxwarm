import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { writePack, readPack, extractPack, validPath } from './asset-pack.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), pack = path.join(root, 'foxwarm.assets')
  fs.mkdirSync(source)
  const values = { 'app.js': Buffer.from('export const hello = "compressed text";\n'.repeat(500)), 'image.png': randomBytes(4096), 'empty.txt': Buffer.alloc(0) }
  for (const [name, bytes] of Object.entries(values)) fs.writeFileSync(path.join(source, name), bytes)
  const build = () => writePack(pack, [{ source, prefix: 'webui-dist/assets' }])
  return { root, source, pack, values, build }
}

test('writer keeps one stored representation, original metadata and deterministic output; extraction restores all bytes', t => {
  const f = fixture(t), summary = f.build(), first = fs.readFileSync(f.pack)
  assert.equal(summary.entries, 3)
  f.build(); assert.deepEqual(fs.readFileSync(f.pack), first)
  const pack = readPack(f.pack)
  try {
    for (const [name, bytes] of Object.entries(f.values)) {
      const key = 'webui-dist/assets/' + name, entry = pack.entries[key]
      assert.equal(entry.originalLength, bytes.length)
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.deepEqual(pack.read(key), bytes)
    }
    assert.equal(pack.entries['webui-dist/assets/app.js'].encoding, 'br')
    assert(pack.entries['webui-dist/assets/app.js'].length < f.values['app.js'].length / 2)
    assert.equal(pack.entries['webui-dist/assets/image.png'].encoding, undefined)
    assert.equal(pack.entries['webui-dist/assets/empty.txt'].length, 0)
  } finally { pack.close() }
  const output = path.join(f.root, 'extracted'); extractPack(f.pack, output)
  for (const [name, bytes] of Object.entries(f.values)) assert.deepEqual(fs.readFileSync(path.join(output, 'webui-dist/assets', name)), bytes)
  assert.throws(() => extractPack(f.pack, output), /must be empty/)
})

test('writer rejects ambiguous paths, duplicate entries and symlink inputs', t => {
  const f = fixture(t)
  for (const value of ['', '/root', '../root', 'a/../b', 'a//b', 'a\\b', 'C:/root', 'a\u0000b']) assert.equal(validPath(value), false)
  assert.throws(() => writePack(f.pack, [{ source: f.source, prefix: '../outside' }]), /Invalid asset path/)
  const input = { source: f.source, prefix: 'assets' }
  assert.throws(() => writePack(f.pack, [input, input]), /Duplicate asset path/)
  if (process.platform !== 'win32') {
    fs.symlinkSync(f.source, path.join(f.root, 'link'))
    assert.throws(() => writePack(f.pack, [{ source: path.join(f.root, 'link'), prefix: 'assets' }]), /not a regular/)
  }
})

test('reader rejects invalid bounds and traversal before extraction, and checks original content hashes', t => {
  const f = fixture(t); f.build()
  const original = fs.readFileSync(f.pack), size = Number(original.readBigUInt64LE(8))
  const index = JSON.parse(original.subarray(16, 16 + size)), data = original.subarray(16 + size)
  const replace = entries => {
    const json = Buffer.from(JSON.stringify({ entries })), header = Buffer.from(original.subarray(0, 16))
    header.writeBigUInt64LE(BigInt(json.length), 8)
    fs.writeFileSync(f.pack, Buffer.concat([header, json, data]))
  }
  const entry = index.entries['webui-dist/assets/image.png']
  replace({ '../escaped': entry }); assert.throws(() => extractPack(f.pack, path.join(f.root, 'out')), /Invalid asset entry/)
  assert(!fs.existsSync(path.join(f.root, 'escaped')))
  replace({ image: { ...entry, offset: data.length } }); assert.throws(() => readPack(f.pack), /Invalid asset extent/)
  replace({ image: { ...entry, sha256: '0'.repeat(64) } })
  const pack = readPack(f.pack)
  try { assert.throws(() => pack.read('image'), /Corrupt asset/) } finally { pack.close() }
})
