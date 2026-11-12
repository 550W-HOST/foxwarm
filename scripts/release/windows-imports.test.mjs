import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { addVcRuntime, missingImports, peImports, windowsSystemDll } from './windows-imports.mjs'

// A minimal PE32+ image with one section holding its import and delay-import tables.
function image({ imports = [], delayed = [], managed = false } = {}) {
  const bytes = Buffer.alloc(0x600)
  bytes.write('MZ', 0, 'latin1')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'latin1')
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(0xf0, 0x94)
  const optional = 0x98
  bytes.writeUInt16LE(0x20b, optional)
  bytes.writeBigUInt64LE(0x140000000n, optional + 24)
  bytes.writeUInt32LE(16, optional + 108)
  const directory = (index, rva, size) => { bytes.writeUInt32LE(rva, optional + 112 + index * 8); bytes.writeUInt32LE(size, optional + 116 + index * 8) }
  const section = optional + 0xf0
  bytes.writeUInt32LE(0x400, section + 8)
  bytes.writeUInt32LE(0x1000, section + 12)
  bytes.writeUInt32LE(0x400, section + 16)
  bytes.writeUInt32LE(0x200, section + 20)
  const at = rva => rva - 0x1000 + 0x200
  let strings = 0x1200
  const string = text => { const rva = strings; bytes.write(text + '\0', at(rva), 'latin1'); strings += text.length + 1; return rva }
  imports.forEach((name, index) => bytes.writeUInt32LE(string(name), at(0x1000) + index * 20 + 12))
  if (imports.length) directory(1, 0x1000, (imports.length + 1) * 20)
  delayed.forEach((name, index) => {
    bytes.writeUInt32LE(1, at(0x1100) + index * 32)
    bytes.writeUInt32LE(string(name), at(0x1100) + index * 32 + 4)
  })
  if (delayed.length) directory(13, 0x1100, (delayed.length + 1) * 32)
  if (managed) directory(14, 0x1000, 72)
  return bytes
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-imports-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

test('PE imports include delay-loaded DLLs; managed assemblies and other files have none', () => {
  assert.deepEqual(peImports(image({ imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'], delayed: ['bcrypt.dll', 'ws2_32.dll'] })),
    ['KERNEL32.dll', 'VCRUNTIME140.dll', 'bcrypt.dll', 'ws2_32.dll'])
  assert.equal(peImports(image({ imports: ['mscoree.dll'], managed: true })), null)
  assert.equal(peImports(Buffer.from('#!/bin/sh\n')), null)
})

test('the Visual C++ runtime is copied beside each importer, with its own dependencies', t => {
  const work = scratch(t), payload = path.join(work, 'payload'), runtime = path.join(work, 'crt')
  write(path.join(payload, 'lancedb_ffi.dll'), image({ imports: ['KERNEL32.dll', 'VCRUNTIME140_1.dll'] }))
  write(path.join(payload, 'ToolScript/native/monty.exe'), image({ imports: ['kernel32.dll', 'vcruntime140.dll'] }))
  write(path.join(payload, 'node_modules/addon/addon.node'), image({ imports: ['node.exe', 'api-ms-win-crt-heap-l1-1-0.dll'] }))
  write(path.join(payload, 'Foxwarm.dll'), image({ imports: ['mscoree.dll'], managed: true }))
  write(path.join(runtime, 'vcruntime140.dll'), image({ imports: ['KERNEL32.dll'] }))
  write(path.join(runtime, 'vcruntime140_1.dll'), image({ imports: ['VCRUNTIME140.dll'] }))
  write(path.join(runtime, 'msvcp140.dll'), image({ imports: ['VCRUNTIME140.dll'] }))
  const system = path.join(work, 'System32')
  for (const name of ['kernel32.dll', 'vcruntime140.dll']) write(path.join(system, name), Buffer.alloc(1))
  const isSystem = windowsSystemDll(system)
  assert(!isSystem('vcruntime140.dll'), 'An installed Visual C++ runtime is not part of Windows')
  assert.deepEqual(missingImports(payload, isSystem).sort(), [
    `${path.join('ToolScript', 'native', 'monty.exe')}: vcruntime140.dll`, 'lancedb_ffi.dll: VCRUNTIME140_1.dll'])
  assert.deepEqual(addVcRuntime(payload, runtime), [path.join('ToolScript', 'native', 'vcruntime140.dll'), 'vcruntime140.dll', 'vcruntime140_1.dll'])
  assert.deepEqual(missingImports(payload, isSystem), [])
  assert(!fs.existsSync(path.join(payload, 'msvcp140.dll')), 'Only imported runtime DLLs are shipped')
})
