// The Compose environment of the hosted drills: the stack of deploy/hosted/compose.yaml with
// the drill overrides (compose.drill.yaml), driven through the docker CLI. The drill runner is
// the orchestrator: it kills, stops, starts and partitions containers (a partition disconnects
// the replica from the backend network that holds PostgreSQL and the object store).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { until, sleep, getJson } from './util.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const deploy = join(here, '..')

function exec(file, args, { env = process.env, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

export async function composeEnvironment() {
  const image = process.env.FOXWARM_HOSTED_IMAGE || 'foxwarm-hosted:local'
  const nextImage = process.env.FOXWARM_HOSTED_NEXT_IMAGE || image
  const project = process.env.FOXWARM_DRILL_PROJECT || 'foxwarm-drill'
  const root = mkdtempSync('/tmp/fwdrill-compose-')
  const secrets = join(root, 'secrets')
  const publicPort = Number(process.env.FOXWARM_DRILL_PUBLIC_PORT || 13001)
  const mockPort = Number(process.env.FOXWARM_DRILL_MOCK_PORT || 18080)
  const slots = ['r1', 'r2', 'r3']
  const service = slot => (slot.startsWith('r') ? 'foxwarm-' + slot.slice(1) : slot)
  const images = {}
  const versions = new Map()
  const running = new Map()
  const addresses = new Map()
  const env = {
    ...process.env,
    FOXWARM_HOSTED_IMAGE: image,
    FOXWARM_DRILL_SECRETS: secrets,
    FOXWARM_DRILL_PUBLIC_PORT: String(publicPort),
    FOXWARM_DRILL_MOCK_PORT: String(mockPort),
  }
  const compose = (args, options = {}) =>
    exec('docker', ['compose', '-p', project, '-f', join(deploy, 'compose.yaml'), '-f', join(here, 'compose.drill.yaml'), '--profile', 'drill', ...args], { env: { ...env, ...images }, ...options })
  const must = async (args, options) => {
    const result = await compose(args, options)
    if (result.code !== 0) throw new Error(`docker compose ${args.join(' ')} failed (${result.code}): ${result.stderr}${result.stdout}`)
    return result
  }
  const container = async name => (await must(['ps', '-a', '-q', name])).stdout.trim()
  const inspect = async (name, format) => (await exec('docker', ['inspect', '-f', format, await container(name)])).stdout.trim()
  const address = async name => {
    const id = await container(name)
    if (!addresses.has(id))
      addresses.set(id, await inspect(name, `{{(index .NetworkSettings.Networks "${project}_frontend").IPAddress}}`))
    return addresses.get(id)
  }
  const psql = args => must(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'foxwarm', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args])

  const environment = {
    name: 'compose',
    masterAgents: '/master',
    root,
    slots,
    tenant: 'default',
    publicUrl: `http://127.0.0.1:${publicPort}`,
    mockUrl: `http://127.0.0.1:${mockPort}`,
    modelBaseUrl: 'http://mock-llm:8080',
    // HAProxy's check interval (1 s) plus re-resolution (1 s) and a margin.
    entrySettleMs: 3000,
    compose,

    async setup() {
      const generated = await exec('sh', [join(deploy, 'generate-secrets.sh'), secrets])
      if (generated.code !== 0) throw new Error(generated.stderr)
      await must(['up', '-d', '--wait', 'postgres', 'versitygw', 'mock-llm', 'proxy'])
      await until(() => getJson(environment.mockUrl + '/__drill/requests').catch(() => null), 'the mock model listens', 30000)
      const migrate = await must(['run', '--rm', 'migrate'])
      await must(['up', '-d', 'operator'])
      return migrate
    },

    async sql(sql) {
      const result = await psql(['-At', '-F', '\t', '-c', sql])
      return result.stdout.split('\n').filter(line => line.length > 0).map(line => line.split('\t'))
    },

    async dumpData() {
      return (await must(['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '--data-only', 'foxwarm'])).stdout
    },

    /** An operator command in the image, with the migration URL (the migrate service). */
    cli: args => compose(['run', '--rm', '--no-deps', 'migrate', ...args]),

    /** `foxwarm hosted token`, run inside a running replica, which has its environment. */
    async token({ tenant } = {}) {
      const slot = slots.find(item => running.get(item))
      return await compose(['exec', '-T', service(slot), '/app/Foxwarm', 'hosted', 'token', ...(tenant ? ['--tenant', tenant] : [])])
    },

    async startMaster() {
      await must(['up', '-d', '--no-deps', 'foxwarm-master'])
      return { url: `http://${await address('foxwarm-master')}:3001`, stop: async () => {
        await must(['stop', '-t', '30', 'foxwarm-master'])
        if (Number(await inspect('foxwarm-master', '{{.State.ExitCode}}')) !== 0) throw new Error('master-host exited uncleanly')
      } }
    },

    async start(slot, { version = 'N' } = {}) {
      const index = slot.slice(1)
      images['FOXWARM_DRILL_IMAGE_' + index] = version === 'N' ? image : nextImage
      versions.set(slot, version)
      addresses.clear() // a started container may get another address
      await must(['up', '-d', '--no-deps', service(slot)])
      running.set(slot, true)
    },

    running: slot => Boolean(running.get(slot)),
    version: slot => versions.get(slot),

    async kill(slot) {
      await must(['kill', '-s', 'SIGKILL', service(slot)])
      return await environment.waitExit(slot, 30000)
    },

    async terminate(slot) {
      await must(['kill', '-s', 'SIGTERM', service(slot)])
    },

    async waitExit(slot, timeout) {
      const state = await until(
        async () => {
          const [status, code, finished] = (await inspect(service(slot), '{{.State.Status}} {{.State.ExitCode}} {{.State.FinishedAt}}')).split(' ')
          return status === 'exited' ? { code: Number(code), at: Date.parse(finished.replace(/(\.\d{3})\d*/, '$1')) } : null
        },
        `${service(slot)} exits`,
        timeout,
        250
      )
      running.set(slot, false)
      return state
    },

    async status(slot) {
      if (!running.get(slot)) return null
      try {
        return await getJson(`http://${await address(service(slot))}:3002/status`, 1500)
      } catch {
        return null
      }
    },

    async partition(slot) {
      const result = await exec('docker', ['network', 'disconnect', `${project}_backend`, await container(service(slot))])
      if (result.code !== 0) throw new Error('network disconnect failed: ' + result.stderr)
    },

    async heal(slot) {
      const result = await exec('docker', ['network', 'connect', `${project}_backend`, await container(service(slot))])
      if (result.code !== 0) throw new Error('network connect failed: ' + result.stderr)
    },

    logs(slot) {
      return environment.lastLogs?.[slot] ?? ''
    },

    async readLogs(slot) {
      return (await compose(['logs', '--no-color', '--no-log-prefix', service(slot)])).stdout
    },

    async fileModeSource() {
      await must(['run', '--rm', '--no-deps', '--user', '0', '--entrypoint', 'sh', 'file-source', '-c',
        'mkdir -p /source/state && printf "bot:\\n  httpHost: 0.0.0.0\\n  httpPort: 3001\\n" > /source/state/config.yaml && chown -R 1000:1000 /source'])
      await must(['up', '-d', '--no-deps', 'file-source'])
      const url = `http://${await address('file-source')}:3001`
      const token = await until(async () => {
        const value = (await compose(['exec', '-T', 'file-source', 'cat', '/source/state/token'])).stdout.trim()
        return value && (await fetch(url + '/health', { headers: { authorization: 'Bearer ' + value } }).catch(() => null))?.ok ? value : null
      }, 'the file-mode Main serves', 90000)
      return {
        url,
        token,
        async stop() {
          await must(['stop', '-t', '30', 'file-source'])
          const code = Number(await inspect('file-source', '{{.State.ExitCode}}'))
          if (code !== 0) throw new Error('file-mode Main exited ' + code)
        },
      }
    },

    async importSource() {
      return await compose(['run', '--rm', '--no-deps', 'importer'])
    },

    /**
     * The image's container contract, on the running stack: both replicas (owner and standby)
     * reach Docker health `healthy` through the image's HEALTHCHECK, run as uid 1000, can't
     * write the root filesystem and can write the scratch directory.
     */
    async containerChecks() {
      const checks = {}
      for (const slot of slots.filter(item => running.get(item))) {
        const name = service(slot)
        checks[name] = { health: await until(async () => ((await inspect(name, '{{.State.Health.Status}}')) === 'healthy' ? 'healthy' : null), `${name} is healthy`, 120000, 1000) }
        const probe = await compose(['exec', '-T', name, 'sh', '-c', 'id -u; touch /app/.probe 2>/dev/null && echo root-writable; touch /scratch/.temp/probe && echo scratch-writable; rm -f /scratch/.temp/probe'])
        checks[name].probe = probe.stdout.trim().split('\n')
        if (checks[name].probe.join(',') !== '1000,scratch-writable') throw new Error(`${name}: ${probe.stdout}${probe.stderr}`)
      }
      return checks
    },

    /** `docker diff` of every replica container: a read-only root leaves nothing outside mounts. */
    async containerDiff() {
      const diff = {}
      for (const slot of slots) {
        const id = await container(service(slot)).catch(() => '')
        if (!id) continue
        // Mount points Docker creates for the secret, volume and tmpfs mounts aren't writes.
        const mounts = (await exec('docker', ['inspect', '-f', '{{range .Mounts}}{{.Destination}} {{end}}{{range $path, $_ := .HostConfig.Tmpfs}}{{$path}} {{end}}', id])).stdout.trim().split(/\s+/)
        const isMountPoint = path => mounts.some(mount => mount === path || mount.startsWith(path + '/'))
        diff[service(slot)] = (await exec('docker', ['diff', id])).stdout.trim().split('\n').filter(Boolean).filter(line => !isMountPoint(line.slice(2)))
      }
      return diff
    },

    async teardown({ keep = false } = {}) {
      environment.lastLogs = {}
      for (const slot of slots) environment.lastLogs[slot] = await environment.readLogs(slot)
      console.log((await compose(['ps', '-a'])).stdout)
      if (keep) {
        // A failed run: the other services' logs, for the CI log.
        for (const name of ['postgres', 'versitygw', 'proxy', 'mock-llm', 'file-source', 'foxwarm-master'])
          console.log(`--- logs of ${name}\n` + (await compose(['logs', '--no-color', '--tail', '60', name])).stdout)
      }
      if (!keep) {
        await compose(['down', '-v', '--remove-orphans', '-t', '30'])
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
  // Drills read replica logs synchronously; refresh them after every exit.
  const waitExit = environment.waitExit
  environment.waitExit = async (slot, timeout) => {
    const result = await waitExit(slot, timeout)
    environment.lastLogs = { ...(environment.lastLogs || {}), [slot]: await environment.readLogs(slot) }
    await sleep(0)
    return result
  }
  return environment
}
