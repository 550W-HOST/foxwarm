#!/usr/bin/env node
// The Helm chart on Kubernetes: a kind cluster with PostgreSQL and VersityGW (fixtures.yaml),
// the chart installed from values.yaml, then:
//   - the migration hook completed before the StatefulSet created any replica;
//   - the readiness and liveness probes: both replicas Ready (the standby included), none
//     restarted, /readyz and /livez answer 200;
//   - one owner and one standby; the owner pod is deleted, the standby takes over at a higher
//     epoch, the replacement pod stands by, and an ownership monitor never sees two owners.
// Requests through the Service during the takeover are counted and reported.
//
//   node deploy/hosted/kind/check.mjs [--report <file>] [--keep]
//
// Needs docker, kind, kubectl and helm on PATH, the hosted image in FOXWARM_HOSTED_IMAGE
// (default foxwarm-hosted:ci) and optionally the kind node image in KIND_NODE_IMAGE.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { until, sleep, log, assert } from '../drills/util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hosted = path.resolve(here, '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}
const cluster = 'foxwarm-ci'
const context = `kind-${cluster}`
const namespace = 'foxwarm'
const release = 'foxwarm'
const image = process.env.FOXWARM_HOSTED_IMAGE || 'foxwarm-hosted:ci'
const selector = 'app.kubernetes.io/name=foxwarm,app.kubernetes.io/component=replica'
const work = mkdtempSync(path.join(tmpdir(), 'foxwarm-kind-'))
const results = { started: new Date().toISOString(), image }

function run(command, argv, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} ${argv.slice(0, 6).join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`))
      else resolve({ code, stdout, stderr })
    })
  })
}
/** A long-running kubectl, its stdout collected as timestamped lines. */
function stream(argv) {
  const child = spawn('kubectl', ['--context', context, '-n', namespace, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  let partial = ''
  child.stdout.on('data', chunk => {
    const parts = (partial + chunk).split('\n')
    partial = parts.pop()
    for (const line of parts) lines.push({ at: Date.now(), line })
  })
  const done = new Promise(resolve => child.on('close', resolve))
  return {
    lines,
    done,
    stop() {
      child.kill()
      return done
    },
  }
}
const kubectl = (argv, options) => run('kubectl', ['--context', context, '-n', namespace, ...argv], options)
const json = async argv => JSON.parse((await kubectl([...argv, '-o', 'json'])).stdout)
const time = value => (value ? Date.parse(value) : NaN)

/**
 * GET on a pod's health port through the API server's pod proxy; null unless it answers 200.
 * Bounded: a pod whose container is gone but which is still listed leaves the proxy call to
 * its vanished address hanging for about 30 s otherwise.
 */
async function health(pod, route) {
  const result = await kubectl(['get', '--request-timeout=3s', '--raw', `/api/v1/namespaces/${namespace}/pods/${pod}:3002/proxy${route}`], { allowFailure: true })
  return result.code === 0 ? result.stdout : null
}
async function replicaPods() {
  return (await json(['get', 'pods', '-l', selector])).items
}
async function statuses() {
  const rows = []
  for (const pod of await replicaPods()) {
    // A deleted pod can still list as Running for a moment after its container exits.
    if (pod.status.phase !== 'Running' || pod.metadata.deletionTimestamp) continue
    const text = await health(pod.metadata.name, '/status')
    if (!text) continue
    try {
      rows.push({ pod: pod.metadata.name, ...JSON.parse(text) })
    } catch {}
  }
  return rows
}
async function psql(sql) {
  const { stdout } = await kubectl(['exec', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', 'foxwarm', '-tAc', sql])
  return stdout.trim()
}
async function lease() {
  const row = await psql("SELECT l.owner_replica, l.epoch, l.state FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = 'default'")
  const [owner, epoch, state] = row.split('|')
  return { owner, epoch: Number(epoch), state }
}

/** Samples every replica's role; two owners at once, or an owner epoch going down, is a violation. */
function ownershipMonitor() {
  const violations = []
  let samples = 0
  let lastEpoch = 0
  let stopped = false
  const loop = (async () => {
    // Pods are read one after another, so the lease is read first (as in the drills): an owner
    // at an older epoch than it was read after its lease was superseded.
    while (!stopped) {
      const current = await lease().catch(() => null)
      if (current && current.epoch < lastEpoch) violations.push({ at: Date.now(), epochWentDown: [lastEpoch, current.epoch] })
      if (current) lastEpoch = Math.max(lastEpoch, current.epoch)
      samples++
      await sleep(250)
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

/**
 * Requests through the Service from inside the cluster, one new connection every 250 ms for
 * `seconds`. The PostgreSQL image has no HTTP client, so the request is written with bash's
 * /dev/tcp and the status line read back.
 */
async function serviceProbe(token, seconds) {
  const count = Math.round(seconds * 4)
  const request = `GET /api/sessions HTTP/1.1\\r\\nHost: default.test\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n`
  const script = [
    `for i in $(seq ${count}); do`,
    '  started=$(date +%s%3N)',
    `  line=$(timeout 20 bash -c 'exec 3<>/dev/tcp/${release}/3001 && printf "${request}" "$0" >&3 && head -n1 <&3' "$TOKEN" 2>&1 | tr -d '\\r')`,
    '  echo "$started $(( $(date +%s%3N) - started )) ${line:-no response}"',
    '  sleep 0.25',
    'done',
  ].join('\n')
  const { stdout } = await kubectl(['exec', 'deploy/postgres', '--', 'env', `TOKEN=${token}`, 'bash', '-c', script])
  const rows = stdout.trim().split('\n').map(line => {
    const [at, ms, ...rest] = line.split(' ')
    return { at: Number(at), ms: Number(ms), line: rest.join(' ') }
  })
  const failed = rows.filter(row => !/^HTTP\/1\.1 200/.test(row.line))
  return { requests: rows.length, failed: failed.length, failures: failed.map(row => row.line).slice(0, 10), slowestMs: Math.max(0, ...rows.map(row => row.ms)) }
}

async function diagnose() {
  for (const argv of [['get', 'all,pvc,events', '-o', 'wide'], ['describe', 'pods']])
    console.error((await kubectl(argv, { allowFailure: true })).stdout)
  for (const pod of (await json(['get', 'pods']).catch(() => ({ items: [] }))).items)
    console.error(`--- logs of ${pod.metadata.name}\n` + (await kubectl(['logs', pod.metadata.name, '--all-containers', '--tail', '80'], { allowFailure: true })).stdout)
}

let failed = false
try {
  // ---- cluster, image and fixtures
  const nodeImage = process.env.KIND_NODE_IMAGE
  await run('kind', ['create', 'cluster', '--name', cluster, '--wait', '180s', ...(nodeImage ? ['--image', nodeImage] : [])])
  await run('kind', ['load', 'docker-image', image, '--name', cluster])
  await run('kubectl', ['--context', context, 'create', 'namespace', namespace])
  const secrets = path.join(work, 'secrets')
  await run('sh', [path.join(hosted, 'generate-secrets.sh'), secrets])
  const file = name => path.join(secrets, name)
  await kubectl(['create', 'secret', 'generic', 'fixture-secrets', ...['postgres-password', 'owner-password', 'app-password', 'operator-password', 's3-access-key-id', 's3-secret-access-key', 'operator-s3-access-key-id', 'operator-s3-secret-access-key'].map(name => `--from-file=${name}=${file(name)}`)])
  await kubectl(['create', 'secret', 'generic', 'foxwarm-mesh', `--from-file=mesh-secret=${file('mesh-secret')}`])
  await kubectl(['create', 'secret', 'generic', 'foxwarm-operator',
    `--from-file=database-url=${file('operator-database-url')}`, `--from-file=kek.json=${file('kek.json')}`,
    `--from-file=s3-access-key-id=${file('operator-s3-access-key-id')}`, `--from-file=s3-secret-access-key=${file('operator-s3-secret-access-key')}`])
  await kubectl(['create', 'configmap', 'operator-s3-setup', ...['operator-s3.sh','operator-s3-policy.json'].map(name=>`--from-file=${path.join(hosted,name)}`)])
  await kubectl(['create', 'configmap', 'postgres-init', `--from-file=${path.join(hosted, 'postgres-init', '10-foxwarm-roles.sh')}`])
  await kubectl(['apply', '-f', path.join(here, 'fixtures.yaml')])
  await kubectl(['rollout', 'status', 'deploy/postgres', '--timeout', '240s'])
  await kubectl(['rollout', 'status', 'deploy/versitygw', '--timeout', '240s'])
  await kubectl(['exec','deploy/postgres','--','sh','-c',
    `export OPERATOR_PASSWORD="$(cat /run/secrets/operator-password)"; psql -X -U postgres -d foxwarm -v ON_ERROR_STOP=1 <<'SQL'
\\getenv op_password OPERATOR_PASSWORD
ALTER ROLE foxwarm_operator LOGIN PASSWORD :'op_password';
SQL`])
  await kubectl(['wait','--for=condition=complete','job/operator-s3-setup','--timeout=120s'])
  log('kind: PostgreSQL and VersityGW ready; operator login and bucket permissions installed')

  // ---- install
  const split = image.lastIndexOf(':')
  const installStarted = Date.now()
  await run('helm', [
    '--kube-context', context, 'install', release, path.join(hosted, 'helm', 'foxwarm'), '-n', namespace,
    '-f', path.join(here, 'values.yaml'),
    '--set', `image.repository=${image.slice(0, split)}`, '--set', `image.tag=${image.slice(split + 1)}`,
    '--set-file', `secrets.databaseUrl=${file('database-url')}`,
    '--set-file', `secrets.kek=${file('kek.json')}`,
    '--set-file', `secrets.s3AccessKeyId=${file('s3-access-key-id')}`,
    '--set-file', `secrets.s3SecretAccessKey=${file('s3-secret-access-key')}`,
    '--set-file', `migrate.databaseUrl=${file('migrate-database-url')}`,
    '--wait', '--timeout', '5m',
  ])
  results.installMs = Date.now() - installStarted
  log(`helm: installed in ${results.installMs} ms`)

  // ---- the migration hook ran before the replicas
  const events = (await json(['get', 'events'])).items
  const at = event => time(event.lastTimestamp || event.eventTime || event.firstTimestamp)
  const completed = events.find(event => event.involvedObject.kind === 'Job' && event.involvedObject.name === `${release}-migrate` && event.reason === 'Completed')
  assert(completed, 'the migration Job ran and completed')
  // A StatefulSet creates its ordinal pods directly. Event times have one-second precision.
  const created = events.filter(event => event.involvedObject.kind === 'StatefulSet' && event.involvedObject.name === release && event.reason === 'SuccessfulCreate')
  assert(created.length > 0, 'the StatefulSet created replicas')
  const replicas = await json(['get', 'statefulset', release])
  assert(time(replicas.metadata.creationTimestamp) >= Math.floor(at(completed) / 1000) * 1000, 'the StatefulSet was created after the migration hook completed')
  const firstReplica = Math.min(...created.map(at))
  assert(at(completed) <= firstReplica, 'the migration hook completed before the first replica was created')
  const hook = await kubectl(['get', 'job', `${release}-migrate`, '--ignore-not-found', '-o', 'name'])
  assert(hook.stdout.trim() === '', 'the succeeded hook Job was deleted')
  const migrations = Number(await psql('SELECT count(*) FROM schema_migrations'))
  assert(migrations > 0, 'the schema is migrated')
  results.migration = { completedAt: new Date(at(completed)).toISOString(), firstReplicaAt: new Date(firstReplica).toISOString(), migrations }
  log(`hook: migration completed ${results.migration.completedAt}, first replica created ${results.migration.firstReplicaAt}`)

  // Seed a fixture tenant and activate it through the public Service. Health describes the
  // boot; the tenant lease identifies the owner and its epoch.
  await psql(`WITH t AS (INSERT INTO tenants(name) VALUES ('default') RETURNING tenant_id)
    INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM t;
    INSERT INTO tenant_hostnames(tenant_id,hostname,kind) SELECT tenant_id,'default.test','primary' FROM tenants WHERE name='default'`)
  await serviceProbe('',1)
  const roles = await until(async () => {
    const rows = await statuses(), grant = await lease()
    const owner = rows.find(row => row.replica === grant.owner && row.ready && row.tenants === 1)
    const peer = rows.find(row => row.replica !== grant.owner && row.ready)
    return owner && peer ? {owner,peer} : null
  }, 'both replicas ready with one published tenant',120000,500)
  const pods = await replicaPods()
  assert(pods.length === 2, 'two replica pods')
  for (const pod of pods) {
    const name = pod.metadata.name
    const container = pod.spec.containers[0]
    assert(container.readinessProbe?.httpGet?.path === '/readyz' && container.readinessProbe.httpGet.port === 'health', 'readiness probes /readyz on the health port')
    assert(container.livenessProbe?.httpGet?.path === '/livez' && container.livenessProbe.httpGet.port === 'health', 'liveness probes /livez on the health port')
    await until(async () => (await json(['get', 'pod', name])).status.conditions.some(condition => condition.type === 'Ready' && condition.status === 'True'), `${name} is Ready`, 60000, 500)
    assert(pod.status.containerStatuses.every(status => status.restartCount === 0), `${name} never restarted (no failed start or liveness kill)`)
    assert((await health(name, '/readyz')) !== null, `${name} answers /readyz with 200`)
    assert((await health(name, '/livez')) !== null, `${name} answers /livez with 200`)
  }
  const originalPodUid = pods.find(pod => pod.metadata.name === roles.owner.pod).metadata.uid
  const before = await lease()
  assert(before.owner === roles.owner.replica, 'the lease names the owner pod')
  log(`probes: ${roles.owner.pod} owns at epoch ${before.epoch}, ${roles.peer.pod} stands by; both Ready, no restarts`)

  // ---- takeover after the owner pod is deleted
  const token = (await kubectl(['exec', roles.owner.pod, '--', '/app/Foxwarm', 'hosted', 'token'])).stdout.trim()
  assert(token.length > 0, '`hosted token` prints the sign-in token')
  const monitor = ownershipMonitor()
  const probing = serviceProbe(token, 30)
  // Evidence of the old owner's stop: its log with timestamps, its container's termination, and
  // the lease row.
  const ownerLog = stream(['logs', '-f', '--timestamps', roles.owner.pod])
  const ownerWatch = stream([
    'get', 'pod', roles.owner.pod, '--watch', '--output-watch-events',
    '-o', 'jsonpath={.type} {.object.status.containerStatuses[0].state.terminated.exitCode} {.object.status.containerStatuses[0].state.terminated.reason} {.object.status.containerStatuses[0].state.terminated.finishedAt}{"\\n"}',
  ])
  const leaseSamples = []
  let sampling = true
  const leaseLoop = (async () => {
    while (sampling) {
      const row = await lease().catch(() => null)
      const last = leaseSamples.at(-1)
      if (row && (!last || last.state !== row.state || last.epoch !== row.epoch)) leaseSamples.push({ at: Date.now(), ...row })
      await sleep(200)
    }
  })()
  await sleep(3000)
  const deletedAt = Date.now()
  await kubectl(['delete', 'pod', roles.owner.pod, '--wait=false'])
  const next = await until(async () => {
    const grant = await lease()
    const owner = (await statuses()).find(row => row.replica === grant.owner && row.ready && row.tenants === 1)
    return owner && owner.pod !== roles.owner.pod && grant.epoch > before.epoch ? {...owner,epoch:grant.epoch} : null
  }, 'the standby owns the tenant at a higher epoch', 90000, 250)
  const takeoverMs = Date.now() - deletedAt
  assert(next.pod === roles.peer.pod, 'the standby took over')
  await until(async () => !(await replicaPods()).some(pod => pod.metadata.uid === originalPodUid), 'the deleted pod UID is gone', 90000, 500)
  const replacement = await until(async () => {
    const rows = await statuses()
    const replaced = rows.find(row => row.ready && row.pod === roles.owner.pod && row.replica !== roles.owner.replica)
    return rows.length === 2 ? replaced : null
  }, 'the replacement pod stands by', 120000, 500)
  const served = await probing
  await monitor.stop()
  sampling = false
  await leaseLoop
  await Promise.race([ownerLog.done, sleep(5000)])
  await ownerLog.stop()
  await ownerWatch.stop()
  const relative = at => at - deletedAt
  const stop = {
    lease: leaseSamples.map(sample => ({ afterDeleteMs: relative(sample.at), state: sample.state, epoch: sample.epoch, owner: sample.owner })),
    termination: ownerWatch.lines.map(entry => ({ afterDeleteMs: relative(entry.at), event: entry.line.trim() })),
    log: ownerLog.lines.map(entry => entry.line),
  }
  results.ownerStop = stop
  console.log('--- the deleted owner\'s log\n' + stop.log.join('\n'))
  log('lease during the stop: ' + JSON.stringify(stop.lease))
  log('termination of the deleted owner: ' + JSON.stringify(stop.termination))
  const after = await lease()
  assert(after.epoch === next.epoch && after.owner === next.replica && after.state === 'active', 'the lease names the new owner at its epoch')
  assert(monitor.violations.length === 0, 'one owner at a time: ' + JSON.stringify(monitor.violations))
  // A deleted owner stops gracefully: it drains, releases the lease and exits 0, and a surviving pod
  // takes the released lease well before the TTL (30 s) could expire it.
  const terminated = stop.termination.map(entry => entry.event.split(' ')).find(fields => /^\d+$/.test(fields[1] ?? ''))
  assert(terminated, 'the deleted owner\'s container termination was observed')
  assert(terminated[1] === '0', `the deleted owner exited 0, not ${terminated[1]} (${terminated[2]})`)
  // A release immediately reacquired need not survive a monitoring sample: takeover before
  // the original TTL and the retiring process's confirmed exit are the independent evidence.
  assert(takeoverMs < 15000, `the standby took over ${takeoverMs} ms after the deletion, not well before the 30 s TTL`)
  results.takeover = { from: roles.owner.pod, to: next.pod, epochs: [before.epoch, after.epoch], takeoverMs, replacement: replacement.pod, ownershipSamples: monitor.samples, served }
  log(`takeover: ${next.pod} owns at epoch ${after.epoch} ${takeoverMs} ms after the owner pod was deleted; ${replacement.pod} is ready; ${monitor.samples} samples, monotonic tenant epochs`)
  log(`service: ${served.requests} requests during the takeover, ${served.failed} failed${served.failed ? ' ' + JSON.stringify(served.failures) : ''}, slowest ${served.slowestMs} ms`)
} catch (error) {
  failed = true
  results.error = String(error?.stack || error)
  console.error(error)
  await diagnose().catch(() => {})
} finally {
  if (!args.includes('--keep')) await run('kind', ['delete', 'cluster', '--name', cluster], { allowFailure: true })
  rmSync(work, { recursive: true, force: true })
}
results.outcome = failed ? 'failed' : 'passed'
const report = option('--report')
if (report) writeFileSync(report, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
process.exit(failed ? 1 : 0)
