// The hosted failover drills. Each drill runs against an environment (env-process.mjs or
// env-compose.mjs) that provides the same operations on local processes or on the Compose
// stack's containers, and states the existing contract it checks.
import { until, sleep, getJson, apiClient, probe, log, assert } from './util.mjs'

const TTL_MS = 30000 // U17: lease TTL 30 s, renew every 5 s, self-fence 20 s after the last renewal start

// ---- shared steps -------------------------------------------------------------------------

export function mock(env) {
  const post = (path, body) =>
    fetch(env.mockUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return {
    script: (key, rounds) => post('/__drill/script', { key, rounds }),
    release: key => post('/__drill/release', { key }),
    requests: async key => (await getJson(env.mockUrl + '/__drill/requests')).filter(row => row.turn && row.key === key),
  }
}

/** Health status of every running replica slot (null entries dropped). */
export async function statuses(env, slots = env.slots) {
  const list = []
  for (const slot of slots) {
    if (!env.running(slot)) continue
    const status = await env.status(slot)
    if (status) list.push({ slot, ...status })
  }
  return list
}

export async function lease(env, tenant = env.tenant) {
  const [row] = await env.sql(
    `SELECT l.owner_replica, l.epoch, l.state, round(extract(epoch FROM l.expires_at) * 1000), round(extract(epoch FROM l.acquired_at) * 1000)` +
      ` FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = '${tenant}'`
  )
  return { owner: row[0], epoch: Number(row[1]), state: row[2], expiresAt: Number(row[3]), acquiredAt: Number(row[4]) }
}

/** Waits for exactly one ready owner above `minEpoch`; returns its slot and status. */
export async function waitOwner(env, { minEpoch = 0, timeout = 120000, slots = env.slots } = {}) {
  return await until(
    async () => {
      const owners = (await statuses(env, slots)).filter(status => status.role === 'owner')
      return owners.length === 1 && owners[0].ready && owners[0].epoch > minEpoch ? owners[0] : null
    },
    `one ready owner above epoch ${minEpoch}`,
    timeout,
    250
  )
}

/**
 * Samples every running replica's role while drills run. Two replicas reporting `owner` at the
 * same time, or a lease epoch that goes down, is a violation (D-hosted-lease: one owner at a time).
 */
export function ownershipMonitor(env) {
  const violations = []
  let stopped = false
  let samples = 0
  let lastEpoch = 0
  // The replicas are read one after another, so two owners in one sample can be a handover
  // between two reads. The lease is read first: a replica that still reports owner at an older
  // epoch was read after its lease was superseded, and two owners of one epoch can't both hold it.
  const loop = (async () => {
    while (!stopped) {
      let current = null
      try {
        current = await lease(env)
        if (current.epoch < lastEpoch) violations.push({ at: Date.now(), epochWentDown: [lastEpoch, current.epoch] })
        lastEpoch = Math.max(lastEpoch, current.epoch)
      } catch {}
      const owners = (await statuses(env)).filter(status => status.role === 'owner')
      samples++
      const stale = current ? owners.filter(owner => owner.epoch < current.epoch) : []
      if (stale.length) violations.push({ at: Date.now(), leaseEpoch: current.epoch, staleOwners: stale })
      const epochs = owners.map(owner => owner.epoch)
      if (new Set(epochs).size < epochs.length) violations.push({ at: Date.now(), sameEpochOwners: owners })
      await sleep(200)
    }
  })()
  return {
    violations,
    get samples() {
      return samples
    },
    async stop() {
      stopped = true
      await loop
    },
  }
}

/** Samples the public entry every 250 ms: an authenticated request through the round-robin proxy. */
export function serviceMonitor(api) {
  const samples = []
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const at = Date.now()
      // A request may wait at a standby for the next owner during a handover, so the timeout is
      // generous; the latency is reported.
      const result = await probe(api.base + '/api/sessions', api.token, 20000)
      samples.push({ at, ms: Date.now() - at, ...result })
      await sleep(250)
    }
  })()
  return {
    samples,
    async stop() {
      stopped = true
      await loop
      let gap = 0, start = null
      for (const sample of samples) {
        if (!sample.ok && start === null) start = sample.at
        if (sample.ok && start !== null) {
          gap = Math.max(gap, sample.at - start)
          start = null
        }
      }
      if (start !== null) gap = Math.max(gap, Date.now() - start)
      const failures = {}
      for (const sample of samples.filter(item => !item.ok)) {
        const reason = sample.error || 'HTTP ' + sample.status
        failures[reason] = (failures[reason] || 0) + 1
      }
      if (process.env.FOXWARM_DRILL_TRACE) console.log(JSON.stringify(samples))
      const slowestMs = Math.max(0, ...samples.map(sample => sample.ms))
      return { requests: samples.length, failed: samples.filter(sample => !sample.ok).length, failures, longestGapMs: gap, slowestMs }
    },
  }
}

/**
 * New connections to the entry every `everyMs`, each sent without waiting for the previous one,
 * so requests start throughout a handover and not only after a held one returns.
 */
export function burst(api, everyMs = 100) {
  const pending = []
  const timer = setInterval(() => {
    const at = Date.now()
    pending.push(probe(api.base + '/api/sessions', api.token, 20000).then(result => ({ at, ms: Date.now() - at, ...result })))
  }, everyMs)
  return {
    async stop() {
      clearInterval(timer)
      return await Promise.all(pending)
    },
  }
}

/**
 * Waits until the public entry answers several requests in a row: a proxy in front of the
 * replicas takes them into rotation only after their first passing health check.
 */
export async function waitEntry(env, timeout = 60000) {
  let streak = 0
  await until(async () => {
    const result = await probe(env.publicUrl + '/', '')
    streak = result.status ? streak + 1 : 0
    return streak >= 4
  }, 'the public entry answers', timeout, 250)
}

/** Logs in through the public entry with the token `foxwarm hosted token` prints. */
export async function login(env) {
  await waitEntry(env)
  const result = await env.token()
  assert(result.code === 0, `hosted token exits 0, not ${result.code}: ${result.stderr}`)
  const token = result.stdout.trim()
  assert(/^[0-9a-f]{64}$/.test(token), 'hosted token prints the sign-in token')
  const auth = await fetch(env.publicUrl + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  assert(auth.status === 200, `POST /api/auth with the token answers 200, not ${auth.status}`)
  const wrong = await fetch(env.publicUrl + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '0'.repeat(64) }),
  })
  assert(wrong.status === 401, 'a wrong token is refused')
  return { token, api: apiClient(env.publicUrl, token) }
}

export async function installModels(api, baseUrl) {
  const yaml = `default: drill/wire\nproviders:\n  drill:\n    providerType: openai-responses\n    baseUrl: ${baseUrl}\n    models: [wire]\n`
  const saved = await api.post('/api/setup/models', { yaml })
  assert(saved.status === 200 && saved.body?.success, 'Setup saves the models document: ' + JSON.stringify(saved.body))
}

export async function history(api, id) {
  const result = await api.get(`/api/sessions/${encodeURIComponent(id)}/history`)
  return result.status === 200 ? result.body : null
}

const parts = message => message.parts || []
const resumeEvents = state =>
  state.messages.filter(message => parts(message).some(part => part.system?.includes('type="session-resumed"'))).length
const byClient = (state, clientMessageId) =>
  state.messages.filter(message => message.__meta?.clientMessageId === clientMessageId)
export const texts = state => state.messages.flatMap(message => parts(message).map(part => part.text || '')).filter(Boolean)

async function startTurn(env, api, key, rounds) {
  const model = mock(env)
  await model.script(key, rounds)
  const id = 'drill-' + key
  const created = await api.post('/api/sessions', { agentId: 'main', sessionId: id })
  assert(created.status === 200, 'Session created: ' + JSON.stringify(created.body))
  const sent = await api.post(`/api/sessions/${id}/message`, { text: `DRILL:${key} Answer once this turn reaches the model.`, clientMessageId: key + '-1' })
  assert(sent.status === 202, 'message accepted')
  await until(async () => (await model.requests(key)).length > 0, `the ${key} turn reaches the model`, 60000)
  return id
}

/** After takeover: the interrupted turn continues as after a file-mode restart. */
async function checkRestartRecovery(env, api, id, key) {
  const model = mock(env)
  // D-session-restart-recovery: the new owner's admission clears busy, queues one
  // `session-resumed` event, and ordinary processing reassesses the turn: a new model request
  // carrying the event, with the user's message once.
  const resumed = await until(
    async () => (await model.requests(key)).find(row => row.round >= 1 && row.answered),
    `the resumed ${key} turn reaches the model on the new owner`,
    90000
  )
  const state = await until(
    async () => {
      const value = await history(api, id)
      return value && !value.session.busy && texts(value).includes(`FINAL:${key}:${resumed.round}`) ? value : null
    },
    `Session ${id} is idle with the resumed answer`,
    60000
  )
  assert(resumed.resumed, 'the resumed request carries the session-resumed event')
  assert(resumed.userMessages === 1, `the resumed request has the user's message once, not ${resumed.userMessages}`)
  assert(byClient(state, key + '-1').length === 1, "the user's message is in history once")
  assert(resumeEvents(state) === 1, `one session-resumed event, not ${resumeEvents(state)}`)
  assert(!texts(state).includes(`FINAL:${key}:0`), 'the interrupted request was never answered into history')
  return { state, resumed }
}

// ---- drills -------------------------------------------------------------------------------

/**
 * Smoke: log in and run a turn against the mock model; kill the active replica mid-turn; the
 * standby takes over and the Session continues the way a file-mode Main restart continues an
 * interrupted turn (persistence-and-recovery "Restart resumes recorded work",
 * D-session-restart-recovery).
 */
export async function smoke(env, context) {
  const { api } = context
  const model = mock(env)
  await model.script('hello', [])
  await api.post('/api/sessions', { agentId: 'main', sessionId: 'drill-hello' })
  await api.post('/api/sessions/drill-hello/message', { text: 'DRILL:hello One turn.', clientMessageId: 'hello-1' })
  await until(async () => {
    const value = await history(api, 'drill-hello')
    return value && !value.session.busy && texts(value).includes('FINAL:hello:0')
  }, 'the first turn completes', 60000)
  log('smoke: login and a mock-model turn through the round-robin entry: ok')

  const id = await startTurn(env, api, 'smoke', [{ hold: true }])
  const before = await lease(env)
  const owner = await waitOwner(env)
  const killedAt = Date.now()
  await env.kill(owner.slot)
  log(`smoke: killed owner ${owner.replica} (${owner.slot}) mid-turn at epoch ${before.epoch}`)
  // The orchestrator restarts the killed replica; it comes back as a standby.
  await env.start(owner.slot)
  const next = await waitOwner(env, { minEpoch: before.epoch, timeout: TTL_MS + 90000 })
  const after = await lease(env)
  log(`smoke: ${next.replica} (${next.slot}) owns epoch ${after.epoch}, acquired ${after.acquiredAt - killedAt} ms after the kill`)
  assert(after.acquiredAt >= before.expiresAt - 50, "the takeover waited for the killed owner's lease to expire")
  const first = (await model.requests('smoke'))[0]
  assert(!first.answered, 'the interrupted request ended without an answer')
  const { resumed } = await checkRestartRecovery(env, api, id, 'smoke')
  log(`smoke: the Session continued on the new owner: resumed request round ${resumed.round}, one resume event, answer committed`)
  return { killedEpoch: before.epoch, takeoverEpoch: after.epoch, takeoverAfterKillMs: after.acquiredAt - killedAt }
}

/**
 * Partition: the owner is cut off from the database mid-turn. It fences itself and exits 75
 * before its lease expires (D-hosted-self-fence); a standby takes over only after expiry, and no
 * write of the old owner lands afterwards (D-hosted-write-fence): its answer, produced while cut
 * off, is nowhere in the tenant's data.
 */
export async function partition(env, context) {
  const { api } = context
  const model = mock(env)
  const stale = 'STALE-ANSWER-OF-A-FENCED-OWNER'
  const id = await startTurn(env, api, 'partition', [{ hold: true, text: stale }])
  const owner = await waitOwner(env)
  const cutAt = Date.now()
  await env.partition(owner.slot)
  // Read after the cut: the owner can't renew any more, so this expiry is final.
  const before = await lease(env)
  assert(before.owner === owner.replica, 'the cut-off replica holds the lease')
  // The model answers the cut-off owner, which now tries to commit that answer.
  await model.release('partition')
  const exit = await env.waitExit(owner.slot, TTL_MS + 15000)
  log(`partition: ${owner.replica} cut off at epoch ${before.epoch}; exited ${exit.code} after ${exit.at - cutAt} ms, ${before.expiresAt - exit.at} ms before its lease expiry`)
  assert(exit.code === 75, `the partitioned owner exits 75 (fenced), not ${exit.code}`)
  assert(exit.at < before.expiresAt, 'the old owner fenced itself and exited before its lease expired')
  const next = await waitOwner(env, { minEpoch: before.epoch, timeout: TTL_MS + 90000 })
  const after = await lease(env)
  assert(after.acquiredAt >= before.expiresAt - 50, 'the standby took over only after the expiry')
  log(`partition: ${next.replica} took over at epoch ${after.epoch}, ${after.acquiredAt - exit.at} ms after the old owner's exit`)
  await env.heal(owner.slot)
  await env.start(owner.slot)
  const { state } = await checkRestartRecovery(env, api, id, 'partition')
  assert(!JSON.stringify(state).includes(stale), "the fenced owner's answer isn't in the Session")
  // bytea columns (Session segments, Archive bodies) dump as hex, text columns as text.
  const dump = await env.dumpData()
  const holds = value => dump.includes(value) || dump.includes(Buffer.from(value).toString('hex'))
  assert(holds('DRILL:partition'), 'the data dump holds the turn')
  assert(holds('FINAL:partition:'), "the data dump holds the new owner's answer")
  assert(!holds(stale), "no row anywhere holds the fenced owner's answer")
  log('partition: no write of the fenced owner landed; the Session resumed on the new owner')
  return { exitCode: exit.code, exitAfterCutMs: exit.at - cutAt, exitBeforeExpiryMs: before.expiresAt - exit.at, takeoverAfterExitMs: after.acquiredAt - exit.at }
}

/**
 * Rolling update from version N to N+1 with maxSurge 1 and maxUnavailable 0, as the Helm
 * Deployment's strategy does it: start a replica of N+1, wait until it is Ready (a standby is
 * Ready, C3), stop one of N, repeat. The tenant stays served, one owner at a time; a graceful
 * stop releases the lease, so no step waits for the TTL (D-hosted-replica-lifecycle).
 */
export async function rolling(env, context, { next = 'N+1' } = {}) {
  const { api } = context
  const before = await startTurn(env, api, 'before-rollout', [])
  await until(async () => texts((await history(api, before)) || { messages: [] }).includes('FINAL:before-rollout:0'), 'a turn on N', 60000)
  const service = serviceMonitor(api)
  const handovers = []
  const old = env.slots.filter(slot => env.running(slot))
  assert(old.length === 2, 'two replicas run before the rollout')
  const free = env.slots.filter(slot => !env.running(slot))
  for (const slot of old) {
    const surge = free.shift()
    await env.start(surge, { version: next })
    await until(async () => (await env.status(surge))?.ready, `the surge replica ${surge} is ready`, 120000)
    // As an orchestrator waits for the new endpoint before stopping an old one: the proxy's
    // health check takes the Ready replica into rotation (Kubernetes adds Ready pods itself).
    if (env.entrySettleMs) await sleep(env.entrySettleMs)
    assert(env.slots.filter(item => env.running(item)).length <= 3, 'at most one replica above the desired two')
    const wasOwner = (await env.status(slot))?.role === 'owner'
    const held = await lease(env)
    const probes = wasOwner ? burst(api) : null
    const stoppedAt = Date.now()
    await env.terminate(slot)
    if (wasOwner) {
      // The last poll, by its start, that found no ready owner above the old epoch: up to then
      // the new owner's runtime wasn't serving.
      let notReadyAt = stoppedAt
      const owner = await until(
        async () => {
          const polled = Date.now()
          const owners = (await statuses(env)).filter(status => status.role === 'owner' && status.ready && status.epoch > held.epoch)
          if (owners.length === 1) return owners[0]
          notReadyAt = polled
          return null
        },
        `one ready owner above epoch ${held.epoch}`,
        60000,
        50
      )
      const after = await lease(env)
      const samples = await probes.stop()
      // Requests that started after the old owner released the lease (its host had stopped)
      // and before the new owner served: each waited at a standby or in the new owner's queue.
      const inWindow = samples.filter(sample => sample.at >= after.acquiredAt && sample.at <= notReadyAt)
      const handover = {
        from: slot,
        to: owner.slot,
        stopToAcquiredMs: after.acquiredAt - stoppedAt,
        epoch: after.epoch,
        windowMs: notReadyAt - after.acquiredAt,
        requests: samples.length,
        failed: samples.filter(sample => !sample.ok).length,
        heldRequests: inWindow.length,
        medianHeldMs: inWindow.map(sample => sample.ms).sort((x, y) => x - y)[Math.floor(inWindow.length / 2)] ?? 0,
        slowestHeldMs: Math.max(0, ...inWindow.map(sample => sample.ms)),
      }
      handovers.push(handover)
      log(`rolling: handover ${JSON.stringify(handover)}`)
      assert(after.acquiredAt - stoppedAt < TTL_MS, 'the handover took the released lease, not an expired one')
      assert(handover.failed === 0, `no request fails across the handover: ${JSON.stringify(samples.filter(sample => !sample.ok).slice(0, 5))}`)
      // heldRequests is reported, not required: a fast takeover can leave no sample in the
      // window. HostedStartupTests checks the mechanism with a gated start.
    }
    const exit = await env.waitExit(slot, 60000)
    assert(exit.code === 0, `a replica stopped for the rollout exits 0, not ${exit.code}`)
    free.push(slot)
    log(`rolling: replaced ${slot} by ${surge} (${next})${wasOwner ? ', ownership handed over' : ''}`)
  }
  await waitOwner(env)
  const served = await service.stop()
  const running = env.slots.filter(slot => env.running(slot))
  assert(running.length === 2 && running.every(slot => env.version(slot) === next), 'two replicas of N+1 run after the rollout')
  // The owner of N hands over once or twice: the lease may go to the other replica of N first.
  assert(handovers.length >= 1 && handovers.length <= 2, `one or two ownership handovers, not ${handovers.length}`)
  const turn = await startTurn(env, api, 'rolling', [])
  await until(async () => texts((await history(api, turn)) || { messages: [] }).includes('FINAL:rolling:0'), 'a turn on N+1', 60000)
  const earlier = await history(api, before)
  assert(earlier && texts(earlier).includes('FINAL:before-rollout:0'), 'a Session from before the rollout reads back')
  log(`rolling: ${served.requests} requests, ${served.failed} failed${served.failed ? ' ' + JSON.stringify(served.failures) : ''}, slowest ${served.slowestMs} ms`)
  // A standby holds a connection until an owner is reachable, and the new owner's port stays
  // open through the takeover (D-hosted-standby-endpoints): no request is lost.
  assert(served.failed === 0, `no request fails during the rollout, not ${served.failed}`)
  return { handovers, served }
}

/**
 * Upgrade fence (design §8.3, D-hosted-replica-lifecycle exit codes): a replica refuses to start
 * with 78 when the schema has a migration it doesn't know whose reader floor is above its level,
 * and when the tenant's min_reader_version is above its reader version. Running replicas keep
 * serving; `db status` reports the refusal with 78 too.
 */
export async function upgradeFence(env, context) {
  const { api } = context
  const slot = env.slots.find(item => !env.running(item))
  const [[level]] = await env.sql('SELECT max(version) FROM schema_migrations')
  const [[marked, reader]] = await env.sql(`SELECT t.min_reader_version, (SELECT max(reader_version) FROM replicas) FROM tenants t WHERE t.name = '${env.tenant}'`)
  const future = Number(level) + 10000
  await env.sql(`INSERT INTO schema_migrations (version, name, sha256, reader_floor) VALUES (${future}, 'drill_future', repeat('0', 64), ${Number(level) + 1}) RETURNING version`)
  try {
    await env.start(slot)
    const exit = await env.waitExit(slot, 60000)
    assert(exit.code === 78, `a replica refuses a newer schema with 78, not ${exit.code}`)
    assert(/schema level/i.test(env.logs(slot)), 'the refusal names the schema level')
    const status = await env.cli(['db', 'status'])
    assert(status.code === 78 && /would refuse/.test(status.stdout), '`db status` reports the refusal with 78')
    log(`upgrade fence: unknown migration with reader floor ${Number(level) + 1} > level ${level}: replica and db status exit 78`)
  } finally {
    await env.sql(`DELETE FROM schema_migrations WHERE version = ${future} RETURNING version`)
  }
  await env.sql(`UPDATE tenants SET min_reader_version = ${Number(reader) + 1} WHERE name = '${env.tenant}' RETURNING 1`)
  try {
    await env.start(slot)
    const exit = await env.waitExit(slot, 60000)
    assert(exit.code === 78, `a replica refuses a tenant marked for a newer reader with 78, not ${exit.code}`)
    assert(/requires a Foxwarm Main that reads installation level/.test(env.logs(slot)), 'the refusal names the reader level')
    log(`upgrade fence: tenant min_reader_version ${Number(reader) + 1} > reader ${reader}: replica exits 78`)
  } finally {
    await env.sql(`UPDATE tenants SET min_reader_version = ${Number(marked)} WHERE name = '${env.tenant}' RETURNING 1`)
  }
  const ok = await api.get('/api/sessions')
  assert(ok.status === 200, 'the running replicas kept serving')
  return { schemaLevel: Number(level), readerVersion: Number(reader) }
}

/**
 * Seeding by import (D-hosted-import): a stopped file-mode installation with a completed turn
 * is imported into a new tenant; a replica of that tenant serves it, and the file-mode sign-in
 * token and Session history carry over.
 */
export async function importSeed(env) {
  const source = await env.fileModeSource()
  const model = mock(env)
  await model.script('imported', [])
  const api = apiClient(source.url, source.token)
  await installModels(api, env.modelBaseUrl)
  await api.post('/api/sessions', { agentId: 'main', sessionId: 'drill-imported' })
  await api.post('/api/sessions/drill-imported/message', { text: 'DRILL:imported Before the import.', clientMessageId: 'imported-1' })
  await until(async () => texts((await history(api, 'drill-imported')) || { messages: [] }).includes('FINAL:imported:0'), 'the file-mode turn completes', 60000)
  await source.stop()
  const imported = await env.importSource(source, 'imported')
  assert(imported.code === 0, 'hosted import exits 0: ' + imported.stderr + imported.stdout)
  const replica = await env.startTenantReplica('imported', source)
  await until(async () => {
    const status = await getJson(replica.statusUrl, 1500).catch(() => null)
    return status?.role === 'owner' && status.ready
  }, 'the imported tenant is served', 120000)
  const hosted = apiClient(replica.url, source.token)
  const state = await history(hosted, 'drill-imported')
  assert(state && texts(state).includes('FINAL:imported:0'), 'the imported Session reads back with the file-mode token')
  const token = await env.token({ tenant: 'imported' })
  assert(token.stdout.trim() === source.token, '`hosted token --tenant imported` prints the imported token')
  await replica.stop()
  log('import: file-mode installation imported; its token and Session work on a hosted replica')
  return { import: imported.stdout.trim().split('\n').slice(-3) }
}
