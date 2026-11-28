#!/usr/bin/env node
// Runs the hosted drills against local processes (`--env process`, the default) or against the
// Compose stack (`--env compose`, see compose.drill.yaml).
//
//   node deploy/hosted/drills/run.mjs [--env process|compose]
//        [--drills smoke,partition,rolling,fence,import,master] [--report <file>] [--keep]
//
// Process environment: FOXWARM_TEST_PG_PREFIX, FOXWARM_TEST_VERSITYGW and a Foxwarm build
// (FOXWARM_DRILL_BINARY, default the managed Debug build). Compose environment: a Docker
// daemon, the hosted image in FOXWARM_HOSTED_IMAGE and its N+1 tag in FOXWARM_HOSTED_NEXT_IMAGE.
import { writeFileSync } from 'node:fs'
import { processEnvironment } from './env-process.mjs'
import { composeEnvironment } from './env-compose.mjs'
import * as drills from './drills.mjs'
import {masterHost} from './master.mjs'
import { log, assert } from './util.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const selected = option('--drills', 'smoke,partition,rolling,fence,import').split(',')
const kind = option('--env', 'process')
const env = kind === 'compose' ? await composeEnvironment() : await processEnvironment()
const results = { environment: kind, started: new Date().toISOString(), drills: {} }
const order = [
  ['smoke', drills.smoke],
  ['partition', drills.partition],
  ['fence', drills.upgradeFence],
  ['rolling', drills.rolling],
  ['import', drills.importSeed],
  ['master', masterHost],
]
let failed = false
let monitor
try {
  const migrate = await env.setup()
  log('setup: migrated', migrate.stdout.trim().split('\n').at(-1))
  const owner = await drills.startTenantPool(env)
  log(`setup: ${owner.replica} owns tenant ${env.tenant} at epoch ${owner.epoch}`)
  const context = await drills.login(env)
  await drills.installModels(context.api, env.modelBaseUrl)
  log('setup: logged in with `foxwarm hosted token`; models installed through Setup')
  if (env.containerChecks) {
    results.container = await env.containerChecks()
    log('container: replicas healthy (HEALTHCHECK /livez), uid 1000, read-only root, writable scratch', JSON.stringify(results.container))
  }
  monitor = drills.ownershipMonitor(env)
  for (const [name, drill] of order) {
    if (!selected.includes(name)) continue
    const started = Date.now()
    log(`=== drill ${name}`)
    results.drills[name] = { ...(await drill(env, context)), durationMs: Date.now() - started, outcome: 'passed' }
    log(`=== drill ${name} passed`, JSON.stringify(results.drills[name]))
  }
  await monitor.stop()
  results.ownership = { samples: monitor.samples, violations: monitor.violations }
  assert(monitor.violations.length === 0, 'one owner at a time: ' + JSON.stringify(monitor.violations))
  log(`ownership: ${monitor.samples} samples: active epochs never went backwards or switched boots without an increment`)
  if (env.containerDiff) {
    results.containerDiff = await env.containerDiff()
    assert(Object.values(results.containerDiff).every(list => list.length === 0), 'replica containers changed nothing outside their mounts: ' + JSON.stringify(results.containerDiff))
    log('container: docker diff of every replica is empty')
  }
} catch (error) {
  failed = true
  results.error = String(error?.stack || error)
  console.error(error)
} finally {
  await monitor?.stop()
  await env.teardown({ keep: args.includes('--keep') || failed })
  if (failed) {
    for (const slot of env.slots)
      try {
        console.error(`--- last log lines of ${slot}\n` + env.logs(slot).split('\n').slice(-60).join('\n'))
      } catch {}
    log('kept the environment for inspection:', env.root || '')
  }
}
results.outcome = failed ? 'failed' : 'passed'
const report = option('--report')
if (report) writeFileSync(report, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
process.exit(failed ? 1 : 0)
