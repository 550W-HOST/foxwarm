#!/usr/bin/env node
// Foxwarm HTTP assets. Offsets are relative to the data section after the UTF-8 index.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const magic = Buffer.from('FWASSET1')
const headerLength = 16
const maxIndex = 64 * 1024 * 1024
const root = path.resolve(import.meta.dirname, '..')
export const packName = 'foxwarm.assets'
export const codePrefix = 'packages/vscode-web/assets'
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.txt': 'text/plain', '.md': 'text/plain', '.xml': 'application/xml', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
}
export function validPath(name) {
  return typeof name === 'string' && name.length > 0 && !/[\\:\x00-\x1f]/.test(name)
    && name.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function files(source, prefix, result) {
  if (!validPath(prefix)) throw Error(`Invalid asset path: ${prefix}`)
  const stat = fs.lstatSync(source)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source).sort()) files(path.join(source, name), `${prefix}/${name}`, result)
  } else if (stat.isFile()) {
    if (result.has(prefix)) throw Error(`Duplicate asset path: ${prefix}`)
    result.set(prefix, source)
  } else throw Error(`Asset is not a regular file or directory: ${source}`)
}

export function writePack(output, sources, { quality = 9 } = {}) {
  const inputs = new Map()
  for (const { source, prefix } of sources) files(source, prefix, inputs)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const dataFile = output + '.data'
  const data = fs.openSync(dataFile, 'w')
  let offset = 0
  const entries = Object.create(null)
  try {
    for (const [name, source] of [...inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const bytes = fs.readFileSync(source)
      const contentType = types[path.extname(name).toLowerCase()] || 'application/octet-stream'
      // Keep a single representation. Already-compressed formats remain raw.
      let stored = bytes
      if (bytes.length >= 1024 && /^(?:text\/|application\/(?:json|xml|wasm)|image\/svg)/.test(contentType)) {
        const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
        if (compressed.length + 64 < bytes.length * 0.95) stored = compressed
      }
      entries[name] = { offset, length: stored.length, originalLength: bytes.length,
        sha256: digest(bytes), contentType, ...(stored !== bytes ? { encoding: 'br' } : {}) }
      fs.writeFileSync(data, stored)
      offset += stored.length
    }
    const index = Buffer.from(JSON.stringify({ entries }))
    if (index.length > maxIndex) throw Error('Asset index exceeds 64 MiB')
    const header = Buffer.alloc(headerLength)
    magic.copy(header); header.writeBigUInt64LE(BigInt(index.length), 8)
    const destination = fs.openSync(output, 'w')
    const input = fs.openSync(dataFile, 'r')
    try {
      fs.writeFileSync(destination, header); fs.writeFileSync(destination, index)
      const buffer = Buffer.alloc(1024 * 1024)
      for (;;) {
        const count = fs.readSync(input, buffer)
        if (!count) break
        fs.writeSync(destination, buffer, 0, count)
      }
    } finally { fs.closeSync(input); fs.closeSync(destination) }
    return { entries: inputs.size, bytes: headerLength + index.length + offset }
  } finally { fs.closeSync(data); fs.rmSync(dataFile, { force: true }) }
}

export function codeSources(source = path.join(root, codePrefix)) {
  return ['vscode-web', 'extensions/redhat.vscode-yaml'].map(name => ({ source: path.join(source, name), prefix: `${codePrefix}/${name}` }))
}
export function applicationSources({ code = false } = {}) {
  const sources = [
    { source: path.join(root, 'packages/webui/dist'), prefix: 'webui-dist' },
    { source: path.join(root, 'packages/webui/public/login.html'), prefix: 'packages/webui/login.html' },
  ]
  for (const name of ['foxwarm-fs', 'foxwarm-scm', 'foxwarm-terminal', 'foxwarm-webui']) {
    for (const entry of ['package.json', 'dist', 'media']) {
      const prefix = `packages/vscode-web/${name}/${entry}`
      const source = path.join(root, prefix)
      if (entry !== 'media' || fs.existsSync(source)) sources.push({ source, prefix })
    }
  }
  return code ? sources.concat(codeSources()) : sources
}

// Debugging/qualification reader; Main's positional-stream reader owns runtime serving.
export function readPack(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const header = Buffer.alloc(headerLength)
    if (fs.readSync(fd, header) !== headerLength || !header.subarray(0, 8).equals(magic)) throw Error('Invalid asset pack header')
    const length = Number(header.readBigUInt64LE(8))
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxIndex || length > size - headerLength) throw Error('Invalid asset index length')
    const bytes = Buffer.alloc(length)
    if (fs.readSync(fd, bytes) !== length) throw Error('Truncated asset index')
    const entries = JSON.parse(bytes).entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('Invalid asset index')
    const start = headerLength + length
    for (const [name, item] of Object.entries(entries)) {
      if (!validPath(name) || typeof item.contentType !== 'string' || /[\r\n]/.test(item.contentType)) throw Error('Invalid asset entry')
      if (item.encoding !== undefined && item.encoding !== 'br') throw Error('Invalid asset encoding')
      if (!Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.length) || !Number.isSafeInteger(item.originalLength)
        || item.offset < 0 || item.length < 0 || item.originalLength < 0 || item.offset > size - start - item.length
        || (!item.encoding && item.originalLength !== item.length) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid asset extent')
    }
    return {
      entries,
      read(name) {
        const entry = entries[name]
        if (!entry) throw Error(`Missing asset: ${name}`)
        const output = Buffer.alloc(entry.length)
        if (fs.readSync(fd, output, 0, output.length, start + entry.offset) !== output.length) throw Error(`Truncated asset: ${name}`)
        const bytes = entry.encoding === 'br' ? brotliDecompressSync(output) : output
        if (bytes.length !== entry.originalLength || digest(bytes) !== entry.sha256) throw Error(`Corrupt asset: ${name}`)
        return bytes
      },
      close() { fs.closeSync(fd) },
    }
  } catch (error) { fs.closeSync(fd); throw error }
}
export function extractPack(file, destination) {
  const pack = readPack(file)
  try {
    // An empty owned destination prevents extraction through pre-existing symlinks.
    if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw Error('Extract destination must be empty')
    fs.mkdirSync(destination, { recursive: true })
    for (const name of Object.keys(pack.entries)) {
      const output = path.join(destination, name)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, pack.read(name), { flag: 'wx' })
    }
  } finally { pack.close() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file, target] = process.argv.slice(2)
  if (command === 'build' && file) console.log(writePack(file, applicationSources({ code: target === '--code' })))
  else if (command === 'inspect' && file) {
    const pack = readPack(file)
    try { console.log(JSON.stringify(pack.entries, null, 2)) } finally { pack.close() }
  } else if (command === 'extract' && file && target) extractPack(file, target)
  else { console.error('Usage: node scripts/asset-pack.mjs build OUTPUT [--code] | inspect PACK | extract PACK EMPTY_DIRECTORY'); process.exitCode = 2 }
}
