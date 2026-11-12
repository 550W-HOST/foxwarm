#!/usr/bin/env node
// DLL imports of the native Windows binaries in a server package, and the app-local Visual C++
// runtime they need. Windows resolves an import from the importing binary's own directory
// (the application directory for an executable; .NET loads native libraries by full path, so
// their directory is searched first) and then the system directories. The Visual C++ runtime
// is not part of Windows, so a package must ship each runtime DLL beside every binary that
// imports it.
// Usage: windows-imports.mjs EXTRACTED_PACKAGE
//   Fails when a binary imports a DLL that is neither beside it nor a Windows system DLL.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const binary = /\.(dll|exe|node)$/i
// Visual C++ runtime families: present on many machines, but never part of Windows itself.
export const vcRuntime = /^(vcruntime|msvcp|concrt|vccorlib|vcomp|vcamp|mfc)\d/i

// Imported DLL names of a PE image, including delay-loaded ones; null for files that are not
// PE images and for managed assemblies, whose imports CoreCLR resolves.
export function peImports(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null
  const pe = bytes.readUInt32LE(0x3c)
  if (pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) return null
  const sectionCount = bytes.readUInt16LE(pe + 6)
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const optional = pe + 24
  const plus = bytes.readUInt16LE(optional) === 0x20b
  const imageBase = plus ? Number(bytes.readBigUInt64LE(optional + 24)) : bytes.readUInt32LE(optional + 28)
  const directoryCount = bytes.readUInt32LE(optional + (plus ? 108 : 92))
  const directories = optional + (plus ? 112 : 96)
  const directory = index => index < directoryCount
    ? { rva: bytes.readUInt32LE(directories + index * 8), size: bytes.readUInt32LE(directories + index * 8 + 4) }
    : { rva: 0, size: 0 }
  if (directory(14).size > 0) return null
  const sections = []
  for (let i = 0, at = optional + optionalSize; i < sectionCount; i++, at += 40) {
    sections.push({ va: bytes.readUInt32LE(at + 12), size: Math.max(bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 16)), raw: bytes.readUInt32LE(at + 20) })
  }
  const offset = rva => {
    const section = sections.find(entry => rva >= entry.va && rva < entry.va + entry.size)
    return section ? rva - section.va + section.raw : -1
  }
  const text = rva => {
    const start = offset(rva)
    if (start < 0) return null
    const end = bytes.indexOf(0, start)
    return bytes.toString('latin1', start, end < 0 ? bytes.length : end)
  }
  const names = []
  const imports = directory(1)
  for (let at = offset(imports.rva); imports.rva && at >= 0 && at + 20 <= bytes.length; at += 20) {
    const name = bytes.readUInt32LE(at + 12)
    if (!name && !bytes.readUInt32LE(at)) break
    if (text(name)) names.push(text(name))
  }
  const delayed = directory(13)
  for (let at = offset(delayed.rva); delayed.rva && at >= 0 && at + 32 <= bytes.length; at += 32) {
    let name = bytes.readUInt32LE(at + 4)
    if (!name) break
    if (!(bytes.readUInt32LE(at) & 1)) name -= imageBase
    if (text(name)) names.push(text(name))
  }
  return [...new Set(names)]
}

function* binaries(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* binaries(file)
    else if (entry.isFile() && binary.test(entry.name)) yield file
  }
}

const besides = (file, name) => fs.readdirSync(path.dirname(file)).some(entry => entry.toLowerCase() === name.toLowerCase())

// Windows' own DLLs: API sets, and other names found in the system directory except the
// Visual C++ runtime, which the build machine may have installed there. Node.js addons import
// node.exe, the process that loads them.
export function windowsSystemDll(systemDirectory = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')) {
  const present = new Set(fs.readdirSync(systemDirectory).map(name => name.toLowerCase()))
  return name => /^(api|ext)-ms-/i.test(name) || /^node\.exe$/i.test(name)
    || (!vcRuntime.test(name) && present.has(name.toLowerCase()))
}

// Imports that neither the binary's directory nor the system provides, as "binary: dll".
export function missingImports(payload, isSystem = windowsSystemDll()) {
  const missing = []
  for (const file of binaries(payload)) {
    for (const name of peImports(fs.readFileSync(file)) || []) {
      if (!besides(file, name) && !isSystem(name)) missing.push(`${path.relative(payload, file)}: ${name}`)
    }
  }
  return missing
}

// Copy the Visual C++ runtime DLLs from `runtime` beside every binary that imports them,
// including the runtime's own dependencies on each other. Returns the copied paths.
export function addVcRuntime(payload, runtime) {
  const available = new Map(fs.readdirSync(runtime).filter(name => /\.dll$/i.test(name)).map(name => [name.toLowerCase(), path.join(runtime, name)]))
  const copied = []
  for (let changed = true; changed;) {
    changed = false
    for (const file of binaries(payload)) {
      for (const name of peImports(fs.readFileSync(file)) || []) {
        const source = available.get(name.toLowerCase())
        if (!source || besides(file, name)) continue
        const target = path.join(path.dirname(file), path.basename(source))
        fs.copyFileSync(source, target)
        copied.push(path.relative(payload, target))
        changed = true
      }
    }
  }
  return copied.sort()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = process.argv[2]
  if (!payload || process.platform !== 'win32') {
    console.error('Usage on Windows: node scripts/release/windows-imports.mjs EXTRACTED_PACKAGE')
    process.exit(2)
  }
  const missing = missingImports(path.resolve(payload))
  for (const line of missing) console.error(`Missing DLL: ${line}`)
  if (missing.length) process.exit(1)
  console.log(`Every DLL imported by ${payload} is in the package or part of Windows.`)
}
