#!/usr/bin/env node
// Measures MultiXact consumption from the tenant lease row (plan §13): every write transaction
// locks the lease row FOR KEY SHARE, and the owner's renewal updates it every 5 s. Two lockers
// at once, or a renewal while a writer holds its lock, make PostgreSQL create a MultiXact.
// Runs one owner and one standby on local processes and drives concurrent Sessions through
// complete turns against the mock model at several concurrency levels.
//
//   node deploy/hosted/drills/measure-multixact.mjs [--levels 1,4,16] [--seconds 45] [--report <file>]
import { writeFileSync } from 'node:fs'
import { processEnvironment } from './env-process.mjs'
import { waitOwner, login, installModels, history, texts } from './drills.mjs'
import { log, sleep, until } from './util.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const levels = option('--levels', '1,4,16').split(',').map(Number)
const seconds = Number(option('--seconds', '45'))
const env = await processEnvironment()
const results = { seconds, levels: [] }

async function counters() {
  await env.sql('CHECKPOINT')
  const [[multixact, offset]] = await env.sql('SELECT next_multixact_id, next_multi_offset FROM pg_control_checkpoint()')
  const [[commits]] = await env.sql("SELECT xact_commit FROM pg_stat_database WHERE datname = 'foxwarm'")
  // Transactions that were assigned an ID: the writers (and writes of other databases, none here).
  const [[xid]] = await env.sql('SELECT pg_snapshot_xmax(pg_current_snapshot())')
  const [[updates]] = await env.sql("SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'tenant_leases'")
  return { multixact: Number(multixact), offset: Number(offset), commits: Number(commits), writes: Number(xid), leaseUpdates: Number(updates), at: Date.now() }
}

try {
  await env.setup()
  await env.start('r1')
  await env.start('r2')
  await waitOwner(env)
  const { api } = await login(env)
  await installModels(api, env.modelBaseUrl)
  for (const level of levels) {
    const ids = []
    for (let index = 0; index < level; index++) {
      const id = `mx-${level}-${index}`
      await api.post('/api/sessions', { agentId: 'main', sessionId: id })
      ids.push(id)
    }
    const before = await counters()
    const deadline = Date.now() + seconds * 1000
    let turns = 0
    await Promise.all(
      ids.map(async id => {
        let round = 0
        while (Date.now() < deadline) {
          const key = `${id}-${round}`
          await api.post(`/api/sessions/${id}/message`, { text: `DRILL:${key} measure`, clientMessageId: key })
          await until(async () => {
            const state = await history(api, id)
            return state && !state.session.busy && texts(state).some(text => text.startsWith(`FINAL:${key}:`))
          }, `turn ${key}`, 60000, 50)
          turns++
          round++
        }
      })
    )
    const after = await counters()
    const elapsed = (after.at - before.at) / 1000
    const multixacts = after.multixact - before.multixact
    const commits = after.commits - before.commits
    const writes = after.writes - before.writes
    const row = {
      concurrentSessions: level,
      seconds: Math.round(elapsed),
      turns,
      commits,
      commitsPerSecond: +(commits / elapsed).toFixed(1),
      writeTransactions: writes,
      writesPerSecond: +(writes / elapsed).toFixed(1),
      multixacts,
      multixactsPerSecond: +(multixacts / elapsed).toFixed(2),
      multixactsPerWrite: writes ? +(multixacts / writes).toFixed(4) : 0,
      memberOffsets: after.offset - before.offset,
      leaseUpdates: after.leaseUpdates - before.leaseUpdates,
      // autovacuum_multixact_freeze_max_age defaults to 400 million: at this rate, every table
      // gets an anti-wraparound vacuum this often.
      daysToFreezeMaxAge: multixacts ? +((400e6 / (multixacts / elapsed)) / 86400).toFixed(0) : null,
      // Member space: aggressive autovacuum starts at about half of the 2^32 member offsets.
      daysToMemberThreshold: after.offset > before.offset ? +((2 ** 31 / ((after.offset - before.offset) / elapsed)) / 86400).toFixed(0) : null,
    }
    results.levels.push(row)
    log('multixact', JSON.stringify(row))
    await sleep(1000)
  }
  const [[age]] = await env.sql("SELECT mxid_age(datminmxid) FROM pg_database WHERE datname = 'foxwarm'")
  results.databaseMxidAge = Number(age)
  const [[slru]] = await env.sql("SELECT json_agg(json_build_object('name', name, 'zeroed', blks_zeroed, 'written', blks_written)) FROM pg_stat_slru WHERE name ILIKE '%multi%'")
  results.slru = JSON.parse(slru)
} finally {
  await env.teardown()
}
console.log(JSON.stringify(results, null, 2))
const report = option('--report')
if (report) writeFileSync(report, JSON.stringify(results, null, 2) + '\n')
