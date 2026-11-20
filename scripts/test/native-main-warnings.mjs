#!/usr/bin/env node
// Compares the NativeAOT compiler's trim/AOT warnings from a Main publish log
// with the reviewed first-party baseline. Usage:
//   node scripts/test/native-main-warnings.mjs <publish-log> [--write-baseline]
// The log is MSBuild text output (console or file logger) of
// `dotnet publish dotnet/Foxwarm/Foxwarm.csproj -r linux-x64 -p:PublishAot=true`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const baselinePath = path.join(repoRoot, 'scripts/test/native-main-warnings.baseline')

const ilcLine = /^(?<path>\S.*?)(?:\((?<line>\d+)\))?: (?:Trim|AOT) analysis warning (?<code>IL\d+): (?<caller>.*?): (?<message>.*?)(?: \[[^\]]+\])?$/
const usingMember = /Using member '([^']+)'/

// Ordinals of compiler-generated lambdas, closures, state machines and local
// functions shift with unrelated edits in the same type.
const generatedNames = [
  [/b__\d+_\d+/g, 'b__N'],
  [/DisplayClass\d+_\d+/g, 'DisplayClassN'],
  [/d__\d+/g, 'd__N'],
  [/(g__\w+)\|\d+_\d+/g, '$1|N'],
]

// Runtime-safe by construction, so they do not need individual review:
// - Every ASP.NET host in Main configures its HTTP JSON options with
//   MainJsonContext, which has JSON DOM metadata, and these callers pass DOM values.
// - JsonArray.Add<T> uses a JsonNode argument directly; only non-node values
//   need runtime serializer metadata (for example Add<String>).
const domSafe = [
  /^Microsoft\.AspNetCore\.Http\.Results\.Json<Json(?:Node|Object|Array)>\(/,
  /^Microsoft\.AspNetCore\.Http\.HttpResponseJsonExtensions\.WriteAsJsonAsync<Json(?:Node|Object|Array)>\(/,
  /^System\.Text\.Json\.Nodes\.JsonArray\.Add<Json(?:Node|Object|Array|Value)>\(/,
]

export function normalizeCaller(caller) {
  let result = caller
  for (const [pattern, replacement] of generatedNames) result = result.replace(pattern, replacement)
  return result
}

function relativeSource(file) {
  const normalized = file.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/dotnet/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

// First-party means maintained Foxwarm C# source. The pinned upstream LanceDB
// source is generated build input below obj/ and stays with the binding unit.
export function isFirstParty(source) {
  return /^dotnet\/Foxwarm[^/]*\//.test(source) && !/^dotnet\/[^/]+\/obj\//.test(source)
}

export function parseWarnings(text) {
  const keys = new Map()
  const other = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // IL2104/IL3053 summarize collapsed warnings of a whole referenced assembly.
    if (!/ analysis warning IL\d+|: warning IL(?:2104|3053): /.test(line)) continue
    const match = ilcLine.exec(line)
    if (!match || !/[\\/]/.test(match.groups.path)) {
      other.add(line.replace(/ \[[^\]]+\]$/, ''))
      continue
    }
    const source = relativeSource(match.groups.path)
    const member = usingMember.exec(match.groups.message)?.[1] || match.groups.message
    const key = [match.groups.code, source, normalizeCaller(match.groups.caller), member].join(' | ')
    const entry = keys.get(key) || { code: match.groups.code, source, member, lines: new Set() }
    if (match.groups.line) entry.lines.add(Number(match.groups.line))
    keys.set(key, entry)
  }
  return { keys, other: [...other].sort() }
}

export function classify(text, baselineText) {
  const { keys, other } = parseWarnings(text)
  const baseline = new Set(baselineText.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')))
  const firstParty = [...keys].filter(([, entry]) => isFirstParty(entry.source))
  const reviewed = firstParty.filter(([, entry]) => !domSafe.some(pattern => pattern.test(entry.member)))
  const added = reviewed.filter(([key]) => !baseline.has(key)).map(([key, entry]) => ({ key, lines: [...entry.lines].sort((a, b) => a - b) }))
  const current = new Set(reviewed.map(([key]) => key))
  return {
    total: keys.size,
    firstParty: firstParty.length,
    domSafe: firstParty.length - reviewed.length,
    reviewed: [...current].sort(),
    added,
    stale: [...baseline].filter(key => !current.has(key)).sort(),
    nonFirstParty: [...keys].filter(([, entry]) => !isFirstParty(entry.source)).map(([key]) => key).sort(),
    other,
  }
}

async function main() {
  const [logFile, ...flags] = process.argv.slice(2)
  if (!logFile || flags.some(flag => flag !== '--write-baseline')) {
    console.error('Usage: native-main-warnings.mjs <publish-log> [--write-baseline]')
    process.exit(2)
  }
  const text = fs.readFileSync(logFile, 'utf8')
  // An empty or truncated log must not pass as warning-free.
  if (!/^\s*Foxwarm -> /m.test(text)) {
    console.error(`${logFile} does not contain a completed Foxwarm publish.`)
    process.exit(2)
  }
  const existing = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : ''
  const result = classify(text, existing)
  if (flags.includes('--write-baseline')) {
    const header = existing.split(/\r?\n/).filter(line => line.startsWith('#'))
    fs.writeFileSync(baselinePath, `${[...header, ...result.reviewed].join('\n')}\n`)
    console.log(`Wrote ${result.reviewed.length} reviewed first-party warning keys to ${path.relative(repoRoot, baselinePath)}.`)
    return
  }
  console.log(`NativeAOT warnings: ${result.total} distinct; first-party ${result.firstParty} (${result.domSafe} JSON DOM-safe, ${result.reviewed.length} reviewed); other ${result.nonFirstParty.length + result.other.length}.`)
  for (const key of result.stale) console.log(`Baseline entry no longer reported (remove it): ${key}`)
  if (result.added.length) {
    console.error('New first-party NativeAOT warnings. Fix the caller (MainJsonContext metadata, JsonData, or a JSON DOM overload);')
    console.error('add a reviewed baseline entry only when the call is runtime-safe under NativeAOT:')
    for (const { key, lines } of result.added) console.error(`  ${key}${lines.length ? ` (line ${lines.join(', ')})` : ''}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
