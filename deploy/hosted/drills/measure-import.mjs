#!/usr/bin/env node
// Measures `foxwarm hosted import` of a large Session document. A file-mode installation of the
// same build runs one turn against the mock model; its Session document is then grown with
// synthetic history records to each target size, and every size is imported into a fresh
// tenant through the CLI. Each document is one ReplaceRaw transaction, whose statements run
// under the transaction-local statement_timeout; PostgreSQL logs every statement above 200 ms,
// so the report has the slowest statement next to the import time.
//
//   node deploy/hosted/drills/measure-import.mjs [--sizes 9,32,64] [--log-ms 200] [--report <file>]
import { readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { processEnvironment } from './env-process.mjs'
import { mock, installModels, history, texts } from './drills.mjs'
import { apiClient, log, until } from './util.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const sizes = option('--sizes', '9,32,64').split(',').map(Number)
const logMs = Number(option('--log-ms', '200'))
const env = await processEnvironment({ postgresOptions: `-c log_min_duration_statement=${logMs}` })
const results = { sizes: [] }

// Text that compresses like prose and tool output, not like a repeated byte.
const words = 'the replica owns tenant lease epoch fence session archive segment record output build test pass error file line value node model request turn tool result'.split(' ')
let seed = 7
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const prose = length => {
  let text = ''
  while (text.length < length) text += words[Math.floor(random() * words.length)] + (random() < 0.1 ? '\n' : ' ')
  return text.slice(0, length)
}

function grow(document, bytes) {
  const history = document.history
  let seq = Math.max(0, ...history.map(record => record.__meta?.seq || 0))
  let size = Buffer.byteLength(JSON.stringify(document))
  while (size < bytes) {
    const call = 'call-' + seq
    const records = [
      { role: 'model', parts: [{ functionCall: { id: call, name: 'exec', args: { command: 'npm test' } } }], __meta: { seq: ++seq, timestamp: Date.now() } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: call, name: 'exec', response: { output: prose(32 * 1024) } } }], __meta: { seq: ++seq, timestamp: Date.now() } },
    ]
    history.push(...records)
    size += Buffer.byteLength(JSON.stringify(records)) + 2
  }
  return size
}

function timed(file, argv, environment) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(file, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', peak = 0
    const sample = setInterval(() => {
      try {
        const match = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))
        if (match) peak = Math.max(peak, Number(match[1]))
      } catch {}
    }, 100)
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('close', code => {
      clearInterval(sample)
      resolve({ code, stdout, stderr, ms: Date.now() - started, peakRssMiB: Math.round(peak / 1024) })
    })
  })
}

try {
  await env.setup()
  const source = await env.fileModeSource()
  await mock(env).script('large', [])
  const api = apiClient(source.url, source.token)
  await installModels(api, env.modelBaseUrl)
  await api.post('/api/sessions', { agentId: 'main', sessionId: 'large' })
  await api.post('/api/sessions/large/message', { text: 'DRILL:large One turn before growing the document.', clientMessageId: 'large-1' })
  await until(async () => texts((await history(api, 'large')) || { messages: [] }).includes('FINAL:large:0'), 'the file-mode turn completes', 60000)
  await source.stop()
  const sessions = join(source.dataRoot, 'state', 'sessions')
  const file = readdirSync(sessions).find(name => name.startsWith('large') && name.endsWith('.json'))
  const original = readFileSync(join(sessions, file), 'utf8')
  for (const mib of sizes) {
    const copy = join(env.root, `source-${mib}`)
    cpSync(source.dataRoot, copy, { recursive: true })
    const document = JSON.parse(original)
    const bytes = grow(document, mib * 1024 * 1024)
    writeFileSync(join(copy, 'state', 'sessions', file), JSON.stringify(document))
    const tenant = `large${mib}`
    const report = join(env.root, `import-${tenant}.json`)
    const run = await timed(env.binary, ['hosted', 'import', '--data-root', copy, '--tenant', tenant, '--report', report, '--deployment-config', env.deployment('r1')], env.replicaEnv('r1'))
    const imported = run.code === 0 ? JSON.parse(readFileSync(report, 'utf8')) : null
    const sessionPhase = run.stdout.split('\n').find(line => /session documents/i.test(line))?.trim()
    const [[segments, stored]] = await env.sql(`SELECT count(*), coalesce(sum(pg_column_size(s.records)), 0) FROM session_segments s JOIN tenants t USING (tenant_id) WHERE t.name = '${tenant}'`)
    const row = {
      documentMiB: +(bytes / 1048576).toFixed(1),
      historyRecords: document.history.length,
      exit: run.code,
      importSeconds: +(run.ms / 1000).toFixed(1),
      sessionPhase,
      peakRssMiB: run.peakRssMiB,
      segments: Number(segments),
      storedMiB: +(Number(stored) / 1048576).toFixed(1),
      verified: imported ? imported.verificationFailures.length === 0 : false,
      error: run.code === 0 ? undefined : (run.stderr + run.stdout).slice(-2000),
    }
    results.sizes.push(row)
    log('import', JSON.stringify(row))
  }
  // Statements PostgreSQL logged (at or above --log-ms), slowest first.
  const slow = readFileSync(join(env.root, 'logs', 'postgres.log'), 'utf8')
    .split('\n')
    .map(line => /duration: ([\d.]+) ms\s+(?:statement|execute [^:]*): (.{0,120})/.exec(line))
    .filter(Boolean)
    .map(match => ({ ms: Number(match[1]), statement: match[2] }))
    .sort((a, b) => b.ms - a.ms)
  results.loggedStatements = slow.length
  results.slowestStatements = slow.slice(0, 8)
  const [[timeout]] = await env.sql("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'")
  results.serverStatementTimeout = timeout
} finally {
  await env.teardown()
}
console.log(JSON.stringify(results, null, 2))
const report = option('--report')
if (report) writeFileSync(report, JSON.stringify(results, null, 2) + '\n')
