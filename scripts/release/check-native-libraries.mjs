#!/usr/bin/env node
// Check that an extracted package ships the libraries the release workflow built from pinned,
// patched source (scripts/release/build-lancedb.sh, build-monty.sh) and not the LanceDB package's
// or the official worker: every copy of the LanceDB library and the ToolScript worker in the
// package must be byte-identical to the one in the build output, and the crate licence files
// must be present.
// Usage: check-native-libraries.mjs EXTRACTED_PACKAGE NATIVE_DIRECTORY [--resigned]
//   --resigned: the package is code-signed after the build (the macOS app bundle), so the
//   signature may change the file; the size must then stay within 1 MiB of the build output.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const libraries = ['liblancedb_ffi.so', 'lancedb_ffi.dll', 'liblancedb_ffi.dylib', 'monty', 'monty.exe']
const licenses = ['LanceDB-native-crates.txt', 'Monty-native-crates.txt']

function* files(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* files(file)
    else if (entry.isFile()) yield file
  }
}

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export function checkNativeLibraries(payload, native, resigned = false) {
  const problems = []
  const built = new Map(libraries.filter(name => fs.existsSync(path.join(native, name))).map(name => [name, path.join(native, name)]))
  if (built.size !== 2) problems.push(`${native} should hold the LanceDB library and the worker, found: ${[...built.keys()].join(', ') || 'nothing'}`)
  const found = new Map()
  const names = new Set()
  for (const file of files(payload)) {
    const name = path.basename(file)
    names.add(name)
    const expected = built.get(name)
    if (!expected) continue
    found.set(name, (found.get(name) ?? 0) + 1)
    if (resigned) {
      const delta = Math.abs(fs.statSync(file).size - fs.statSync(expected).size)
      if (delta > 1024 * 1024) problems.push(`${path.relative(payload, file)} differs from the built ${name} by ${delta} bytes`)
    } else if (digest(file) !== digest(expected)) {
      problems.push(`${path.relative(payload, file)} is not the ${name} the release workflow built`)
    }
  }
  for (const name of built.keys()) if (!found.has(name)) problems.push(`The package has no ${name}`)
  // A library other than the built ones, for another RID, would also be a package mix-up.
  for (const name of libraries) if (names.has(name) && !built.has(name)) problems.push(`The package has ${name}, which the build output lacks`)
  for (const name of licenses) if (!names.has(name)) problems.push(`The package has no ${name}`)
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [payload, native, ...options] = process.argv.slice(2)
  if (!payload || !native) {
    console.error('Usage: check-native-libraries.mjs EXTRACTED_PACKAGE NATIVE_DIRECTORY [--resigned]')
    process.exit(2)
  }
  const problems = checkNativeLibraries(path.resolve(payload), path.resolve(native), options.includes('--resigned'))
  for (const line of problems) console.error(line)
  if (problems.length) process.exit(1)
  console.log(`${payload} ships the libraries built from pinned source.`)
}
