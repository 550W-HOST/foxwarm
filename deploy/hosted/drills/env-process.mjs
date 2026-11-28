// The process environment of the hosted drills: PostgreSQL from a local prefix, VersityGW, the
// mock model and the replicas as local processes of a Foxwarm build. Each replica reaches the
// database through its own partitionable proxy, and the public entry is a round-robin proxy.
// Replicas share one deployment configuration except for the bind address: each listens on its
// own loopback address with the same ports, as containers do on their own IPs.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { partitionableProxy, roundRobinProxy, freePort } from './net.mjs'
import { until, sleep, getJson } from './util.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

export async function processEnvironment(options = {}) {
  const binary = options.binary || process.env.FOXWARM_DRILL_BINARY || join(repo, 'dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm')
  const pgPrefix = process.env.FOXWARM_TEST_PG_PREFIX
  const versitygw = process.env.FOXWARM_TEST_VERSITYGW
  if (!existsSync(binary)) throw new Error('No Foxwarm build at ' + binary + ' (set FOXWARM_DRILL_BINARY).')
  if (!pgPrefix) throw new Error('FOXWARM_TEST_PG_PREFIX names the PostgreSQL prefix.')
  if (!versitygw) throw new Error('FOXWARM_TEST_VERSITYGW names the VersityGW binary.')
  const root = mkdtempSync('/tmp/fwdrill-')
  const children = []
  const secret = () => randomBytes(18).toString('hex')
  const pgBin = join(pgPrefix, 'usr/lib/postgresql/18/bin')
  const pgLib = join(pgPrefix, 'usr/lib/x86_64-linux-gnu')
  const pgEnv = { ...process.env, LD_LIBRARY_PATH: pgLib, LC_ALL: 'C.UTF-8' }
  const pgPort = await freePort()
  const superPassword = secret(), ownerPassword = secret(), appPassword = secret(), operatorPassword = secret()
  const publicPort = await freePort(), healthPort = await freePort(), meshPort = await freePort()
  const slots = ['r1', 'r2', 'r3']
  const address = slot => `127.0.0.${11 + slots.indexOf(slot)}`
  const replicas = new Map()
  const routes = new Map()
  let front, mock, mockPort, s3Port

  const run = (file, args, env = pgEnv) => {
    const result = spawnSync(file, args, { env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
    return result.stdout
  }
  const background = (name, file, args, env) => {
    const log = createWriteStream(join(root, 'logs', name + '.log'), { flags: 'a' })
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    children.push(child)
    return child
  }

  const environment = {
    name: 'process',
    masterAgents: join(root, 'master'),
    root,
    binary,
    slots,
    tenant: 'default',
    get publicUrl() {
      return `http://127.0.0.1:${front.port}`
    },
    get mockUrl() {
      return `http://127.0.0.1:${mockPort}`
    },
    get modelBaseUrl() {
      return `http://127.0.0.1:${mockPort}`
    },

    async setup() {
      mkdirSync(join(root, 'logs'))
      // PostgreSQL 18 with SCRAM on loopback TCP; the drills connect as the superuser for checks.
      writeFileSync(join(root, 'pw'), superPassword)
      run(join(pgBin, 'initdb'), ['-D', join(root, 'pg'), '-U', 'postgres', '--auth=scram-sha-256', '--pwfile=' + join(root, 'pw'), '-E', 'UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C.UTF-8'])
      rmSync(join(root, 'pw'))
      run(join(pgBin, 'pg_ctl'), ['-D', join(root, 'pg'), '-l', join(root, 'logs', 'postgres.log'), '-w', '-t', '60', '-o', `-p ${pgPort} -k ${root} -c listen_addresses=127.0.0.1 -c max_connections=200 ${options.postgresOptions || ''}`, 'start'])
      environment.psql([`CREATE ROLE foxwarm_owner LOGIN PASSWORD '${ownerPassword}'`, `CREATE ROLE foxwarm_app LOGIN NOBYPASSRLS PASSWORD '${appPassword}'`, `CREATE ROLE foxwarm_operator LOGIN NOBYPASSRLS PASSWORD '${operatorPassword}'`, 'CREATE DATABASE foxwarm OWNER foxwarm_owner'], 'postgres')
      // VersityGW with a POSIX backend; a bucket is a directory.
      mkdirSync(join(root, 's3', 'foxwarm'), { recursive: true })
      s3Port = await freePort()
      writeFileSync(join(root, 's3-access'), 'drill' + secret().slice(0, 8))
      writeFileSync(join(root, 's3-secret'), secret())
      writeFileSync(join(root, 'mesh-secret'), randomBytes(32).toString('base64'))
      mkdirSync(join(root,'iam'))
      background('versitygw', versitygw, ['--port', `127.0.0.1:${s3Port}`, '--iam-dir', join(root,'iam'), 'posix', join(root, 's3')], {
        ...process.env,
        ROOT_ACCESS_KEY_ID: readFileSync(join(root, 's3-access'), 'utf8'),
        ROOT_SECRET_ACCESS_KEY: readFileSync(join(root, 's3-secret'), 'utf8'),
      })
      // The key-encryption key, in the instance key file format.
      writeFileSync(join(root, 'kek.json'), JSON.stringify({ version: 1, keyId: randomBytes(8).toString('hex'), key: randomBytes(32).toString('base64') }))
      mockPort = await freePort()
      background('mock-llm', process.execPath, [join(here, 'mock-llm.mjs'), '--port', String(mockPort), '--host', '127.0.0.1'], process.env)
      await until(() => getJson(environment.mockUrl + '/__drill/requests').catch(() => null), 'the mock model listens', 10000)
      front = await roundRobinProxy(() => slots.filter(slot => replicas.get(slot)?.running).map(slot => ({ host: address(slot), port: publicPort })))
      const migrate = await environment.cli(['db', 'migrate'])
      if (migrate.code !== 0) throw new Error('db migrate failed: ' + migrate.stderr + migrate.stdout)
      // Qualify the same restricted operator identity used in the Compose stack. The
      // operator stays up for Agent-file inventory, including while replica boots move.
      const operatorSecrets = join(root, 'operator-secrets')
      mkdirSync(operatorSecrets, { mode: 0o700 })
      for (const [name, value] of Object.entries({
        's3-access-key-id': readFileSync(join(root, 's3-access')),
        's3-secret-access-key': readFileSync(join(root, 's3-secret')),
        'operator-s3-access-key-id': 'foxwarm-operator-delete', 'operator-s3-secret-access-key': secret(),
      })) writeFileSync(join(operatorSecrets,name),value,{ mode: 0o600 })
      run('sh', [join(here,'../operator-s3.sh')], {...process.env, SECRETS_DIR: operatorSecrets,
        POLICY_FILE: join(here,'../operator-s3-policy.json'), S3_ENDPOINT: `http://127.0.0.1:${s3Port}` })
      const operatorPort = await freePort()
      const operatorConfig = join(root,'deployment-operator.yaml')
      const operatorHost = '127.0.0.32'
      const base = readFileSync(environment.deployment('r1'),'utf8')
        .replace(`httpHost: ${address('r1')}`,`httpHost: ${operatorHost}`)
        .replace(join(root,'s3-access'),join(operatorSecrets,'operator-s3-access-key-id'))
        .replace(join(root,'s3-secret'),join(operatorSecrets,'operator-s3-secret-access-key'))
      writeFileSync(operatorConfig, base + `url: 'http://{slug}.test'\noperator: {url: 'http://${operatorHost}:${operatorPort}', port: ${operatorPort}}\n`)
      const operatorEnvironment = environment.replicaEnv('r1')
      delete operatorEnvironment.FOXWARM_MIGRATE_DATABASE_URL
      const operator = background('operator',binary,['operator','serve'], {...operatorEnvironment,
        FOXWARM_DATABASE_URL: `postgres://foxwarm_operator:${operatorPassword}@127.0.0.1:${pgPort}/foxwarm`,
        FOXWARM_DEPLOYMENT_CONFIG: operatorConfig, FOXWARM_ROLE: 'operator' })
      await until(async () => {
        if (operator.exitCode !== null) throw new Error(`Operator exited ${operator.exitCode}`)
        return (await fetch(`http://${operatorHost}:${operatorPort}/operator/v1/tenants`)).status === 401
      }, 'the operator serves with its scoped credentials',10000)
      return migrate
    },

    psql(sql, database = 'foxwarm') {
      const statements = (Array.isArray(sql) ? sql : [sql]).flatMap(statement => ['-c', statement])
      return run(join(pgBin, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', '-d', database, ...statements], { ...pgEnv, PGPASSWORD: superPassword })
    },

    async sql(sql) {
      return environment.psql(sql).split('\n').filter(line => line.length > 0).map(line => line.split('\t'))
    },

    deployment(slot, master = false) {
      const path = join(root, `deployment-${master ? 'master' : slot}.yaml`)
      writeFileSync(path, [
        `mesh: {port: ${meshPort}}`,
        'bot:',
        `  httpHost: ${master ? '127.0.0.31' : address(slot)}`,
        `  httpPort: ${publicPort}`,
        'health:',
        `  port: ${healthPort}`,
        'blobs:',
        '  backend: s3',
        '  s3:',
        `    endpoint: http://127.0.0.1:${s3Port}`,
        '    region: us-east-1',
        '    bucket: foxwarm',
        '    pathStyle: true',
        `    accessKeyIdFile: ${join(root, 's3-access')}`,
        `    secretAccessKeyFile: ${join(root, 's3-secret')}`,
        // The mock model listens on loopback, which hosted tenants can't reach by default.
        'egress:',
        '  allow:',
        "    hosted: ['127.0.0.1']",
        '',
      ].join('\n'))
      return path
    },

    replicaEnv(slot, databasePort = pgPort) {
      const scratch = join(root, 'scratch', `${slot}-${Date.now()}`)
      mkdirSync(join(scratch, '.temp'), { recursive: true })
      return {
        PATH: process.env.PATH,
        DOTNET_ROOT: process.env.DOTNET_ROOT || '/opt/dotnet',
        HOME: join(root, 'home'),
        FOXWARM_MODE: 'hosted',
        FOXWARM_TENANT: environment.tenant,
        FOXWARM_DATABASE_URL: `postgres://foxwarm_app:${appPassword}@127.0.0.1:${databasePort}/foxwarm`,
        FOXWARM_MIGRATE_DATABASE_URL: `postgres://foxwarm_owner:${ownerPassword}@127.0.0.1:${pgPort}/foxwarm`,
        FOXWARM_KEK_FILE: join(root, 'kek.json'),
        FOXWARM_SCRATCH_DIR: scratch,
        FOXWARM_DEPLOYMENT_CONFIG: environment.deployment(slot),
        FOXWARM_REPLICA_ID: slot,
        FOXWARM_MESH_SECRET_FILE: join(root, 'mesh-secret'),
        FOXWARM_ADVERTISE_ADDRESS: `${address(slot)}:${meshPort}`,
        TMPDIR: join(scratch, '.temp'),
      }
    },

    async cli(args, extra = {}) {
      const env = { ...environment.replicaEnv('r1'), ...extra }
      return await new Promise(resolve => {
        const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => (stdout += chunk))
        child.stderr.on('data', chunk => (stderr += chunk))
        child.on('close', code => resolve({ code, stdout, stderr }))
      })
    },

    token: ({ tenant } = {}) => environment.cli(['hosted', 'token', ...(tenant ? ['--tenant', tenant] : [])]),

    async dumpData() {
      return run(join(pgBin, 'pg_dump'), ['--data-only', '-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', 'foxwarm'], { ...pgEnv, PGPASSWORD: superPassword })
    },

    /** A file-mode installation of the same build, served on its own port until stopped. */
    async fileModeSource() {
      const data = join(root, 'source')
      mkdirSync(join(data, 'state'), { recursive: true })
      const port = await freePort()
      writeFileSync(join(data, 'state', 'config.yaml'), `bot:\n  httpHost: 127.0.0.1\n  httpPort: ${port}\n`)
      const env = { PATH: process.env.PATH, DOTNET_ROOT: process.env.DOTNET_ROOT || '/opt/dotnet', HOME: join(root, 'home'), FOXWARM_DATA_DIR: data, TMPDIR: process.env.TMPDIR || '/tmp' }
      const child = background('file-mode', binary, [], env)
      const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
      const url = `http://127.0.0.1:${port}`
      const token = await until(async () => {
        if (!existsSync(join(data, 'state', 'token'))) return null
        const value = readFileSync(join(data, 'state', 'token'), 'utf8').trim()
        return (await fetch(url + '/health', { headers: { authorization: 'Bearer ' + value } }).catch(() => null))?.ok ? value : null
      }, 'the file-mode Main serves', 90000)
      return {
        dataRoot: data,
        url,
        token,
        async stop() {
          child.kill('SIGTERM')
          const code = await exited
          if (code !== 0) throw new Error('file-mode Main exited ' + code)
        },
      }
    },

    async importSource(source, tenant) {
      const result = await environment.cli(['hosted', 'import', '--data-root', source.dataRoot, '--tenant', tenant, '--report', join(root, `import-${tenant}.json`), '--deployment-config', environment.deployment('r1')])
      return { ...result, reportPath: join(root, `import-${tenant}.json`) }
    },

    async startMaster() {
      const host = '127.0.0.31'
      const deployment = environment.deployment('r1', true)
      mkdirSync(environment.masterAgents, { recursive: true })
      const child = background('master-host', binary, [], {
        ...environment.replicaEnv('r1'), FOXWARM_ROLE: 'master-host',
        FOXWARM_REPLICA_ID: 'foxwarm-master', FOXWARM_ADVERTISE_ADDRESS: `${host}:${meshPort}`,
        FOXWARM_MESH_SECRET_FILE: join(root, 'mesh-secret'),
        FOXWARM_AGENTS_DIR: environment.masterAgents, FOXWARM_SCRATCH_DIR: join(root, 'master', 'scratch'),
        FOXWARM_DEPLOYMENT_CONFIG: deployment,
      })
      const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
      return { url: `http://${host}:${publicPort}`, stop: async () => {
        child.kill('SIGTERM')
        if (await exited !== 0) throw new Error('master-host exited uncleanly')
      } }
    },

    async start(slot, { version = 'N' } = {}) {
      if (replicas.get(slot)?.running) throw new Error(slot + ' is running')
      let route = routes.get(slot)
      if (!route) routes.set(slot, (route = await partitionableProxy({ host: '127.0.0.1', port: pgPort })))
      const env = environment.replicaEnv(slot, route.port)
      const child = background(slot, binary, [], env)
      const entry = { child, running: true, version, exit: null, started: Date.now() }
      entry.exited = new Promise(resolve =>
        child.on('exit', (code, signal) => {
          entry.running = false
          entry.exit = { code, signal, at: Date.now() }
          resolve(entry.exit)
        })
      )
      replicas.set(slot, entry)
      return entry
    },

    running: slot => Boolean(replicas.get(slot)?.running),
    version: slot => replicas.get(slot)?.version,

    async kill(slot) {
      replicas.get(slot)?.child.kill('SIGKILL')
      return await replicas.get(slot)?.exited
    },

    async terminate(slot) {
      replicas.get(slot)?.child.kill('SIGTERM')
    },

    async waitExit(slot, timeout) {
      const entry = replicas.get(slot)
      const result = await Promise.race([entry.exited, sleep(timeout).then(() => null)])
      if (!result) throw new Error(`${slot} didn't exit within ${timeout} ms`)
      return result
    },

    async status(slot) {
      if (!replicas.get(slot)?.running) return null
      return await getJson(`http://${address(slot)}:${healthPort}/status`, 1500).catch(() => null)
    },

    async partition(slot) {
      routes.get(slot).cut()
    },

    async heal(slot) {
      routes.get(slot).heal()
    },

    logs(slot) {
      return readFileSync(join(root, 'logs', slot + '.log'), 'utf8')
    },

    async teardown({ keep = false } = {}) {
      for (const entry of replicas.values()) if (entry.running) entry.child.kill('SIGKILL')
      for (const route of routes.values()) await route.close()
      await front?.close()
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      spawnSync(join(pgBin, 'pg_ctl'), ['-D', join(root, 'pg'), 'stop', '-m', 'immediate'], { env: pgEnv })
      if (!keep) rmSync(root, { recursive: true, force: true })
    },
  }
  return environment
}
