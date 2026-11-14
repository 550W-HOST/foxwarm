import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkNativeLibraries } from './check-native-libraries.mjs'

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-native-check-'))
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function layout(native, payload, { library = 'built-lancedb', worker = 'built-worker' } = {}) {
  write(path.join(native, 'liblancedb_ffi.so'), 'built-lancedb')
  write(path.join(native, 'monty'), 'built-worker')
  for (const name of ['LanceDB-native-crates.txt', 'Monty-native-crates.txt']) write(path.join(payload, name), 'licenses')
  write(path.join(payload, 'liblancedb_ffi.so'), library)
  write(path.join(payload, 'ToolScript/native/monty'), worker)
  fs.chmodSync(path.join(payload, 'ToolScript/native/monty'), 0o755)
}

test('a package with the built libraries and licence files passes', () => {
  const native = directory()
  const payload = directory()
  layout(native, payload)
  assert.deepEqual(checkNativeLibraries(payload, native), [])
})

test('a package with the LanceDB package library or the official worker fails', () => {
  const native = directory()
  const payload = directory()
  layout(native, payload, { library: 'nuget-lancedb', worker: 'official-worker' })
  const problems = checkNativeLibraries(payload, native)
  assert.equal(problems.length, 2)
  assert.match(problems.join('\n'), /liblancedb_ffi\.so is not the liblancedb_ffi\.so/)
})

test('missing licence files, missing libraries and libraries of another platform are reported', () => {
  const native = directory()
  const payload = directory()
  layout(native, payload)
  fs.rmSync(path.join(payload, 'LanceDB-native-crates.txt'))
  fs.rmSync(path.join(payload, 'ToolScript/native/monty'))
  write(path.join(payload, 'lancedb_ffi.dll'), 'other')
  const problems = checkNativeLibraries(payload, native).join('\n')
  assert.match(problems, /no \S*monty\b/)
  assert.match(problems, /no LanceDB-native-crates\.txt/)
  assert.match(problems, /lancedb_ffi\.dll, which the build output lacks/)
})

test('a re-signed bundle may differ in content within a size tolerance only', () => {
  const native = directory()
  const payload = directory()
  layout(native, payload, { library: 'built-lancedb+signature', worker: 'built-worker+signature' })
  assert.equal(checkNativeLibraries(payload, native).length, 2)
  assert.deepEqual(checkNativeLibraries(payload, native, true), [])
  write(path.join(payload, 'liblancedb_ffi.so'), Buffer.alloc(2 * 1024 * 1024))
  assert.equal(checkNativeLibraries(payload, native, true).length, 1)
})

test('a worker without the executable bit is reported', { skip: process.platform === 'win32' }, () => {
  const native = directory()
  const payload = directory()
  layout(native, payload)
  fs.chmodSync(path.join(payload, 'ToolScript/native/monty'), 0o644)
  assert.match(checkNativeLibraries(payload, native).join('\n'), /is not executable/)
})
